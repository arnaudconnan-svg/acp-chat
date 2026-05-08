const fs = require("fs");
const path = require("path");

function normalizeFingerprints(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.toUpperCase());
}

function buildAssetLinks(packageName, fingerprints) {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints
      }
    }
  ];
}

function main() {
  const packageName = String(process.env.TWA_ANDROID_PACKAGE || "").trim();
  const fingerprints = normalizeFingerprints(process.env.TWA_SHA256_FINGERPRINTS || "");

  if (!packageName) {
    console.error("[assetlinks] Missing TWA_ANDROID_PACKAGE env var.");
    process.exit(1);
  }

  if (fingerprints.length === 0) {
    console.error("[assetlinks] Missing TWA_SHA256_FINGERPRINTS env var.");
    process.exit(1);
  }

  const outputPath = path.join(__dirname, "..", "public", ".well-known", "assetlinks.json");
  const payload = buildAssetLinks(packageName, fingerprints);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`[assetlinks] Generated ${outputPath}`);
}

main();
