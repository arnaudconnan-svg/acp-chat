const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ANDROID_PROJECT = path.join(ROOT, "android-project");
const EXPECTED_DIMS = {
  mdpi: 82,
  hdpi: 123,
  xhdpi: 164,
  xxhdpi: 246,
  xxxhdpi: 328
};

function fail(message) {
  console.error(`[android-icon-verify] ${message}`);
  process.exit(1);
}

function getMipmap(dpi) {
  return path.join(ANDROID_PROJECT, "app", "src", "main", "res", `mipmap-${dpi}`, "ic_maskable.png");
}

function getImageDimensions(imagePath) {
  if (!fs.existsSync(imagePath)) {
    return null;
  }

  try {
    const result = execSync(`magick identify -format "%w,%h" "${imagePath}" 2>nul`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    if (!result) return null;
    const [w, h] = result.split(",").map(Number);
    return { width: w, height: h };
  } catch (_) {
    return null;
  }
}

function verifySingleMipmap(dpi) {
  const expected = EXPECTED_DIMS[dpi];
  const filePath = getMipmap(dpi);

  if (!fs.existsSync(filePath)) {
    fail(`Missing mipmap-${dpi}/ic_maskable.png`);
  }

  const size = fs.statSync(filePath).size;
  if (size < 1000) {
    fail(`mipmap-${dpi}/ic_maskable.png is too small (${size} bytes, likely corrupted)`);
  }

  const dims = getImageDimensions(filePath);
  if (dims && (dims.width !== expected || dims.height !== expected)) {
    fail(
      `mipmap-${dpi}/ic_maskable.png has wrong dimensions: ${dims.width}x${dims.height}px ` +
      `(expected ${expected}x${expected}px). Run npm run android:icon:generate.`
    );
  }

  console.log(`OK   mipmap-${dpi}: ${size} bytes`);
  return true;
}

function main() {
  console.log("[android-icon-verify] Checking adaptive icon maskable resources...");

  let allGood = true;
  for (const dpi of Object.keys(EXPECTED_DIMS)) {
    try {
      verifySingleMipmap(dpi);
    } catch (err) {
      allGood = false;
      console.error(`FAIL mipmap-${dpi}: ${err.message}`);
    }
  }

  if (!allGood) {
    fail("Icon verification failed. Refusing build.");
  }

  console.log("[android-icon-verify] All icon resources valid. Build can proceed.");
}

main();
