package io.facilitat.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

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

        setContentView(createGateView());
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

    private FrameLayout createGateView() {
        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        root.setBackgroundColor(Color.parseColor("#F4F9F9"));

        ImageView logoView = new ImageView(this);
        logoView.setImageResource(resolveGateLogoResId());
        logoView.setAdjustViewBounds(true);
        logoView.setScaleType(ImageView.ScaleType.FIT_CENTER);

        int maxWidth = Math.min(dpToPx(220), Math.round(getResources().getDisplayMetrics().widthPixels * 0.62f));
        int topMargin = Math.round(getResources().getDisplayMetrics().heightPixels * 0.16f);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            maxWidth,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.topMargin = topMargin;
        logoView.setLayoutParams(params);

        root.addView(logoView);
        return root;
    }

    private int resolveGateLogoResId() {
        int resourceId = getResources().getIdentifier("gate_logo", "drawable", getPackageName());
        return resourceId != 0 ? resourceId : R.mipmap.ic_launcher;
    }

    private int dpToPx(int dp) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            dp,
            getResources().getDisplayMetrics()
        ));
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

        next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(next);
        finish();
    }
}
