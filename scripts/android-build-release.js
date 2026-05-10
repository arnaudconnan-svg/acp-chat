const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ANDROID_DIR = path.join(ROOT, "android-project");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  console.log("[android-release] Applying Android customizations...");
  run("npm", ["run", "android:apply-customizations"]);

  console.log("[android-release] Verifying adaptive icons...");
  run("npm", ["run", "android:icon:verify"]);

  const gradleCmd = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  console.log("[android-release] Building release APK with Gradle...");
  run(gradleCmd, ["assembleRelease"], { cwd: ANDROID_DIR });

  console.log("[android-release] Release build completed.");
}

main();
