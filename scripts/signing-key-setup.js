const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function checkKeytool() {
  try {
    execSync("keytool -version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getKeystorePath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return path.join(home, ".android", "facilitat-dev.keystore");
}

function createKeystore(keystorePath) {
  const keystoreDir = path.dirname(keystorePath);
  if (!fs.existsSync(keystoreDir)) {
    fs.mkdirSync(keystoreDir, { recursive: true });
  }

  console.log("[signing-key] Generating keystore...");

  try {
    const cmd = [
      "keytool",
      "-genkey",
      "-v",
      `-keystore "${keystorePath}"`,
      "-keyalg RSA",
      "-keysize 2048",
      "-validity 10000",
      "-alias facilitat-dev",
      "-storepass facilitat123",
      "-keypass facilitat123",
      '-dname "CN=Facilitat Dev,O=Facilitat,C=FR"'
    ].join(" ");

    execSync(cmd, { stdio: "inherit", shell: true });
    console.log("[signing-key] Keystore created successfully.");
  } catch (err) {
    console.error("[signing-key] Failed to create keystore:", err.message);
    process.exit(1);
  }
}

function extractSHA256(keystorePath) {
  console.log("[signing-key] Extracting SHA256 fingerprint...");

  try {
    const cmd = `keytool -list -v -keystore "${keystorePath}" -alias facilitat-dev -storepass facilitat123`;
    const output = execSync(cmd, { encoding: "utf8" });

    const sha256Match = output.match(/SHA256:\s*([A-F0-9:]+)/i);
    if (sha256Match) {
      return sha256Match[1];
    } else {
      console.error("[signing-key] Could not extract SHA256 from keystore");
      process.exit(1);
    }
  } catch (err) {
    console.error("[signing-key] Error reading keystore:", err.message);
    process.exit(1);
  }
}

function generateAssetlinks(sha256) {
  const packageName = String(process.env.TWA_ANDROID_PACKAGE || "io.facilitat.app").trim();
  const fingerprints = sha256
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean);

  const assetLinksContent = [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints
      }
    }
  ];

  const outputPath = path.join(__dirname, "..", "public", ".well-known", "assetlinks.json");
  const outputDir = path.dirname(outputPath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(assetLinksContent, null, 2)}\n`, "utf8");
  console.log("[signing-key] Generated assetlinks at", outputPath);
}

function main() {
  if (!checkKeytool()) {
    console.error("[signing-key] keytool not found. Java/JDK is required.");
    console.error("");
    console.error("To install OpenJDK 21, run:");
    console.error("");
    console.error("  powershell -ExecutionPolicy Bypass -File scripts/jdk-setup.ps1 -Install");
    console.error("");
    console.error("Or install manually:");
    console.error("  - Microsoft Store: Search 'OpenJDK' or 'Temurin'");
    console.error("  - Chocolatey: choco install openjdk21");
    console.error("  - Direct: https://adoptium.net/ (Temurin JDK 21)");
    console.error("");
    console.error("After installation, restart PowerShell and run:");
    console.error("  npm run twa:signing-key");
    console.error("");
    process.exit(1);
  }

  const keystorePath = getKeystorePath();

  if (!fs.existsSync(keystorePath)) {
    createKeystore(keystorePath);
  } else {
    console.log("[signing-key] Found existing keystore at", keystorePath);
  }

  const sha256 = extractSHA256(keystorePath);
  console.log("[signing-key] SHA256 fingerprint:");
  console.log("");
  console.log(sha256);
  console.log("");

  generateAssetlinks(sha256);

  console.log("[signing-key] Setup complete. assetlinks.json is ready.");
}

main();
