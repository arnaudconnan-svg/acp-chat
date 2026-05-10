package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;

public class SnapshotPreferenceActivity extends Activity {

    private static final String PRIVACY_PREFS = "facilitat_privacy";
    private static final String SCREEN_CAPTURE_ENABLED_KEY = "screen_capture_enabled";
    private String callbackPath = "/account.html";
    private String returnSubscreen = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        boolean enabled = false;
        Uri data = getIntent().getData();
        if (data != null) {
            enabled = "1".equals(data.getQueryParameter("enabled"))
                    || "true".equalsIgnoreCase(data.getQueryParameter("enabled"));
            String cb = data.getQueryParameter("callback_path");
            if ("/account.html".equals(cb)) {
                callbackPath = cb;
            }
            String requestedSubscreen = data.getQueryParameter("return_subscreen");
            if ("privacy".equals(requestedSubscreen)) {
                returnSubscreen = requestedSubscreen;
            }
        }

        getSharedPreferences(PRIVACY_PREFS, MODE_PRIVATE)
                .edit()
                .putBoolean(SCREEN_CAPTURE_ENABLED_KEY, enabled)
                .apply();

        Uri.Builder builder = Uri.parse("https://acp-chat-beta.onrender.com" + callbackPath).buildUpon()
            .appendQueryParameter("_android_snapshot_pref_saved", "1")
            .appendQueryParameter("_android_snapshot_enabled", enabled ? "1" : "0");
        if (returnSubscreen != null) {
            builder.appendQueryParameter("_account_subscreen", returnSubscreen);
        }
        Uri uri = builder.build();

        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.setClass(this, LauncherActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }
}