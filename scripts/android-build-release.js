const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ANDROID_DIR = path.join(ROOT, "android-project");

function runNpm(args) {
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args]);
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmCmd, args);
}

function run(command, args, options = {}) {
  let resolvedCommand = command;
  let resolvedArgs = args;

  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
    resolvedCommand = process.env.ComSpec || "cmd.exe";
    resolvedArgs = ["/d", "/s", "/c", command, ...args];
  }

  const result = spawnSync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd || ROOT,
    stdio: "inherit",
    shell: false
  });

  if (result.error) {
    console.error(`[android-release] Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  console.log("[android-release] Applying Android customizations...");
  runNpm(["run", "android:apply-customizations"]);

  console.log("[android-release] Verifying orientation inputs...");
  runNpm(["run", "android:orientation:verify", "--", "--source-only"]);

  console.log("[android-release] Verifying adaptive icons...");
  runNpm(["run", "android:icon:verify"]);

  const gradleCmd = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
  console.log("[android-release] Building release APK with Gradle...");
  run(gradleCmd, ["assembleRelease"], { cwd: ANDROID_DIR });

  console.log("[android-release] Verifying generated orientation values...");
  runNpm(["run", "android:orientation:verify"]);

  console.log("[android-release] Release build completed.");
}

main();
