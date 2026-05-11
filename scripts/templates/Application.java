package io.facilitat.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.ProcessLifecycleOwner;

/**
 * Application-level lifecycle observer.
 *
 * Primary relock path: LauncherActivity.onUserLeaveHint() pushes a GateActivity
 * (relock mode) on top of the task before the app goes to background. When the
 * task returns (Recents or launcher), that GateActivity is the top activity,
 * our process restarts, and auth is enforced.
 *
 * Secondary guard: ProcessLifecycleOwner.onStart() catches the edge case where
 * MIUI kept the process alive during the background stay.
 */
public class Application extends android.app.Application implements DefaultLifecycleObserver {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";
    static final String KEY_BIO_JUST_UNLOCKED = "biometric_just_unlocked";

    // Accessible from LauncherActivity/GateActivity to skip spurious relocks
    // during intra-app navigation (biometric or gate activity is already showing).
    static volatile boolean gateActivityStarted = false;
    static volatile boolean biometricActivityStarted = false;

    @Override
    public void onCreate() {
        super.onCreate();
        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks() {
            @Override
            public void onActivityCreated(@NonNull Activity activity, android.os.Bundle savedInstanceState) {}

            @Override
            public void onActivityStarted(@NonNull Activity activity) {
                if (activity instanceof GateActivity) {
                    gateActivityStarted = true;
                }
                if (activity instanceof BiometricActivity) {
                    biometricActivityStarted = true;
                }
            }

            @Override
            public void onActivityResumed(@NonNull Activity activity) {}

            @Override
            public void onActivityPaused(@NonNull Activity activity) {}

            @Override
            public void onActivityStopped(@NonNull Activity activity) {
                if (activity instanceof GateActivity) {
                    gateActivityStarted = false;
                }
                if (activity instanceof BiometricActivity) {
                    biometricActivityStarted = false;
                }
            }

            @Override
            public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull android.os.Bundle outState) {}

            @Override
            public void onActivityDestroyed(@NonNull Activity activity) {}
        });
        ProcessLifecycleOwner.get().getLifecycle().addObserver(this);
    }

    /**
     * Secondary guard: fires when the process returns to foreground while still alive.
     * In that case no GateActivity(relock) was pushed on the stack, so we trigger
     * auth directly from here.
     */
    @Override
    public void onStart(@NonNull LifecycleOwner owner) {
        if (gateActivityStarted) {
            Log.d("Facilitat", "Application.onStart: GateActivity active, skip appForeground relock");
            return;
        }
        maybeLaunchAppForegroundBiometric("Application.onStart");
    }

    private void maybeLaunchAppForegroundBiometric(String source) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        if (prefs.getBoolean(KEY_BIO_JUST_UNLOCKED, false)) {
            prefs.edit().remove(KEY_BIO_JUST_UNLOCKED).apply();
            Log.d("Facilitat", source + ": justUnlocked flag set, skipping relock");
            return;
        }

        boolean enabled = prefs.getBoolean(KEY_BIO_ENABLED, false);
        if (!enabled) {
            return;
        }

        int relockSeconds = prefs.getInt(KEY_BIO_RELOCK_SECONDS, 120);
        if (relockSeconds != 0 && relockSeconds != 30 && relockSeconds != 120 && relockSeconds != 300) {
            relockSeconds = 120;
        }

        if (relockSeconds != 0) {
            long lastUnlockMs = prefs.getLong(KEY_BIO_LAST_UNLOCK_MS, 0L);
            if (lastUnlockMs > 0) {
                long elapsed = System.currentTimeMillis() - lastUnlockMs;
                if (elapsed < relockSeconds * 1000L) {
                    Log.d("Facilitat", source + ": within relock window (" + elapsed + "ms / " + relockSeconds + "s), skip");
                    return;
                }
            }
        }

        Log.d("Facilitat", source + ": relock required, launching BiometricActivity (appForeground)");
        Intent intent = new Intent(this, BiometricActivity.class);
        intent.putExtra(BiometricActivity.EXTRA_APP_FOREGROUND, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivity(intent);
    }
}