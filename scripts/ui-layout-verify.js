const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX_HTML = path.join(ROOT, "public", "index.html");

function fail(message) {
  console.error(`[ui-layout-verify] ${message}`);
  process.exit(1);
}

function main() {
  console.log("[ui-layout-verify] Checking welcome screen layout constraints...");

  if (!fs.existsSync(INDEX_HTML)) {
    fail(`Missing ${INDEX_HTML}`);
  }

  const html = fs.readFileSync(INDEX_HTML, "utf8");

  // Check 1: welcomeScreen must have overflow: hidden (not auto, not scroll)
  const welcomeScreenRegex = /#welcomeScreen\s*\{[^}]*\}/s;
  const welcomeScreenMatch = html.match(welcomeScreenRegex);

  if (!welcomeScreenMatch) {
    fail("Cannot find #welcomeScreen CSS block");
  }

  const welcomeScreenCss = welcomeScreenMatch[0];

  // Verify no overflow-y: auto
  if (/overflow-y\s*:\s*auto/i.test(welcomeScreenCss)) {
    fail(
      "#welcomeScreen must not have 'overflow-y: auto'. " +
      "This causes unwanted scroll in TWA. Use 'overflow: hidden' instead."
    );
  }

  // Verify overflow is hidden or not overflow-y specific
  const overflowMatches = welcomeScreenCss.match(/overflow[^:]*:\s*([^;]+)/g);
  let hasHiddenOverflow = false;

  if (overflowMatches) {
    for (const match of overflowMatches) {
      if (/hidden|clip/i.test(match)) {
        hasHiddenOverflow = true;
        break;
      }
    }
  }

  if (!hasHiddenOverflow) {
    console.warn("[ui-layout-verify] Warning: #welcomeScreen should have overflow: hidden");
  }

  // Check 2: welcomeInner must not have min-height: 100%
  const welcomeInnerRegex = /#welcomeInner\s*\{[^}]*\}/s;
  const welcomeInnerMatch = html.match(welcomeInnerRegex);

  if (!welcomeInnerMatch) {
    fail("Cannot find #welcomeInner CSS block");
  }

  const welcomeInnerCss = welcomeInnerMatch[0];

  if (/min-height\s*:\s*100%/i.test(welcomeInnerCss)) {
    fail(
      "#welcomeInner must not have 'min-height: 100%'. " +
      "This causes content overflow in TWA. Use 'max-height: 100%' instead."
    );
  }

  // Check 3: welcomeInner should have overflow: hidden to prevent scroll
  if (!/overflow\s*:\s*hidden/i.test(welcomeInnerCss)) {
    console.warn("[ui-layout-verify] Warning: #welcomeInner should have overflow: hidden");
  }

  console.log("[ui-layout-verify] All layout constraints passed.");
}

main();
