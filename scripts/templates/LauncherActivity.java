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
import android.view.WindowManager;

import java.util.Locale;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final int INITIAL_BIO_REQUEST_CODE = 1411;

    private boolean initialGateInFlight = false;
    private boolean initialGateCompleted = false;

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

        if (initialGateCompleted || initialGateInFlight) {
            return;
        }

        if (!shouldRequireInitialLaunchGate()) {
            return;
        }

        initialGateInFlight = true;
        Intent gateIntent = new Intent(this, GateActivity.class);
        gateIntent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivityForResult(gateIntent, INITIAL_BIO_REQUEST_CODE);
        overridePendingTransition(0, 0);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != INITIAL_BIO_REQUEST_CODE) {
            return;
        }

        initialGateInFlight = false;
        if (resultCode == RESULT_OK) {
            initialGateCompleted = true;
            return;
        }

        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
    }

    private boolean shouldRequireInitialLaunchGate() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(KEY_BIO_ENABLED, false);
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

        if (country != null && !country.isEmpty()) {
            builder.appendQueryParameter("_android_country", country.toUpperCase(Locale.US));
        }
        return builder.build();
    }
}