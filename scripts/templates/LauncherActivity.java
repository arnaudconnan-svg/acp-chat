/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package io.facilitat.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;

import java.util.Locale;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";
    private static final long WEB_RELOCK_SUPPRESS_MS = 15000L;
    private static final int FOREGROUND_BIO_REQUEST_CODE = 1411;

    private boolean foregroundGateInFlight = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        super.onCreate(savedInstanceState);
        // Hide app content from Android recent-apps thumbnails/screenshots.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    }

    @Override
    protected void onResume() {
        super.onResume();

        if (foregroundGateInFlight) {
            return;
        }

        if (!shouldRequireForegroundGate()) {
            return;
        }

        foregroundGateInFlight = true;
        Intent gateIntent = new Intent(this, BiometricActivity.class);
        gateIntent.putExtra(BiometricActivity.EXTRA_APP_FOREGROUND, true);
        gateIntent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivityForResult(gateIntent, FOREGROUND_BIO_REQUEST_CODE);
        overridePendingTransition(0, 0);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FOREGROUND_BIO_REQUEST_CODE) {
            return;
        }

        foregroundGateInFlight = false;
        if (resultCode == RESULT_OK) {
            return;
        }

        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
    }

    private boolean shouldRequireForegroundGate() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_BIO_ENABLED, false)) {
            return false;
        }

        if (prefs.getBoolean(Application.KEY_BIO_JUST_UNLOCKED, false)) {
            prefs.edit().remove(Application.KEY_BIO_JUST_UNLOCKED).apply();
            return false;
        }

        int relockSeconds = prefs.getInt(KEY_BIO_RELOCK_SECONDS, 120);
        if (relockSeconds != 0 && relockSeconds != 30 && relockSeconds != 120 && relockSeconds != 300) {
            relockSeconds = 120;
        }

        if (relockSeconds == 0) {
            return true;
        }

        long lastUnlockMs = prefs.getLong(KEY_BIO_LAST_UNLOCK_MS, 0L);
        if (lastUnlockMs <= 0L) {
            return true;
        }

        long elapsedMs = System.currentTimeMillis() - lastUnlockMs;
        return elapsedMs >= relockSeconds * 1000L;
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        Log.d("Facilitat", "onConfigurationChanged called with orientation: " + newConfig.orientation);
        super.onConfigurationChanged(newConfig);
        Log.d("Facilitat", "Forcing portrait orientation...");
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri uri = super.getLaunchingUrl();
        String country = Locale.getDefault().getCountry();
        Uri.Builder builder = uri.buildUpon();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        if (prefs.getBoolean(Application.KEY_BIO_JUST_UNLOCKED, false)) {
            long suppressUntil = System.currentTimeMillis() + WEB_RELOCK_SUPPRESS_MS;
            builder.appendQueryParameter("_suppress_web_relock_until", String.valueOf(suppressUntil));
        }

        if (country != null && !country.isEmpty()) {
            builder.appendQueryParameter("_android_country", country.toUpperCase(Locale.US));
        }
        return builder.build();
    }
}