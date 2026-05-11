package io.facilitat.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.ProcessLifecycleOwner;

import java.util.List;

/**
 * Application-level lifecycle observer.
 * Intercepts foreground returns and enforces biometric lock even when MIUI
 * resumes the task through CustomTabActivity (Recents path).
 */
public class Application extends android.app.Application implements DefaultLifecycleObserver {

    private static final String PREFS_NAME = "facilitat_security";
    private static final String KEY_BIO_ENABLED = "biometric_enabled";
    private static final String KEY_BIO_RELOCK_SECONDS = "biometric_relock_seconds";
    private static final String KEY_BIO_LAST_UNLOCK_MS = "biometric_last_unlock_ms";
    static final String KEY_BIO_JUST_UNLOCKED = "biometric_just_unlocked";
    private static final long TASK_WATCHER_INTERVAL_MS = 700L;

    private volatile boolean gateActivityStarted = false;
    private volatile boolean biometricActivityStarted = false;
    private final Handler taskWatcherHandler = new Handler(Looper.getMainLooper());
    private Boolean lastProcessForeground = null;

    private final Runnable taskWatcher = new Runnable() {
        @Override
        public void run() {
            try {
                maybeHandleRecentsVisibilityReturn();
            } catch (Exception e) {
                Log.d("Facilitat", "Application.taskWatcher error=" + e.getMessage());
            } finally {
                taskWatcherHandler.postDelayed(this, TASK_WATCHER_INTERVAL_MS);
            }
        }
    };

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
        taskWatcherHandler.post(taskWatcher);
    }

    @Override
    public void onStart(@NonNull LifecycleOwner owner) {
        // Cold start is already protected by GateActivity; do not open a second
        // BiometricActivity from Application-level lock during the same transition.
        if (gateActivityStarted) {
            Log.d("Facilitat", "Application.onStart: GateActivity active, skip appForeground relock");
            return;
        }
        maybeLaunchAppForegroundBiometric("Application.onStart");
    }

    private void maybeHandleRecentsVisibilityReturn() {
        ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        if (am == null) {
            return;
        }

        List<ActivityManager.AppTask> appTasks = am.getAppTasks();
        if (appTasks == null || appTasks.isEmpty()) {
            return;
        }

        ActivityManager.RecentTaskInfo taskInfo = appTasks.get(0).getTaskInfo();
        if (taskInfo == null) {
            return;
        }

        boolean processForeground = isAppProcessForeground(am);
        if (lastProcessForeground == null) {
            lastProcessForeground = processForeground;
            return;
        }

        boolean becameForeground = !lastProcessForeground && processForeground;
        lastProcessForeground = processForeground;
        if (!becameForeground) {
            return;
        }

        if (gateActivityStarted || biometricActivityStarted) {
            return;
        }

        ComponentName top = taskInfo.topActivity;
        String topClass = top != null ? top.getClassName() : "";
        if (!topClass.contains("org.chromium.chrome.browser.customtabs.CustomTabActivity")) {
            return;
        }

        maybeLaunchAppForegroundBiometric("Application.taskWatcher");
    }

    private void maybeLaunchAppForegroundBiometric(String source) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        // Guard: a biometric auth just completed in this process — skip relock check
        // to avoid double-prompting immediately after initial Gate or unlock.
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

    private boolean isAppProcessForeground(ActivityManager am) {
        List<ActivityManager.RunningAppProcessInfo> processes = am.getRunningAppProcesses();
        if (processes == null) {
            return false;
        }

        String packageName = getPackageName();
        for (ActivityManager.RunningAppProcessInfo proc : processes) {
            if (proc == null || proc.processName == null) {
                continue;
            }
            if (!packageName.equals(proc.processName)) {
                continue;
            }
            return proc.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
        }

        return false;
    }
}
