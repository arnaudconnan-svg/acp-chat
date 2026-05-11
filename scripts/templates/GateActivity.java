package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.Set;
import java.util.concurrent.Executor;

public class GateActivity extends FragmentActivity {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";
    private static final String KEY_NATIVE_GATE_STARTED_MS = "native_gate_started_ms";
    private static final String KEY_TEST_PIN_MODE = "test_pin_mode";
    private static final String EXTRA_NATIVE_GATE = "nativeGate";
    private static final String EXTRA_FORCE_NATIVE_GATE = "forceNativeGate";
    private static final String EXTRA_NATIVE_GATE_PASSED = "nativeBioPassed";
    private static final int REQUEST_CODE_TEST_PIN = 9001;

    private boolean gateInFlight = false;
    private boolean launchDispatched = false;
    private boolean isStateRestore = false;
    private BiometricPrompt nativeGatePrompt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        isStateRestore = (savedInstanceState != null);

        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    protected void onResume() {
        super.onResume();

        if (launchDispatched && isLauncherEntryIntent()) {
            // OEM launchers may redeliver launcher intents to an existing Gate instance.
            launchDispatched = false;
        }

        if (launchDispatched || gateInFlight) {
            return;
        }

        if (isStateRestore) {
            Log.d("Facilitat", "GateActivity resumed from state restore; checking if relock is needed");
            isStateRestore = false;
        }

        if (shouldRequireNativeGate()) {
            openNativeBiometricGate();
            return;
        }

        launchTwa();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (gateInFlight) {
            Log.d("Facilitat", "GateActivity.onNewIntent ignored while native gate in-flight");
            return;
        }

        setIntent(intent);

        launchDispatched = false;
        gateInFlight = false;
        Log.d("Facilitat", "GateActivity.onNewIntent -> reset dispatch state");
    }

    private void openNativeBiometricGate() {
        if (gateInFlight) {
            return;
        }

        gateInFlight = true;
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putLong(KEY_NATIVE_GATE_STARTED_MS, System.currentTimeMillis())
            .apply();

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            Log.d("Facilitat", "test pin mode enabled -> launching TestPinActivity");
            Intent testPinIntent = new Intent(this, TestPinActivity.class);
            startActivityForResult(testPinIntent, REQUEST_CODE_TEST_PIN);
            return;
        }

