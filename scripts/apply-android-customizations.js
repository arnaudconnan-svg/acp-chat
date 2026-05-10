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
      const buildGradle = fs.readFileSync(APP_BUILD_GRADLE_PATH, "utf8");
      const updatedBuildGradle = buildGradle.replace(
        /orientation:\s*'default'/,
        "orientation: 'portrait'"
      );
      if (updatedBuildGradle !== buildGradle) {
        fs.writeFileSync(APP_BUILD_GRADLE_PATH, updatedBuildGradle, "utf8");
        console.log("[android-customize] Applied portrait orientation to android-project/app/build.gradle.");
      }
    } catch (err) {
      fail(`Failed to update ${APP_BUILD_GRADLE_PATH}: ${err.message}`);
    }
  }

  // Ensure AndroidManifest.xml has screenOrientation="portrait" on LauncherActivity
  if (fs.existsSync(ANDROID_MANIFEST_PATH)) {
    try {
      let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, "utf8");
      
      // Pattern to match LauncherActivity opening tag without screenOrientation
      const launcherActivityPattern = /<activity android:name="LauncherActivity"\s+android:alwaysRetainTaskState="true"\s+android:label="@string\/launcherName"\s+android:exported="true">/;
      const launcherActivityPatternWithOrientation = /<activity android:name="LauncherActivity"\s+android:alwaysRetainTaskState="true"\s+android:label="@string\/launcherName"\s+android:exported="true"\s+android:screenOrientation="portrait">/;
      
      if (!launcherActivityPatternWithOrientation.test(manifest) && launcherActivityPattern.test(manifest)) {
        manifest = manifest.replace(
          launcherActivityPattern,
          '<activity android:name="LauncherActivity"\n            android:alwaysRetainTaskState="true"\n            android:label="@string/launcherName"\n            android:exported="true"\n            android:screenOrientation="portrait">'
        );
        fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest, "utf8");
        console.log("[android-customize] Applied portrait screenOrientation to AndroidManifest.xml LauncherActivity.");
      } else if (launcherActivityPatternWithOrientation.test(manifest)) {
        console.log("[android-customize] AndroidManifest.xml LauncherActivity already has portrait orientation.");
      }

    } catch (err) {
      console.warn(`[android-customize] Warning: Could not update ${ANDROID_MANIFEST_PATH}: ${err.message}`);
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
