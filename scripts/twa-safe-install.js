const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ASSETLINKS_PATH = path.join(ROOT, "public", ".well-known", "assetlinks.json");
const DEFAULT_PACKAGE = "io.facilitat.app";

function fail(message) {
  console.error(`[twa:safe-install] ${message}`);
  process.exit(1);
}

function readAssetLinks() {
  if (!fs.existsSync(ASSETLINKS_PATH)) {
    fail(`Missing ${ASSETLINKS_PATH}`);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(ASSETLINKS_PATH, "utf8"));
    if (!Array.isArray(parsed)) fail("assetlinks.json must be a JSON array.");
    return parsed;
  } catch (err) {
    fail(`Invalid assetlinks.json: ${err.message}`);
  }
}

function getExpectedFingerprints(assetLinks, packageName) {
  const entry = assetLinks.find(
    (item) =>
      item &&
      item.target &&
      item.target.namespace === "android_app" &&
      item.target.package_name === packageName &&
      Array.isArray(item.target.sha256_cert_fingerprints)
  );

  if (!entry) {
    fail(`No android_app entry for package '${packageName}' in assetlinks.json.`);
  }

  const values = entry.target.sha256_cert_fingerprints
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);

  if (values.length === 0) {
    fail("No SHA-256 fingerprints found in assetlinks entry.");
  }

  return values;
}

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return "";
}

function pickApkPath() {
  const fromArg = parseArg("--apk");
  if (fromArg) {
    const absolute = path.resolve(ROOT, fromArg);
    if (!fs.existsSync(absolute)) fail(`APK not found: ${absolute}`);
    return absolute;
  }

  const candidates = [
    path.join(ROOT, "android-project", "app", "build", "outputs", "apk", "release", "app-release.apk"),
    path.join(ROOT, "android-project", "app", "build", "outputs", "apk", "debug", "app-debug.apk")
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail("No APK found. Build one first (release recommended). Use --apk <path> if needed.");
  }
  return found;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function getApkFingerprint(apkPath) {
  const result = run("keytool", ["-printcert", "-jarfile", apkPath]);
  if (result.status !== 0) {
    fail(`keytool failed for '${apkPath}'. stderr: ${String(result.stderr || "").trim()}`);
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = output.match(/SHA\s*-?\s*256\s*:\s*([0-9A-F:]{32,})/i);
  if (!match) {
    fail("Unable to parse APK SHA-256 fingerprint from keytool output.");
  }

  return match[1].trim().toUpperCase();
}

function resolveAdbPath() {
  const fromEnv = String(process.env.ADB_PATH || "").trim();
  if (fromEnv) return fromEnv;

  if (process.platform === "win32") {
    const localAppData = String(process.env.LOCALAPPDATA || "").trim();
    if (localAppData) {
      const candidate = path.join(localAppData, "Android", "Sdk", "platform-tools", "adb.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
    return "adb.exe";
  }

  return "adb";
}

function ensureDevice(adbPath) {
  const result = run(adbPath, ["devices"]);
  if (result.status !== 0) {
    fail(`adb devices failed. stderr: ${String(result.stderr || "").trim()}`);
  }

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("list of devices"));

  const online = lines.some((line) => /\sdevice$/i.test(line));
  if (!online) {
    fail("No Android device detected by adb.");
  }
}

function installApk(adbPath, apkPath) {
  const result = run(adbPath, ["install", "-r", apkPath]);
  process.stdout.write(String(result.stdout || ""));
  process.stderr.write(String(result.stderr || ""));

  if (result.status !== 0) {
    fail("adb install failed.");
  }
}

function main() {
  const packageName = String(process.env.TWA_ANDROID_PACKAGE || DEFAULT_PACKAGE).trim() || DEFAULT_PACKAGE;
  const assetLinks = readAssetLinks();
  const expected = getExpectedFingerprints(assetLinks, packageName);
  const apkPath = pickApkPath();
  const apkFingerprint = getApkFingerprint(apkPath);

  if (!expected.includes(apkFingerprint)) {
    console.error(`[twa:safe-install] APK fingerprint: ${apkFingerprint}`);
    console.error(`[twa:safe-install] Allowed by assetlinks.json: ${expected.join(", ")}`);
    fail(
      "Refusing install: this APK is not trusted by Digital Asset Links. It would show browser UI instead of full TWA."
    );
  }

  const adbPath = resolveAdbPath();
  ensureDevice(adbPath);
  installApk(adbPath, apkPath);
  console.log("[twa:safe-install] APK installed with trusted signature.");
}

main();
