const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROJECT_DIR = path.join(ROOT, "android-project");

function fail(message) {
  console.error(`[android-rebuild] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  let resolvedCommand = command;
  let resolvedArgs = args;

  if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
    resolvedCommand = process.env.ComSpec || "cmd.exe";
    resolvedArgs = ["/d", "/s", "/c", command, ...args];
  }

  const result = spawnSync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd || ROOT,
    stdio: "inherit",
    shell: false
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runNpm(args) {
  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (npmExecPath) {
    run(process.execPath, [npmExecPath, ...args]);
    return;
  }
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npmCmd, args);
}

function removeAndroidProject() {
  if (!fs.existsSync(PROJECT_DIR)) {
    console.log("[android-rebuild] android-project does not exist. Skipping cleanup.");
    return;
  }

  console.log("[android-rebuild] Removing android-project to avoid stale local artifacts...");
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
}

function main() {
  removeAndroidProject();

  console.log("[android-rebuild] Regenerating Android project from twa-manifest...");
  runNpm(["run", "twa:build"]);

  console.log("[android-rebuild] Deploying release APK from clean Android state...");
  runNpm(["run", "android:deploy:release"]);

  console.log("[android-rebuild] Done.");
}

main();