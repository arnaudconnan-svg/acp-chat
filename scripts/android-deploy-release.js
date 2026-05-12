const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ANDROID_DIR = path.join(ROOT, "android-project");
const RELEASE_DIR = path.join(ANDROID_DIR, "app", "build", "outputs", "apk", "release");
const PACKAGE_NAME = String(process.env.TWA_ANDROID_PACKAGE || "io.facilitat.app").trim() || "io.facilitat.app";
const BROWSER_HOST_PACKAGE = String(process.env.TWA_BROWSER_HOST_PACKAGE || "com.android.chrome").trim() || "com.android.chrome";
const argv = new Set(process.argv.slice(2));

function fail(message) {
  console.error(`[android-deploy] ${message}`);
  process.exit(1);
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
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    shell: false
  });

  if (options.stdio === "inherit") {
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
    return result;
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
  }

  return result;
}

function runNpm(args, options = {}) {
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (npmExecPath) {
    return run(process.execPath, [npmExecPath, ...args], options);
  }

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npmCmd, args, options);
}

function runBestEffort(command, args, options = {}) {
  let resolvedCommand = command;
  let resolvedArgs = args;

  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
    resolvedCommand = process.env.ComSpec || "cmd.exe";
    resolvedArgs = ["/d", "/s", "/c", command, ...args];
  }

  const result = spawnSync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    shell: false
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || "").trim();
    console.warn(`[android-deploy] Non-blocking command failed: ${command} ${args.join(" ")}${details ? ` (${details})` : ""}`);
  }

  return result;
}

function getSdkRoot() {
  const candidates = [
    String(process.env.ANDROID_SDK_ROOT || "").trim(),
    String(process.env.ANDROID_HOME || "").trim(),
    path.join(String(process.env.LOCALAPPDATA || "").trim(), "Android", "Sdk")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  fail("Unable to locate Android SDK. Set ANDROID_SDK_ROOT or ANDROID_HOME.");
}

function getLatestBuildToolsDir(sdkRoot) {
  const buildToolsDir = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsDir)) {
    fail(`Missing build-tools directory: ${buildToolsDir}`);
  }

  const versions = fs.readdirSync(buildToolsDir)
    .filter((entry) => fs.statSync(path.join(buildToolsDir, entry)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const latest = versions[versions.length - 1];
  if (!latest) fail(`No build-tools versions found in ${buildToolsDir}`);
  return path.join(buildToolsDir, latest);
}

function getUnsignedApk() {
  const apk = path.join(RELEASE_DIR, "app-release-unsigned.apk");
  if (!fs.existsSync(apk)) fail(`Missing unsigned APK: ${apk}`);
  return apk;
}

function getSignedApk() {
  return path.join(RELEASE_DIR, "app-release.apk");
}

function getAlignedUnsignedApk() {
  return path.join(RELEASE_DIR, "app-release-aligned-unsigned.apk");
}

function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

function getMtimeMs(filePath) {
  return fileExists(filePath) ? fs.statSync(filePath).mtimeMs : 0;
}

function shouldReuseSignedApk(unsignedApk, signedApk, apksigner) {
  if (!fileExists(unsignedApk) || !fileExists(signedApk)) {
    return false;
  }

  if (getMtimeMs(signedApk) < getMtimeMs(unsignedApk)) {
    return false;
  }

  const verify = spawnSync(
    process.platform === "win32" && /\.(bat|cmd)$/i.test(apksigner) ? (process.env.ComSpec || "cmd.exe") : apksigner,
    process.platform === "win32" && /\.(bat|cmd)$/i.test(apksigner)
      ? ["/d", "/s", "/c", apksigner, "verify", "--verbose", signedApk]
      : ["verify", "--verbose", signedApk],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      shell: false
    }
  );

  return verify.status === 0;
}

