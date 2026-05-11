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
    private static final String KEY_TEST_PIN_MODE = "test_pin_mode";
    private static final String KEY_TEST_PIN_AUTO_ACCEPT = "test_pin_auto_accept";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri data = getIntent().getData();
        boolean enabled = false;
        int relockSeconds = 120;
        boolean testPinMode = false;
        boolean testPinAutoAccept = false;

        String enabledExtra = getIntent().getStringExtra("enabled");
        if (enabledExtra != null) {
            enabled = "1".equals(enabledExtra) || "true".equalsIgnoreCase(enabledExtra);
        }
        if (getIntent().hasExtra("relock")) {
            int relockExtra = getIntent().getIntExtra("relock", relockSeconds);
            if (relockExtra == 0 || relockExtra == 30 || relockExtra == 120 || relockExtra == 300) {
                relockSeconds = relockExtra;
            }
        }
        String testPinExtra = getIntent().getStringExtra("test_pin_mode");
        if (testPinExtra != null) {
            testPinMode = "1".equals(testPinExtra) || "true".equalsIgnoreCase(testPinExtra);
        }
        String testPinAutoExtra = getIntent().getStringExtra("test_pin_auto_accept");
        if (testPinAutoExtra != null) {
            testPinAutoAccept = "1".equals(testPinAutoExtra) || "true".equalsIgnoreCase(testPinAutoExtra);
        }

        if (data != null) {
            String enabledParam = data.getQueryParameter("enabled");
            enabled = "1".equals(enabledParam) || "true".equalsIgnoreCase(enabledParam);

            String testPinParam = data.getQueryParameter("test_pin_mode");
            testPinMode = "1".equals(testPinParam) || "true".equalsIgnoreCase(testPinParam);
            String testPinAutoParam = data.getQueryParameter("test_pin_auto_accept");
            testPinAutoAccept = "1".equals(testPinAutoParam) || "true".equalsIgnoreCase(testPinAutoParam);

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
                .putBoolean(KEY_TEST_PIN_MODE, testPinMode)
                .putBoolean(KEY_TEST_PIN_AUTO_ACCEPT, testPinAutoAccept)
                .putInt(KEY_BIO_RELOCK_SECONDS, relockSeconds)
                .putLong(KEY_BIO_LAST_UNLOCK_MS, 0L)
                .apply();

        finish();
    }
}
