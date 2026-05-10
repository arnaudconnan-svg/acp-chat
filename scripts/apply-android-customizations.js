const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(__dirname, "templates", "CountryPickerActivity.java");
const LAUNCHER_TEMPLATE_PATH = path.join(__dirname, "templates", "LauncherActivity.java");
const BIOMETRIC_TEMPLATE_PATH = path.join(__dirname, "templates", "BiometricActivity.java");
const TWA_MANIFEST_PATH = path.join(ROOT, "android-project", "twa-manifest.json");
const APP_BUILD_GRADLE_PATH = path.join(ROOT, "android-project", "app", "build.gradle");
const LAUNCHER_ACTIVITY_PATH = path.join(ROOT, "android-project", "app", "src", "main", "java", "io", "facilitat", "app", "LauncherActivity.java");
const ANDROID_MANIFEST_PATH = path.join(ROOT, "android-project", "app", "src", "main", "AndroidManifest.xml");
const TARGET_PATH = path.join(
  ROOT,
  "android-project",
  "app",
  "src",
  "main",
  "java",
  "io",
  "facilitat",
  "app",
  "CountryPickerActivity.java"
);
const BIOMETRIC_TARGET_PATH = path.join(
  ROOT,
  "android-project",
  "app",
  "src",
  "main",
  "java",
  "io",
  "facilitat",
  "app",
  "BiometricActivity.java"
);

function fail(message) {
  console.error(`[android-customize] ${message}`);
  process.exit(1);
}

