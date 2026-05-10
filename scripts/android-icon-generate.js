const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ANDROID_PROJECT = path.join(ROOT, "android-project");
const SOURCE_ICON = path.join(ROOT, "public", "images", "icon-512-maskable.png");
const DENSITIES = {
  mdpi: 82,
  hdpi: 123,
  xhdpi: 164,
  xxhdpi: 246,
  xxxhdpi: 328
};

function fail(message) {
  console.error(`[android-icon-generate] ${message}`);
  process.exit(1);
}

function checkImageMagick() {
  try {
    execSync("magick --version", { stdio: "pipe" });
    return true;
  } catch (_) {
    try {
      execSync("convert --version", { stdio: "pipe" });
      return true;
    } catch (__) {
      return false;
    }
  }
}

function generateMipmap(dpi, size) {
  const outDir = path.join(ANDROID_PROJECT, "app", "src", "main", "res", `mipmap-${dpi}`);
  const outFile = path.join(outDir, "ic_maskable.png");

  fs.mkdirSync(outDir, { recursive: true });

  try {
    execSync(`magick convert "${SOURCE_ICON}" -resize ${size}x${size} "${outFile}"`, {
      stdio: "pipe",
      shell: true
    });
    const size_bytes = fs.statSync(outFile).size;
    console.log(`Generated: mipmap-${dpi}/ic_maskable.png (${size_bytes} bytes)`);
  } catch (err) {
    fail(`Failed to generate mipmap-${dpi}: ${err.message}`);
  }
}

function main() {
  if (!fs.existsSync(SOURCE_ICON)) {
    fail(`Source icon not found: ${SOURCE_ICON}`);
  }

  if (!checkImageMagick()) {
    fail(
      "ImageMagick not found. Install it or download pre-generated mipmap files. " +
      "On Windows: choco install imagemagick-7.q16"
    );
  }

  console.log(`[android-icon-generate] Regenerating mipmap from ${path.basename(SOURCE_ICON)}...`);

  for (const [dpi, size] of Object.entries(DENSITIES)) {
    generateMipmap(dpi, size);
  }

  console.log("[android-icon-generate] All mipmaps regenerated.");
}

main();
