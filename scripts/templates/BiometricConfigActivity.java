package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;

public class BiometricConfigActivity extends Activity {

    private static final String BASE_URL = "https://acp-chat-beta.onrender.com";
    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri data = getIntent().getData();
        boolean enabled = false;
        int relockSeconds = 120;
        String callbackPath = "/account.html?_account_subscreen=privacy";

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

            String cb = data.getQueryParameter("callback_path");
            if (cb != null && cb.startsWith("/")) {
                callbackPath = cb;
            }
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit()
                .putBoolean(KEY_BIO_ENABLED, enabled)
                .putInt(KEY_BIO_RELOCK_SECONDS, relockSeconds)
                .apply();

        Uri callbackUri = Uri.parse(BASE_URL + callbackPath).buildUpon()
                .appendQueryParameter("_android_bio_config", "1")
                .build();

        Intent intent = new Intent(Intent.ACTION_VIEW, callbackUri);
        intent.setClass(this, LauncherActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }
}
