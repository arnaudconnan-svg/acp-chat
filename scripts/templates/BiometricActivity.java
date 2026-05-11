package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.concurrent.Executor;

public class BiometricActivity extends FragmentActivity {

    private static final String BASE_URL = "https://acp-chat-beta.onrender.com";
    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";
    private static final String KEY_TEST_PIN_MODE = "test_pin_mode";
    private static final String KEY_TEST_PIN_AUTO_ACCEPT = "test_pin_auto_accept";
    private static final String EXTRA_NATIVE_GATE = "nativeGate";
    private static final int REQUEST_CODE_TEST_PIN = 9002;

    private String callbackPath = "/";
    private String bioNonce = "";
    private boolean launchedFromNativeGate = false;
    private boolean nativeGateResultSent = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on when test PIN mode is active (for easier testing)
        SharedPreferences testPrefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (testPrefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            Log.d("Facilitat.BiometricActivity", "test pin mode detected: keeping screen on");
        }

        launchedFromNativeGate = getIntent() != null && getIntent().getBooleanExtra(EXTRA_NATIVE_GATE, false);

        Log.d("Facilitat", "BiometricActivity.onCreate launchedFromNativeGate=" + launchedFromNativeGate);

        if (launchedFromNativeGate) {
            startNativePrompt();
            return;
        }

        Uri data = getIntent().getData();
        if (data != null) {
            String cb = data.getQueryParameter("callback_path");
            if (cb != null && (cb.startsWith("/") || cb.isEmpty())) {
                callbackPath = cb.isEmpty() ? "/" : cb;
            }
            String nonce = data.getQueryParameter("_bio_nonce");
            if (nonce != null) {
                bioNonce = nonce;
            }
        }

        // Web-only callback mode (account flow)
        Uri.Builder uriBuilder = Uri.parse(BASE_URL + callbackPath).buildUpon()
                .appendQueryParameter("_biometric_result", "web_only");
        if (!bioNonce.isEmpty()) {
            uriBuilder.appendQueryParameter("_bio_nonce", bioNonce);
        }
        Uri resultUri = uriBuilder.build();

        Intent intent = new Intent(Intent.ACTION_VIEW, resultUri);
        intent.setClass(this, LauncherActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivity(intent);
        overridePendingTransition(0, 0);
        finish();
    }

    private void startNativePrompt() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_TEST_PIN_MODE, false)) {
            if (prefs.getBoolean(KEY_TEST_PIN_AUTO_ACCEPT, false)) {
                Log.d("Facilitat", "test pin mode auto-accept enabled in BiometricActivity");
                returnNativeGateResult(true);
                return;
            }

            Log.d("Facilitat", "test pin mode enabled -> launching TestPinActivity from BiometricActivity");
            Intent testPinIntent = new Intent(this, TestPinActivity.class);
            startActivityForResult(testPinIntent, REQUEST_CODE_TEST_PIN);
            return;
        }

        BiometricManager biometricManager = BiometricManager.from(this);
        int canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG
                        | BiometricManager.Authenticators.DEVICE_CREDENTIAL);

        if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
            Log.d("Facilitat", "native-bio unavailable, send HOME");
            returnNativeGateResult(false);
            return;
        }

        Executor executor = ContextCompat.getMainExecutor(this);
        BiometricPrompt prompt = new BiometricPrompt(this, executor, new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                Log.d("Facilitat", "native-bio success");
                returnNativeGateResult(true);
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                Log.d("Facilitat", "native-bio error=" + errorCode + " " + errString);
                returnNativeGateResult(false);
            }

            @Override
            public void onAuthenticationFailed() {
                Log.d("Facilitat", "native-bio failed attempt");
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

        prompt.authenticate(promptInfo);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQUEST_CODE_TEST_PIN) {
            if (resultCode == RESULT_OK && data != null && data.getBooleanExtra("test_pin_accepted", false)) {
                Log.d("Facilitat", "test pin accepted in BiometricActivity");
                returnNativeGateResult(true);
            } else {
                Log.d("Facilitat", "test pin rejected/cancelled in BiometricActivity");
                returnNativeGateResult(false);
            }
        }
    }

    private void returnNativeGateResult(boolean success) {
        nativeGateResultSent = true;
        if (!success) {
            Intent homeIntent = new Intent(Intent.ACTION_MAIN);
            homeIntent.addCategory(Intent.CATEGORY_HOME);
            homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(homeIntent);
            setResult(Activity.RESULT_CANCELED);
            try {
                finishAffinity();
            } catch (Exception ignored) {
            }
            finish();
            overridePendingTransition(0, 0);
            return;
        }

        if (launchedFromNativeGate) {
            setResult(Activity.RESULT_OK);
            finish();
            overridePendingTransition(0, 0);
            return;
        }

        Intent result = new Intent();
        result.putExtra("nativeBioPassed", true);
        setResult(Activity.RESULT_OK, result);
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Some devices dismiss biometric without callback; fail closed deterministically.
        if (!launchedFromNativeGate || nativeGateResultSent) {
            return;
        }

        nativeGateResultSent = true;
        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
        setResult(Activity.RESULT_CANCELED);
        finish();
    }
}
