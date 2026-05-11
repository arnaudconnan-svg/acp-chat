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

import java.util.concurrent.Executor;

public class GateActivity extends FragmentActivity {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_TEST_PIN_MODE = "test_pin_mode";
    private static final String KEY_TEST_PIN_AUTO_ACCEPT = "test_pin_auto_accept";
    private static final int REQUEST_CODE_TEST_PIN = 9001;

    private boolean gateInFlight = false;
    private boolean launchDispatched = false;
    private BiometricPrompt nativeGatePrompt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);

        // Keep screen on when test PIN mode is active (for easier testing)
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            Log.d("Facilitat.GateActivity", "test pin mode detected: keeping screen on");
        }
    }

    @Override
    protected void onResume() {
        super.onResume();

        if (launchDispatched || gateInFlight) {
            return;
        }

        if (shouldRequireNativeGate()) {
            openNativeBiometricGate();
            return;
        }

        launchTwa();
    }

    private void openNativeBiometricGate() {
        if (gateInFlight) {
            return;
        }

        gateInFlight = true;

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            if (prefs.getBoolean(KEY_TEST_PIN_AUTO_ACCEPT, false)) {
                Log.d("Facilitat", "test pin mode auto-accept enabled in GateActivity");
                gateInFlight = false;
                setResult(Activity.RESULT_OK);

                if (!isTaskRoot()) {
                    launchDispatched = true;
                    finish();
                    overridePendingTransition(0, 0);
                    return;
                }

                launchTwa();
                return;
            }

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
            failClosedToHome();
            return;
        }

        Executor executor = ContextCompat.getMainExecutor(this);
        nativeGatePrompt = new BiometricPrompt(this, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                Log.d("Facilitat", "native-bio success (GateActivity)");
                gateInFlight = false;
                setResult(Activity.RESULT_OK);

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
                setResult(Activity.RESULT_OK);

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
        if (!prefs.getBoolean(KEY_BIO_ENABLED, false)) {
            Log.d("Facilitat", "native-bio policy: disabled");
            return false;
        }
        Log.d("Facilitat", "native-bio policy: enabled");
        return true;
    }
}
