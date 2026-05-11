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
    private static final String EXTRA_NATIVE_GATE = "nativeGate";
    private static final int NATIVE_GATE_REQUEST_CODE = 1407;

    private boolean biometricGateInFlight = false;
    private boolean skipNextNativeGateOnce = false;

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
        if (biometricGateInFlight) {
            // If we resumed while gate is still marked in-flight, treat it as inconsistent
            // and fail closed (never reveal app content).
            Log.d("Facilitat", "native-bio in-flight resume detected -> HOME");
            biometricGateInFlight = false;
            Intent homeIntent = new Intent(Intent.ACTION_MAIN);
            homeIntent.addCategory(Intent.CATEGORY_HOME);
            homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(homeIntent);
            return;
        }

        if (handleNativeBiometricGate(getIntent())) {
            return;
        }

        super.onResume();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        // New launcher intents (icon tap / deep link) must clear stale in-flight flag.
        biometricGateInFlight = false;

        if (handleNativeBiometricGate(intent)) {
            return;
        }

        super.onNewIntent(intent);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != NATIVE_GATE_REQUEST_CODE) {
            return;
        }

        biometricGateInFlight = false;
        if (resultCode == RESULT_OK) {
            Log.d("Facilitat", "native-bio result OK");
            // Consume one launcher resume without reopening the gate.
            skipNextNativeGateOnce = true;
            return;
        }

        Log.d("Facilitat", "native-bio result canceled/failed -> HOME");
        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
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

    private boolean handleNativeBiometricGate(Intent intent) {
        if (!shouldOpenNativeBiometricGate(intent)) {
            return false;
        }

        if (biometricGateInFlight) {
            Log.d("Facilitat", "native-bio gate already in-flight");
            return true;
        }

        openNativeBiometricGate();
        return true;
    }

    private boolean shouldOpenNativeBiometricGate(Intent intent) {
        if (skipNextNativeGateOnce) {
            skipNextNativeGateOnce = false;
            Log.d("Facilitat", "native-bio bypass consumed after success");
            return false;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        boolean enabled = prefs.getBoolean(KEY_BIO_ENABLED, false);
        if (!enabled) {
            Log.d("Facilitat", "native-bio policy: disabled");
            return false;
        }

        int relockSeconds = prefs.getInt(KEY_BIO_RELOCK_SECONDS, 120);
        if (relockSeconds != 0 && relockSeconds != 30 && relockSeconds != 120 && relockSeconds != 300) {
            relockSeconds = 120;
        }

        long lastUnlockMs = prefs.getLong(KEY_BIO_LAST_UNLOCK_MS, 0L);
        if (lastUnlockMs <= 0L) {
            Log.d("Facilitat", "native-bio policy: would require auth (no unlock timestamp)");
            return true;
        }

        if (relockSeconds == 0) {
            Log.d("Facilitat", "native-bio policy: would require auth (relock=0)");
            return true;
        }

        long elapsed = System.currentTimeMillis() - lastUnlockMs;
        boolean shouldRequireAuth = elapsed >= relockSeconds * 1000L;
        Log.d(
                "Facilitat",
                "native-bio policy: enabled, relockSeconds=" + relockSeconds
                        + ", elapsedMs=" + elapsed
                        + ", wouldRequireAuth=" + shouldRequireAuth
        );
        return shouldRequireAuth;
    }

    private void openNativeBiometricGate() {
        biometricGateInFlight = true;
        Intent gateIntent = new Intent(this, BiometricActivity.class);
        gateIntent.putExtra(EXTRA_NATIVE_GATE, true);
        gateIntent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivityForResult(gateIntent, NATIVE_GATE_REQUEST_CODE);
        overridePendingTransition(0, 0);
    }
}