const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(__dirname, "templates", "CountryPickerActivity.java");
const TWA_MANIFEST_PATH = path.join(ROOT, "android-project", "twa-manifest.json");
const LAUNCHER_ACTIVITY_PATH = path.join(ROOT, "android-project", "app", "src", "main", "java", "io", "facilitat", "app", "LauncherActivity.java");
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

function fail(message) {
  console.error(`[android-customize] ${message}`);
  process.exit(1);
}

function main() {
  console.log("[android-customize] Applying persistent Android customizations...");

  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Missing template: ${TEMPLATE_PATH}`);
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

  if (fs.existsSync(LAUNCHER_ACTIVITY_PATH)) {
    const launcherSource = fs.readFileSync(LAUNCHER_ACTIVITY_PATH, "utf8");
    const updatedLauncherSource = launcherSource.replace(
      /setRequestedOrientation\(ActivityInfo\.SCREEN_ORIENTATION_UNSPECIFIED\);/,
      "setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);"
    );
    if (updatedLauncherSource !== launcherSource) {
      fs.writeFileSync(LAUNCHER_ACTIVITY_PATH, updatedLauncherSource, "utf8");
      console.log("[android-customize] Applied portrait orientation to LauncherActivity.");
    }
  }

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const current = fs.readFileSync(TARGET_PATH, "utf8");

  if (current === template) {
    console.log("[android-customize] Country picker already up to date.");
    return;
  }

  fs.writeFileSync(TARGET_PATH, template, "utf8");
  console.log("[android-customize] Country picker customization applied.");
}

main();
