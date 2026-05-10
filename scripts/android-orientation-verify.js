const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const SOURCE_CHECKS = [
  {
    file: path.join(ROOT, "public", "manifest.json"),
    label: "public manifest orientation",
    test: (content) => /"orientation"\s*:\s*"portrait"/m.test(content),
    expected: '"orientation": "portrait"'
  },
  {
    file: path.join(ROOT, "twa-manifest.json"),
    label: "root twa-manifest orientation",
    test: (content) => /"orientation"\s*:\s*"portrait"/m.test(content),
    expected: '"orientation": "portrait"'
  },
  {
    file: path.join(ROOT, "android-project", "twa-manifest.json"),
    label: "android-project twa-manifest orientation",
    test: (content) => /"orientation"\s*:\s*"portrait"/m.test(content),
    expected: '"orientation": "portrait"',
    optional: true
  },
  {
    file: path.join(ROOT, "android-project", "app", "build.gradle"),
    label: "android build.gradle orientation",
    test: (content) => /orientation:\s*'portrait'/m.test(content),
    expected: "orientation: 'portrait'"
  },
  {
    file: path.join(ROOT, "android-project", "app", "src", "main", "AndroidManifest.xml"),
    label: "launcher manifest screenOrientation",
    test: (content) => /<activity android:name="LauncherActivity"[\s\S]*?android:screenOrientation="portrait"/m.test(content),
    expected: 'LauncherActivity with android:screenOrientation="portrait"'
  }
];

const GENERATED_CHECKS = [
  {
    file: path.join(ROOT, "android-project", "app", "build", "generated", "res", "resValues", "release", "values", "gradleResValues.xml"),
    label: "generated orientation resource",
    test: (content) => /<string name="orientation" translatable="false">portrait<\/string>/m.test(content),
    expected: "generated orientation string must be portrait"
  }
];

function fail(message) {
  console.error(`[android-orientation-verify] ${message}`);
  process.exit(1);
}

function runChecks(checks, mode) {
  for (const check of checks) {
    if (!fs.existsSync(check.file)) {
      if (check.optional) {
        console.log(`[android-orientation-verify] Skip optional check (${check.label}): ${check.file}`);
        continue;
      }
      fail(`Missing required file for ${mode} check: ${check.file}`);
    }

    const content = fs.readFileSync(check.file, "utf8");
    if (!check.test(content)) {
      fail(`Check failed (${check.label}). Expected ${check.expected} in ${check.file}`);
    }
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const sourceOnly = args.has("--source-only");
  const generatedOnly = args.has("--generated-only");

  if (sourceOnly && generatedOnly) {
    fail("Use either --source-only or --generated-only, not both.");
  }

  if (!generatedOnly) {
    runChecks(SOURCE_CHECKS, "source");
  }

  if (!sourceOnly) {
    runChecks(GENERATED_CHECKS, "generated");
  }

  console.log("[android-orientation-verify] OK");
}

main();