function main() {
  console.log("[android-customize] Applying persistent Android customizations...");

  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Missing template: ${TEMPLATE_PATH}`);
  }

  if (!fs.existsSync(LAUNCHER_TEMPLATE_PATH)) {
    fail(`Missing template: ${LAUNCHER_TEMPLATE_PATH}`);
  }

  if (!fs.existsSync(BIOMETRIC_TEMPLATE_PATH)) {
    fail(`Missing template: ${BIOMETRIC_TEMPLATE_PATH}`);
  }

  if (!fs.existsSync(TARGET_PATH)) {
    console.log(`[android-customize] Target not found, skipping: ${TARGET_PATH}`);
    console.log("[android-customize] Run npm run twa:build first to initialize android-project.");
    return;
  }

  if (fs.existsSync(TWA_MANIFEST_PATH)) {
    try {
      const twaManifest = JSON.parse(fs.readFileSync(TWA_MANIFEST_PATH, "utf8"));
      if (twaManifest.orientation !== "portrait") {
        twaManifest.orientation = "portrait";
        fs.writeFileSync(TWA_MANIFEST_PATH, `${JSON.stringify(twaManifest, null, 2)}\n`, "utf8");
        console.log("[android-customize] Applied portrait orientation to android-project/twa-manifest.json.");
      }
    } catch (err) {
      fail(`Failed to update ${TWA_MANIFEST_PATH}: ${err.message}`);
    }
  }

  if (fs.existsSync(APP_BUILD_GRADLE_PATH)) {
    try {
      // Build.gradle orientation + biometric dependencies are handled below with AndroidManifest.
      // No-op here to avoid double-processing.
    } catch (err) {
      fail(`Failed to update ${APP_BUILD_GRADLE_PATH}: ${err.message}`);
    }
  }

  // Ensure AndroidManifest.xml has screenOrientation="portrait" on LauncherActivity
  // and USE_BIOMETRIC permission + BiometricActivity declaration
  if (fs.existsSync(ANDROID_MANIFEST_PATH)) {
    try {
      let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, "utf8");
      
      // Portrait orientation on LauncherActivity
      const launcherActivityPattern = /<activity android:name="LauncherActivity"\s+android:alwaysRetainTaskState="true"\s+android:label="@string\/launcherName"\s+android:exported="true">/;
      const launcherActivityPatternWithOrientation = /<activity android:name="LauncherActivity"\s+android:alwaysRetainTaskState="true"\s+android:label="@string\/launcherName"\s+android:exported="true"\s+android:screenOrientation="portrait">/;
      
      if (!launcherActivityPatternWithOrientation.test(manifest) && launcherActivityPattern.test(manifest)) {
        manifest = manifest.replace(
          launcherActivityPattern,
          '<activity android:name="LauncherActivity"\n            android:alwaysRetainTaskState="true"\n            android:label="@string/launcherName"\n            android:exported="true"\n            android:screenOrientation="portrait">'
        );
        console.log("[android-customize] Applied portrait screenOrientation to AndroidManifest.xml LauncherActivity.");
      } else if (launcherActivityPatternWithOrientation.test(manifest)) {
        console.log("[android-customize] AndroidManifest.xml LauncherActivity already has portrait orientation.");
      }

      // Ensure LauncherActivity reuses the existing task instead of recreating a new app instance.
      const launcherBlockMatch = manifest.match(/<activity android:name="LauncherActivity"[\s\S]*?<\/activity>/);
      if (launcherBlockMatch) {
        const launcherBlock = launcherBlockMatch[0];
        let updatedLauncherBlock = launcherBlock;
        if (!updatedLauncherBlock.includes('android:launchMode="singleTask"')) {
          if (updatedLauncherBlock.includes('android:launchMode="')) {
            updatedLauncherBlock = updatedLauncherBlock.replace(
              /android:launchMode="[^"]*"/,
              'android:launchMode="singleTask"'
            );
          } else {
            updatedLauncherBlock = updatedLauncherBlock.replace(
              'android:screenOrientation="portrait"',
              'android:screenOrientation="portrait"\n            android:launchMode="singleTask"'
            );
          }
        }

        if (updatedLauncherBlock !== launcherBlock) {
          manifest = manifest.replace(launcherBlock, updatedLauncherBlock);
          console.log("[android-customize] Set LauncherActivity launchMode=singleTask in AndroidManifest.xml.");
        }
      }

      // USE_BIOMETRIC permission
      if (!manifest.includes('android.permission.USE_BIOMETRIC')) {
        manifest = manifest.replace(
          '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>',
          '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>\n        <uses-permission android:name="android.permission.USE_BIOMETRIC"/>'
        );
        console.log("[android-customize] Added USE_BIOMETRIC permission to AndroidManifest.xml.");
      }

      // BiometricActivity declaration
      if (!manifest.includes('android:name="BiometricActivity"')) {
        manifest = manifest.replace(
          '<activity android:name="CountryPickerActivity"',
          [
            '<activity android:name="BiometricActivity"',
            '            android:label="Facilitat.io"',
            '            android:exported="true"',
            '            android:noHistory="true"',
            '            android:excludeFromRecents="true"',
            '            android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar"',
            '            android:screenOrientation="portrait">',
            '            <intent-filter>',
            '                <action android:name="android.intent.action.VIEW" />',
            '                <category android:name="android.intent.category.DEFAULT" />',
            '                <category android:name="android.intent.category.BROWSABLE" />',
            '                <data android:scheme="facilitat" android:host="biometric-verify" />',
            '            </intent-filter>',
            '        </activity>',
            '',
            '        <activity android:name="CountryPickerActivity"'
          ].join("\n        ")
        );
        console.log("[android-customize] Added BiometricActivity to AndroidManifest.xml.");
      } else {
        console.log("[android-customize] BiometricActivity already declared in AndroidManifest.xml.");
      }

      // Keep BiometricActivity attributes aligned even if manifest changed manually.
      const biometricBlockMatch = manifest.match(/<activity android:name="BiometricActivity"[\s\S]*?<\/activity>/);
      if (biometricBlockMatch) {
        const biometricBlock = biometricBlockMatch[0];
        let updatedBiometricBlock = biometricBlock;

        if (!updatedBiometricBlock.includes('android:noHistory="true"')) {
          updatedBiometricBlock = updatedBiometricBlock.replace(
            'android:exported="true"',
            'android:exported="true"\n            android:noHistory="true"'
          );
        }

        if (!updatedBiometricBlock.includes('android:excludeFromRecents="true"')) {
          updatedBiometricBlock = updatedBiometricBlock.replace(
            'android:noHistory="true"',
            'android:noHistory="true"\n            android:excludeFromRecents="true"'
          );
        }

        if (!updatedBiometricBlock.includes('android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar"')) {
          updatedBiometricBlock = updatedBiometricBlock.replace(
            'android:excludeFromRecents="true"',
            'android:excludeFromRecents="true"\n            android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar"'
          );
        }

        if (updatedBiometricBlock !== biometricBlock) {
          manifest = manifest.replace(biometricBlock, updatedBiometricBlock);
          console.log("[android-customize] Normalized BiometricActivity manifest attributes.");
        }
      }

      fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest, "utf8");
    } catch (err) {
      console.warn(`[android-customize] Warning: Could not update ${ANDROID_MANIFEST_PATH}: ${err.message}`);
    }
  }

  // Ensure build.gradle has biometric + fragment dependencies
  if (fs.existsSync(APP_BUILD_GRADLE_PATH)) {
    try {
      let buildGradle = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");

      // Portrait orientation fix (existing)
      const updatedBuildGradle = buildGradle.replace(
        /orientation:\s*'default'/,
        "orientation: 'portrait'"
      );
      if (updatedBuildGradle !== buildGradle) {
        buildGradle = updatedBuildGradle;
        console.log("[android-customize] Applied portrait orientation to android-project/app/build.gradle.");
      }

      // Biometric dependencies
      if (!buildGradle.includes("androidx.biometric:biometric")) {
        buildGradle = buildGradle.replace(
          "implementation 'com.google.androidbrowserhelper:androidbrowserhelper:2.6.2'",
          [
            "implementation 'com.google.androidbrowserhelper:androidbrowserhelper:2.6.2'",
            "    implementation 'androidx.biometric:biometric:1.2.0-alpha05'",
            "    implementation 'androidx.fragment:fragment:1.8.6'"
          ].join("\n    ")
        );
        console.log("[android-customize] Added biometric/fragment dependencies to build.gradle.");
      }

      fs.writeFileSync(APP_BUILD_GRADLE_PATH, buildGradle, "utf8");
    } catch (err) {
      fail(`Failed to update ${APP_BUILD_GRADLE_PATH}: ${err.message}`);
    }
  }

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const current = fs.readFileSync(TARGET_PATH, "utf8");
  const launcherTemplate = fs.readFileSync(LAUNCHER_TEMPLATE_PATH, "utf8");
  const launcherCurrent = fs.existsSync(LAUNCHER_ACTIVITY_PATH) ? fs.readFileSync(LAUNCHER_ACTIVITY_PATH, "utf8") : null;

  if (launcherCurrent !== launcherTemplate) {
    fs.writeFileSync(LAUNCHER_ACTIVITY_PATH, launcherTemplate, "utf8");
    console.log("[android-customize] LauncherActivity customization applied.");
  }

  if (current === template) {
    console.log("[android-customize] Country picker already up to date.");
  } else {
    fs.writeFileSync(TARGET_PATH, template, "utf8");
    console.log("[android-customize] Country picker customization applied.");
  }

  // BiometricActivity
  const biometricTemplate = fs.readFileSync(BIOMETRIC_TEMPLATE_PATH, "utf8");
  const biometricCurrent = fs.existsSync(BIOMETRIC_TARGET_PATH) ? fs.readFileSync(BIOMETRIC_TARGET_PATH, "utf8") : null;
  if (biometricCurrent !== biometricTemplate) {
    fs.writeFileSync(BIOMETRIC_TARGET_PATH, biometricTemplate, "utf8");
    console.log("[android-customize] BiometricActivity customization applied.");
  } else {
    console.log("[android-customize] BiometricActivity already up to date.");
  }
}

main();
