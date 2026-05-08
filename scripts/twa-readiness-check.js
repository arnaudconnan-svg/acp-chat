const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const manifestPath = path.join(publicDir, "manifest.json");
const assetLinksPath = path.join(publicDir, ".well-known", "assetlinks.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function check(condition, okMessage, failMessage) {
  if (condition) {
    console.log(`OK   ${okMessage}`);
    return true;
  }
  console.error(`FAIL ${failMessage}`);
  return false;
}

function main() {
  let allGood = true;

  allGood = check(fs.existsSync(manifestPath), "manifest.json present", "manifest.json missing") && allGood;
  if (!fs.existsSync(manifestPath)) {
    process.exit(1);
  }

  const manifest = readJson(manifestPath);

  allGood = check(typeof manifest.name === "string" && manifest.name.trim().length > 0, "manifest name set", "manifest name missing") && allGood;
  allGood = check(typeof manifest.short_name === "string" && manifest.short_name.trim().length > 0, "manifest short_name set", "manifest short_name missing") && allGood;
  allGood = check(typeof manifest.start_url === "string" && manifest.start_url.startsWith("/"), "manifest start_url starts with /", "manifest start_url invalid") && allGood;
  allGood = check(typeof manifest.scope === "string" && manifest.scope.startsWith("/"), "manifest scope starts with /", "manifest scope invalid") && allGood;
  allGood = check(typeof manifest.id === "string" && manifest.id.startsWith("/"), "manifest id starts with /", "manifest id invalid") && allGood;
  allGood = check(manifest.display === "standalone" || manifest.display === "fullscreen", "manifest display suitable for install", "manifest display should be standalone/fullscreen") && allGood;
  allGood = check(typeof manifest.theme_color === "string" && manifest.theme_color.length > 0, "manifest theme_color set", "manifest theme_color missing") && allGood;
  allGood = check(typeof manifest.background_color === "string" && manifest.background_color.length > 0, "manifest background_color set", "manifest background_color missing") && allGood;

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const icon192 = icons.find((item) => item && item.sizes === "192x192");
  const icon512 = icons.find((item) => item && item.sizes === "512x512");

  allGood = check(Boolean(icon192), "manifest has 192x192 icon entry", "manifest missing 192x192 icon") && allGood;
  allGood = check(Boolean(icon512), "manifest has 512x512 icon entry", "manifest missing 512x512 icon") && allGood;

  if (icon192 && typeof icon192.src === "string") {
    allGood = check(fs.existsSync(path.join(publicDir, icon192.src.replace(/^\//, ""))), "icon 192 file exists", `icon 192 file missing at ${icon192.src}`) && allGood;
  }

  if (icon512 && typeof icon512.src === "string") {
    allGood = check(fs.existsSync(path.join(publicDir, icon512.src.replace(/^\//, ""))), "icon 512 file exists", `icon 512 file missing at ${icon512.src}`) && allGood;
  }

  allGood = check(fs.existsSync(path.join(publicDir, "sw.js")), "service worker file present", "public/sw.js missing") && allGood;
  allGood = check(fs.existsSync(assetLinksPath), "assetlinks file present", "public/.well-known/assetlinks.json missing") && allGood;

  if (fs.existsSync(assetLinksPath)) {
    try {
      const parsed = readJson(assetLinksPath);
      allGood = check(Array.isArray(parsed), "assetlinks contains a JSON array", "assetlinks must be a JSON array") && allGood;
    } catch (err) {
      allGood = check(false, "", `assetlinks invalid JSON: ${err.message}`) && allGood;
    }
  }

  if (!allGood) {
    process.exit(1);
  }

  console.log("TWA readiness baseline checks passed.");
}

main();
