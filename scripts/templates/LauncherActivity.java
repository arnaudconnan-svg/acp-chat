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
    private static final String PRIVACY_PREFS = "facilitat_privacy";
    private static final String SCREEN_CAPTURE_ENABLED_KEY = "screen_capture_enabled";

    private boolean isScreenCaptureEnabled() {
        SharedPreferences prefs = getSharedPreferences(PRIVACY_PREFS, MODE_PRIVATE);
        return prefs.getBoolean(SCREEN_CAPTURE_ENABLED_KEY, false);
    }

    private void applyScreenCapturePreference() {
        if (isScreenCaptureEnabled()) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        }
        super.onCreate(savedInstanceState);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        applyScreenCapturePreference();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyScreenCapturePreference();
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