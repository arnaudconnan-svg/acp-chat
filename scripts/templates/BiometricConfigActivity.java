package io.facilitat.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;

public class BiometricConfigActivity extends Activity {
    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri data = getIntent().getData();
        boolean enabled = false;
        int relockSeconds = 120;

        if (data != null) {
            String enabledParam = data.getQueryParameter("enabled");
            enabled = "1".equals(enabledParam) || "true".equalsIgnoreCase(enabledParam);

            String relockParam = data.getQueryParameter("relock");
            try {
                int parsed = Integer.parseInt(String.valueOf(relockParam));
                if (parsed == 0 || parsed == 30 || parsed == 120 || parsed == 300) {
                    relockSeconds = parsed;
                }
            } catch (Exception ignored) {
            }
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit()
                .putBoolean(KEY_BIO_ENABLED, enabled)
                .putInt(KEY_BIO_RELOCK_SECONDS, relockSeconds)
            .putLong(KEY_BIO_LAST_UNLOCK_MS, enabled ? 0L : 0L)
                .apply();

        finish();
    }
}
