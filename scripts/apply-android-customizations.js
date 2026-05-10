const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(__dirname, "templates", "CountryPickerActivity.java");
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
