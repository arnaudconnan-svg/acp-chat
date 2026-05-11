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
    private static final String EXTRA_FORCE_NATIVE_GATE = "forceNativeGate";

    // Accessible from LauncherActivity/GateActivity to skip spurious relocks
    // during intra-app navigation (biometric or gate activity is already showing).
    static volatile boolean gateActivityStarted = false;
    static volatile boolean biometricActivityStarted = false;
    private volatile boolean appWentToBackground = false;

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

        if (!appWentToBackground) {
            return;
        }

        appWentToBackground = false;
        maybeLaunchAppForegroundBiometric("Application.onStart");
    }

    @Override
    public void onStop(@NonNull LifecycleOwner owner) {
        appWentToBackground = true;
    }

    private void maybeLaunchAppForegroundBiometric(String source) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        if (prefs.getBoolean(KEY_BIO_JUST_UNLOCKED, false)) {
            // Keep the marker so LauncherActivity can consume it and avoid
            // a second biometric prompt right after GateActivity auth success.
            Log.d("Facilitat", source + ": justUnlocked flag set, skipping relock (marker kept for Launcher)");
            return;
        }

        boolean enabled = prefs.getBoolean(KEY_BIO_ENABLED, false);
        if (!enabled) {
            return;
        }

        // Deterministic fallback for Recents/background return: always relock
        // after a real process background transition when biometric is enabled.
        Log.d("Facilitat", source + ": relock required, launching GateActivity with forceNativeGate");
        Intent intent = new Intent(this, GateActivity.class);
        intent.putExtra(EXTRA_FORCE_NATIVE_GATE, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        startActivity(intent);
    }
}