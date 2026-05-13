const fs = require("fs");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

function getTwaManifestPath() {
  return path.join(__dirname, "..", "twa-manifest.json");
}

function readTwaManifest() {
  const manifestPath = getTwaManifestPath();
  if (!fs.existsSync(manifestPath)) {
    console.error("[bubblewrap] twa-manifest.json not found. Run 'npm run twa:manifest' first.");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest.webManifestUrl !== "string" || !manifest.webManifestUrl.trim()) {
    console.error("[bubblewrap] Invalid twa-manifest.json: missing webManifestUrl.");
    process.exit(1);
  }

  return manifest;
}

function normalizeUrlPath(value, fallback = "/") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  try {
    const url = new URL(raw);
    return `${url.pathname || "/"}${url.search || ""}${url.hash || ""}` || fallback;
  } catch (_) {
    return raw.startsWith("/") ? raw : `/${raw}`;
  }
}

function resolveSdkRoot() {
  const candidates = [
    String(process.env.ANDROID_SDK_ROOT || "").trim(),
    String(process.env.ANDROID_HOME || "").trim(),
    path.join(String(process.env.LOCALAPPDATA || "").trim(), "Android", "Sdk"),
    path.join(String(process.env.USERPROFILE || process.env.HOME || "").trim(), ".bubblewrap", "android_sdk")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return "";
}

function writeLocalProperties(projectDir) {
  const sdkRoot = resolveSdkRoot();
  if (!sdkRoot) {
    console.warn("[bubblewrap] Android SDK not found; skipping local.properties generation.");
    return;
  }

  const localPropertiesPath = path.join(projectDir, "local.properties");
  const escapedSdkRoot = sdkRoot.replace(/\\/g, "\\\\");
  fs.writeFileSync(localPropertiesPath, `sdk.dir=${escapedSdkRoot}\n`, "utf8");
  console.log("[bubblewrap] Wrote local.properties with resolved Android SDK path.");
}

function buildBubblewrapAnswers(manifest) {
  const startPath = normalizeUrlPath(manifest.startUrl || "/", "/");
  const packageId = String(manifest.packageId || "io.facilitat.app").trim() || "io.facilitat.app";
  const appName = String(manifest.name || "Facilitat.io").trim() || "Facilitat.io";
  const launcherName = String(manifest.launcherName || appName).trim() || appName;
  const versionCode = Number.isFinite(Number(manifest.appVersionCode)) ? String(Number(manifest.appVersionCode)) : "1";
  const display = String(manifest.display || "standalone").trim() || "standalone";
  const orientation = String(manifest.orientation || "portrait").trim() || "portrait";
  const themeColor = String(manifest.themeColor || "#F4F9F9").trim() || "#F4F9F9";
  const backgroundColor = String(manifest.backgroundColor || themeColor).trim() || themeColor;
  const iconUrl = String(manifest.iconUrl || "").trim();
  const maskableIconUrl = String(manifest.maskableIconUrl || "").trim();
  const includeShortcuts = Array.isArray(manifest.shortcuts) && manifest.shortcuts.length > 0 ? "Y" : "n";
  const keystorePath = path.join(String(process.env.USERPROFILE || process.env.HOME || ""), ".android", "facilitat-dev.keystore");
  const keyAlias = String(process.env.FACILITAT_KEY_ALIAS || "facilitat-dev").trim() || "facilitat-dev";

  return [
    "y",
    String(manifest.host || "acp-chat-beta.onrender.com").trim() || "acp-chat-beta.onrender.com",
    startPath,
    appName,
    launcherName,
    packageId,
    versionCode,
    display,
    orientation,
    themeColor,
    backgroundColor,
    iconUrl,
    maskableIconUrl,
    includeShortcuts,
    "",
    "N",
    "N",
    keystorePath,
    keyAlias
  ].join("\n") + "\n";
}

function checkBubblewrap() {
  try {
    execSync("bubblewrap --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function installBubblewrap() {
  console.log("[bubblewrap] Installing bubblewrap globally...");
  try {
    execSync("npm install -g @bubblewrap/cli", { stdio: "inherit" });
  } catch (err) {
    console.error("[bubblewrap] Failed to install bubblewrap:", err.message);
    console.error("[bubblewrap] Try installing manually: npm install -g @bubblewrap/cli");
    process.exit(1);
  }
}

function initBubblewrap(manifest) {
  const projectDir = path.join(__dirname, "..", "android-project");

  if (fs.existsSync(projectDir)) {
    console.log("[bubblewrap] Android project already exists at", projectDir);
    console.log("[bubblewrap] Remove it manually if you want to reinitialize:");
    console.log(`[bubblewrap]   rm -r "${projectDir}"`);
    return projectDir;
  }

  console.log("[bubblewrap] Initializing Android project...");

  const args = [
    "init",
    `--manifest=${manifest.webManifestUrl}`,
    `--directory=${projectDir}`,
    "--skipKeystoreGeneration"
  ];

  try {
    const bubblewrapCommand = process.platform === "win32" ? "bubblewrap.cmd" : "bubblewrap";
    const result = spawnSync(bubblewrapCommand, args, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      input: buildBubblewrapAnswers(manifest),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`bubblewrap init exited with code ${result.status || 1}`);
    }

    console.log("[bubblewrap] Project initialized at", projectDir);
    writeLocalProperties(projectDir);
    return projectDir;
  } catch (err) {
    console.error("[bubblewrap] Initialization failed:", err.message);
    process.exit(1);
  }
}

function main() {
  if (!checkBubblewrap()) {
    installBubblewrap();
  }

  const manifest = readTwaManifest();
  const projectDir = initBubblewrap(manifest);

  console.log("");
  console.log("[bubblewrap] Next steps:");
  console.log("");
  console.log("1. Review and adjust settings in the project:");
  console.log(`   cd "${projectDir}"`);
  console.log("   cat twa-manifest.json");
  console.log("");
  console.log("2. Build the Android App Bundle:");
  console.log("   bubblewrap build");
  console.log("");
  console.log("3. Apply persistent Android customizations (country picker styles, etc.):");
  console.log("   npm run android:apply-customizations");
  console.log("");
  console.log("4. Output file:");
  console.log("   dist/*.aab (ready to upload to Play Store)");
}

main();
