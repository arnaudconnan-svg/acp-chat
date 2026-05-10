package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.concurrent.Executor;

public class BiometricActivity extends FragmentActivity {

    private static final String BASE_URL = "https://acp-chat-beta.onrender.com";

    private String callbackPath = "/";
    private String bioNonce = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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

        BiometricManager biometricManager = BiometricManager.from(this);
        int canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.DEVICE_CREDENTIAL);

        if (canAuthenticate != BiometricManager.BIOMETRIC_SUCCESS) {
            returnResult(false);
            return;
        }

        Executor executor = ContextCompat.getMainExecutor(this);

        BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                returnResult(true);
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                returnResult(false);
            }

            @Override
            public void onAuthenticationFailed() {
                // User touched sensor but not recognized — let them retry, do not return yet.
            }
        };

        BiometricPrompt prompt = new BiometricPrompt(this, executor, callback);

        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Facilitat.io")
                .setSubtitle("Vérification requise")
                .setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG |
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build();

        prompt.authenticate(promptInfo);
    }

    private void returnResult(boolean success) {
        Uri.Builder uriBuilder = Uri.parse(BASE_URL + callbackPath).buildUpon()
                .appendQueryParameter("_biometric_result", success ? "success" : "failed");
        if (!bioNonce.isEmpty()) {
            uriBuilder.appendQueryParameter("_bio_nonce", bioNonce);
        }
        Uri resultUri = uriBuilder.build();

        Intent intent = new Intent(Intent.ACTION_VIEW, resultUri);
        intent.setClass(this, LauncherActivity.class);
        // Reuse existing launcher task instead of recreating app task (prevents full restart splash).
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivity(intent);
        overridePendingTransition(0, 0);
        finish();
        overridePendingTransition(0, 0);
    }
}