function main() {
  const skipBuild = argv.has("--skip-build");
  const skipSign = argv.has("--skip-sign");
  const sdkRoot = getSdkRoot();
  const buildToolsDir = getLatestBuildToolsDir(sdkRoot);
  const apksigner = process.platform === "win32" ? path.join(buildToolsDir, "apksigner.bat") : path.join(buildToolsDir, "apksigner");
  const zipalign = process.platform === "win32" ? path.join(buildToolsDir, "zipalign.exe") : path.join(buildToolsDir, "zipalign");
  const adb = process.platform === "win32" ? path.join(sdkRoot, "platform-tools", "adb.exe") : path.join(sdkRoot, "platform-tools", "adb");

  if (!fs.existsSync(apksigner)) fail(`Missing apksigner at ${apksigner}`);
  if (!fs.existsSync(zipalign)) fail(`Missing zipalign at ${zipalign}`);
  if (!fs.existsSync(adb)) fail(`Missing adb at ${adb}`);

  const unsignedApk = getUnsignedApk();
  const alignedUnsignedApk = getAlignedUnsignedApk();
  const signedApk = getSignedApk();
  const keystorePath = path.join(String(process.env.USERPROFILE || process.env.HOME || ""), ".android", "facilitat-dev.keystore");
  const keystorePass = String(process.env.FACILITAT_KEYSTORE_PASS || "facilitat123");
  const keyAlias = String(process.env.FACILITAT_KEY_ALIAS || "facilitat-dev");

  if (!skipBuild) {
    console.log("[android-deploy] Building release APK...");
    runNpm(["run", "android:build:release"], { stdio: "inherit" });
  } else {
    console.log("[android-deploy] Skipping build (--skip-build).");
  }

  if (!fileExists(unsignedApk) && !fileExists(signedApk)) {
    fail(`Missing APK artifacts in ${RELEASE_DIR}. Run a release build first.`);
  }

  if (!fs.existsSync(keystorePath)) {
    fail(`Missing keystore: ${keystorePath}`);
  }

  const canReuseSignedApk = !skipSign && shouldReuseSignedApk(unsignedApk, signedApk, apksigner);

  if (skipSign) {
    console.log("[android-deploy] Skipping sign (--skip-sign).");
  } else if (canReuseSignedApk) {
    console.log("[android-deploy] Reusing existing signed APK (unchanged input).");
  } else {
    console.log("[android-deploy] Aligning unsigned APK...");
    if (fs.existsSync(alignedUnsignedApk)) fs.unlinkSync(alignedUnsignedApk);
    run(zipalign, ["-v", "4", unsignedApk, alignedUnsignedApk], { stdio: "inherit" });

    console.log("[android-deploy] Signing aligned APK...");
    if (fs.existsSync(signedApk)) fs.unlinkSync(signedApk);
    run(apksigner, [
      "sign",
      "--ks", keystorePath,
      "--ks-key-alias", keyAlias,
      "--ks-pass", `pass:${keystorePass}`,
      "--key-pass", `pass:${keystorePass}`,
      "--out", signedApk,
      alignedUnsignedApk
    ], { stdio: "inherit" });
  }

  console.log("[android-deploy] Verifying APK signature...");
  run(apksigner, ["verify", "--verbose", signedApk], { stdio: "inherit" });

  console.log("[android-deploy] Checking connected devices...");
  const devices = run(adb, ["devices"], { stdio: "pipe" });
  const lines = String(devices.stdout || "").split(/\r?\n/).map((line) => line.trim());
  const online = lines.filter((line) => /\sdevice(\s|$)/i.test(line));
  if (online.length === 0) {
    fail("No Android device detected by adb.");
  }

  console.log("[android-deploy] Installing APK via SDK adb...");
  const install = run(adb, ["install", "-r", signedApk], { stdio: "pipe" });
  if (install.stdout) process.stdout.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);
  if (install.status !== 0) {
    const combined = `${install.stdout || ""}\n${install.stderr || ""}`;
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(combined)) {
      console.log(`[android-deploy] Existing ${PACKAGE_NAME} has a different signature. Uninstalling before reinstall.`);
      run(adb, ["uninstall", PACKAGE_NAME], { stdio: "inherit" });
      const retry = run(adb, ["install", signedApk], { stdio: "pipe" });
      if (retry.stdout) process.stdout.write(retry.stdout);
      if (retry.stderr) process.stderr.write(retry.stderr);
      if (retry.status !== 0) {
        fail("adb install failed after uninstall.");
      }
    } else {
      fail("adb install failed.");
    }
  }

  console.log(`[android-deploy] Restarting ${PACKAGE_NAME} to ensure fresh runtime...`);
  runBestEffort(adb, ["shell", "am", "force-stop", BROWSER_HOST_PACKAGE], { stdio: "inherit" });
  run(adb, [
    "shell",
    "am",
    "start",
    "-S",
    "-W",
    "-n",
    `${PACKAGE_NAME}/.LauncherActivity`,
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER"
  ], { stdio: "inherit" });

  console.log("[android-deploy] Deployment complete.");
}

main();
