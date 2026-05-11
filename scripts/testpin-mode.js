#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const action = String(process.argv[2] || "").trim().toLowerCase();
const packageName = "io.facilitat.app";

function fail(message) {
  console.error(`[testpin:mode] ${message}`);
  process.exit(1);
}

function getSdkRoot() {
  const candidates = [
    String(process.env.ANDROID_SDK_ROOT || "").trim(),
    String(process.env.ANDROID_HOME || "").trim(),
    path.join(String(process.env.LOCALAPPDATA || "").trim(), "Android", "Sdk"),
    path.join(String(process.env.USERPROFILE || "").trim(), ".bubblewrap", "android_sdk")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  fail("Unable to locate Android SDK. Set ANDROID_SDK_ROOT or ANDROID_HOME.");
}

function resolveAdbPath() {
  const sdkRoot = getSdkRoot();
  const adbPath = process.platform === "win32"
    ? path.join(sdkRoot, "platform-tools", "adb.exe")
    : path.join(sdkRoot, "platform-tools", "adb");

  if (!fs.existsSync(adbPath)) {
    fail(`Missing adb in Android SDK: ${adbPath}`);
  }

  return adbPath;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
}

function ensureDevice(adbPath) {
  const result = run(adbPath, ["devices"]);
  if (result.status !== 0) {
    fail(`adb devices failed. stderr: ${String(result.stderr || "").trim()}`);
  }

  const lines = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.toLowerCase().startsWith("list of devices"));

  const online = lines.some((line) => /\sdevice$/i.test(line));
  if (!online) {
    fail("No Android device detected by adb.");
  }
}

function printUsage() {
  console.log(`
Usage: npm run testpin:mode -- enable|disable|status

Examples:
  npm run testpin:mode -- enable
  npm run testpin:mode -- disable
  npm run testpin:mode -- status
`);
}

function applyMode(adbPath, enabled) {
  const result = run(adbPath, [
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    `${packageName}/.BiometricConfigActivity`,
    "--es",
    "enabled",
    "1",
    "--ei",
    "relock",
    "300",
    "--es",
    "test_pin_mode",
    enabled ? "1" : "0",
    "--es",
    "test_pin_auto_accept",
    enabled ? "1" : "0"
  ]);

  process.stdout.write(String(result.stdout || ""));
  process.stderr.write(String(result.stderr || ""));

  if (result.status !== 0) {
    fail(`Failed to ${enabled ? "enable" : "disable"} test PIN mode via BiometricConfigActivity.`);
  }

  console.log(`[testpin:mode] Test PIN mode ${enabled ? "enabled" : "disabled"}. PIN code: 999999`);
}

function printStatus() {
  console.log("[testpin:mode] Status is not readable directly over adb without app-side reporting.");
  console.log("[testpin:mode] Use a launch test and read logcat for 'test pin mode enabled'.");
}

if (!["enable", "disable", "status"].includes(action)) {
  printUsage();
  process.exit(1);
}

const adbPath = resolveAdbPath();
ensureDevice(adbPath);

if (action === "status") {
  printStatus();
  process.exit(0);
}

applyMode(adbPath, action === "enable");
