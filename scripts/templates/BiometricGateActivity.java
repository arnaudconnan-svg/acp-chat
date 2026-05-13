package io.facilitat.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import java.util.Set;

public class BiometricGateActivity extends FragmentActivity {
    private static final String PREFS_NAME = "facilitat_native_biometrics";
    private static final String PREF_BIOMETRIC_ENABLED = "biometric_enabled";

    private static boolean hasUnlockedInProcess = false;
    private boolean forwarded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent incoming = getIntent();
        if (handleBiometricConfigIntent(incoming)) {
            finish();
            return;
        }

        if (!shouldRequireBiometric(incoming)) {
            forwardToLauncher(incoming);
            return;
        }

        requestBiometricThenForward(incoming);
    }

    private boolean handleBiometricConfigIntent(Intent incoming) {
        if (incoming == null) return false;
        if (!Intent.ACTION_VIEW.equals(incoming.getAction())) return false;

        Uri data = incoming.getData();
        if (data == null) return false;
        if (!"facilitat".equalsIgnoreCase(data.getScheme())) return false;
        if (!"biometric-config".equalsIgnoreCase(data.getHost())) return false;

        String enabled = data.getQueryParameter("enabled");
        boolean value = "1".equals(enabled)
            || "true".equalsIgnoreCase(enabled)
            || "on".equalsIgnoreCase(enabled);

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putBoolean(PREF_BIOMETRIC_ENABLED, value).apply();
        return true;
    }

    private boolean shouldRequireBiometric(Intent incoming) {
        if (!isBiometricEnabledByUser()) {
            return false;
        }

        if (hasUnlockedInProcess) {
            return false;
        }

        if (incoming == null) {
            return false;
        }

        String action = incoming.getAction();
        int flags = incoming.getFlags();
        if ((flags & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
            return false;
        }

        if ((flags & Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT) != 0) {
            return false;
        }

        return true;
    }

    private boolean isBiometricEnabledByUser() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(PREF_BIOMETRIC_ENABLED, false);
    }

    private void requestBiometricThenForward(Intent incoming) {
        BiometricManager manager = BiometricManager.from(this);
        int canAuth = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            forwardToLauncher(incoming);
            return;
        }

        BiometricPrompt prompt = new BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    hasUnlockedInProcess = true;
                    forwardToLauncher(incoming);
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    finish();
                }
            }
        );

        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Validation biométrique")
            .setSubtitle("Confirmer l'accès à Facilitat.io")
            .setNegativeButtonText("Annuler")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .build();

        prompt.authenticate(info);
    }

    private void forwardToLauncher(Intent incoming) {
        if (forwarded) return;
        forwarded = true;

        Intent next = new Intent(this, LauncherActivity.class);
        boolean hasUsableData = false;

        if (incoming != null) {
            Uri data = incoming.getData();
            if (data != null && String.valueOf(data).trim().length() > 0) {
                hasUsableData = true;
                next.setAction(Intent.ACTION_VIEW);
                next.setData(data);
            }

            Bundle extras = incoming.getExtras();
            if (extras != null) {
                next.putExtras(extras);
            }
        }

        if (!hasUsableData) {
            next.setAction(Intent.ACTION_MAIN);
            next.addCategory(Intent.CATEGORY_LAUNCHER);
        }

        next.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(next);
        finish();
    }
}