        BiometricManager biometricManager = BiometricManager.from(this);
        int canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);

        if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
            Log.d("Facilitat", "native-bio unavailable in GateActivity");
            gateInFlight = false;
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .remove(KEY_NATIVE_GATE_STARTED_MS)
                    .apply();
            failClosedToHome();
            return;
        }

        Executor executor = ContextCompat.getMainExecutor(this);
        nativeGatePrompt = new BiometricPrompt(this, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                Log.d("Facilitat", "native-bio success (GateActivity)");
                gateInFlight = false;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .edit()
                        .remove(KEY_NATIVE_GATE_STARTED_MS)
                        .putLong(KEY_BIO_LAST_UNLOCK_MS, System.currentTimeMillis())
                        .putBoolean(Application.KEY_BIO_JUST_UNLOCKED, true)
                        .apply();

                if (!isTaskRoot()) {
                    launchDispatched = true;
                    finish();
                    overridePendingTransition(0, 0);
                    return;
                }

                launchTwa();
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                Log.d("Facilitat", "native-bio error (GateActivity)=" + errorCode + " " + errString);
                gateInFlight = false;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .edit()
                        .remove(KEY_NATIVE_GATE_STARTED_MS)
                        .apply();
                failClosedToHome();
            }

            @Override
            public void onAuthenticationFailed() {
                Log.d("Facilitat", "native-bio failed attempt (GateActivity)");
            }
        });

        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Facilitat.io")
                .setSubtitle("Verification requise")
                .setConfirmationRequired(true)
                .setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG
                                | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build();

        nativeGatePrompt.authenticate(promptInfo);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQUEST_CODE_TEST_PIN) {
            if (resultCode == RESULT_OK && data != null && data.getBooleanExtra("test_pin_accepted", false)) {
                Log.d("Facilitat", "test pin accepted in GateActivity");
                gateInFlight = false;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .edit()
                        .remove(KEY_NATIVE_GATE_STARTED_MS)
                        .putLong(KEY_BIO_LAST_UNLOCK_MS, System.currentTimeMillis())
                        .putBoolean(Application.KEY_BIO_JUST_UNLOCKED, true)
                        .apply();

                if (!isTaskRoot()) {
                    launchDispatched = true;
                    finish();
                    overridePendingTransition(0, 0);
                    return;
                }

                launchTwa();
            } else {
                Log.d("Facilitat", "test pin rejected/cancelled");
                gateInFlight = false;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                        .edit()
                        .remove(KEY_NATIVE_GATE_STARTED_MS)
                        .apply();
                failClosedToHome();
            }
        }
    }

    private void launchTwa() {
        launchDispatched = true;
        Intent sourceIntent = getIntent();
        Intent launchIntent = new Intent(this, LauncherActivity.class);
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION);

        if (sourceIntent != null && sourceIntent.getData() != null) {
            launchIntent.setAction(Intent.ACTION_VIEW);
            launchIntent.setData(sourceIntent.getData());
        } else {
            launchIntent.setAction(Intent.ACTION_MAIN);
            launchIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        }

        startActivity(launchIntent);
        overridePendingTransition(0, 0);
        finish();
    }

    private void failClosedToHome() {
        launchDispatched = true;
        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);

        try {
            finishAffinity();
            finishAndRemoveTask();
        } catch (Exception ignored) {
            finish();
        }
    }

    private boolean shouldRequireNativeGate() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        boolean enabled = prefs.getBoolean(KEY_BIO_ENABLED, false);
        if (!enabled) {
            Log.d("Facilitat", "native-bio policy: disabled");
            return false;
        }

        if (isForcedRelockIntent()) {
            Log.d("Facilitat", "native-bio policy: require auth (app leave / Recents)");
            return true;
        }

        if (isLauncherEntryIntent()) {
            Log.d("Facilitat", "native-bio policy: require auth (launcher entry)");
            return true;
        }

        int relockSeconds = prefs.getInt(KEY_BIO_RELOCK_SECONDS, 120);
        if (relockSeconds != 0 && relockSeconds != 30 && relockSeconds != 120 && relockSeconds != 300) {
            relockSeconds = 120;
        }

        long lastUnlockMs = prefs.getLong(KEY_BIO_LAST_UNLOCK_MS, 0L);
        if (lastUnlockMs <= 0L) {
            Log.d("Facilitat", "native-bio policy: require auth (no unlock timestamp)");
            return true;
        }

        if (relockSeconds == 0) {
            Log.d("Facilitat", "native-bio policy: require auth (relock=0)");
            return true;
        }

        long elapsed = System.currentTimeMillis() - lastUnlockMs;
        boolean shouldRequireAuth = elapsed >= relockSeconds * 1000L;
        Log.d(
                "Facilitat",
                "native-bio policy: enabled, relockSeconds=" + relockSeconds
                        + ", elapsedMs=" + elapsed
                        + ", requireAuth=" + shouldRequireAuth
        );
        return shouldRequireAuth;
    }

    private boolean isForcedRelockIntent() {
        Intent intent = getIntent();
        boolean result = intent != null && intent.getBooleanExtra(EXTRA_FORCE_NATIVE_GATE, false);
        Log.d("Facilitat.GateActivity", "isForcedRelockIntent=" + result);
        return result;
    }

    private boolean isLauncherEntryIntent() {
        Intent intent = getIntent();
        if (intent == null) {
            return false;
        }
        if (!Intent.ACTION_MAIN.equals(intent.getAction())) {
            return false;
        }

        if (intent.hasCategory(Intent.CATEGORY_LAUNCHER)
                || intent.hasCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)) {
            return true;
        }

        Set<String> categories = intent.getCategories();
        return (categories == null || categories.isEmpty())
                && intent.getData() == null
                && intent.getType() == null;
    }
}
