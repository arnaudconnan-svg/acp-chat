package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class BiometricActivity extends Activity {

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

        // Build callback URI and return to web
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
}
