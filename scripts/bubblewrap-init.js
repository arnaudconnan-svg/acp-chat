const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function getTwaManifestPath() {
  return path.join(__dirname, "..", "twa-manifest.json");
}

function readTwaManifest() {
  const manifestPath = getTwaManifestPath();
  if (!fs.existsSync(manifestPath)) {
    console.error("[bubblewrap] twa-manifest.json not found. Run 'npm run twa:manifest' first.");
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
    `--manifest="${getTwaManifestPath()}"`,
    `--output="${projectDir}"`,
    "--skipKeystoreGeneration"
  ];

  try {
    const cmd = `bubblewrap init ${args.join(" ")}`;
    execSync(cmd, { stdio: "inherit", shell: true });
    console.log("[bubblewrap] Project initialized at", projectDir);
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
  console.log("3. Output file:");
  console.log("   dist/*.aab (ready to upload to Play Store)");
}

main();
