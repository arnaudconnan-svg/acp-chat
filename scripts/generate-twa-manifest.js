const fs = require("fs");
const path = require("path");

function normalizeFingerprints(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toUpperCase());
}

function normalizeStartUrl(origin, startPath) {
  const safeOrigin = origin.replace(/\/+$/, "");
  const safePath = String(startPath || "/").startsWith("/")
    ? String(startPath || "/")
    : `/${String(startPath || "/")}`;
  return `${safeOrigin}${safePath}`;
}

function main() {
  const packageId = String(process.env.TWA_ANDROID_PACKAGE || "io.facilitat.app").trim();
  const host = String(process.env.TWA_WEB_HOST || "acp-chat-beta.onrender.com").trim();
  const protocol = String(process.env.TWA_WEB_PROTOCOL || "https").trim();
  const startPath = String(process.env.TWA_START_PATH || "/").trim();
  const appName = String(process.env.TWA_APP_NAME || "Facilitat.io").trim();
  const launcherName = String(process.env.TWA_LAUNCHER_NAME || "Facilitat").trim();
  const themeColor = String(process.env.TWA_THEME_COLOR || "#f4f9f9").trim();
  const backgroundColor = String(process.env.TWA_BACKGROUND_COLOR || "#f4f9f9").trim();
  const fingerprints = normalizeFingerprints(process.env.TWA_SHA256_FINGERPRINTS || "");

  if (!packageId) {
    console.error("[twa-manifest] Missing TWA_ANDROID_PACKAGE env var.");
    process.exit(1);
  }

  if (!host) {
    console.error("[twa-manifest] Missing TWA_WEB_HOST env var.");
    process.exit(1);
  }

  const fullOrigin = `${protocol}://${host}`;
  const manifest = {
    packageId,
    host,
    name: appName,
    launcherName,
    display: "standalone",
    themeColor,
    navigationColor: themeColor,
    backgroundColor,
    startUrl: normalizeStartUrl(fullOrigin, startPath),
    iconUrl: `${fullOrigin}/images/icon-512.png`,
    maskableIconUrl: `${fullOrigin}/images/icon-512-maskable.png`,
    appVersionName: "1.0.0",
    appVersionCode: 1,
    enableNotifications: false,
    shortcuts: [],
    generatorApp: "bubblewrap",
    webManifestUrl: `${fullOrigin}/manifest.json`,
    fallbackType: "customtabs"
  };

  if (fingerprints.length > 0) {
    manifest.signingKey = {
      fingerprints
    };
  }

  const outputPath = path.join(__dirname, "..", "twa-manifest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`[twa-manifest] Generated ${outputPath}`);
  console.log(`[twa-manifest] Host: ${host}`);
  console.log(`[twa-manifest] Start URL: ${manifest.startUrl}`);
}

main();
