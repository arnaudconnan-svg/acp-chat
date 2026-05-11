#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function fail(message) {
  console.error(`[android:keep-awake] ${message}`);
  process.exit(1);
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8" });
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

function runShell(adbPath, shellCommand) {
  const result = run(adbPath, ["shell", ...shellCommand]);
  if (result.status !== 0) {
    fail(`adb shell ${shellCommand.join(" ")} failed. stderr: ${String(result.stderr || "").trim()}`);
  }
  return result;
}

function printStatus(adbPath) {
  const result = runShell(adbPath, ["settings", "get", "global", "stay_on_while_plugged_in"]);
  const rawValue = String(result.stdout || "").trim();
  const value = Number.parseInt(rawValue, 10);
  const enabled = Number.isFinite(value) && value > 0;

  console.log(`[android:keep-awake] stay_on_while_plugged_in=${rawValue || "(empty)"}`);
  console.log(enabled
    ? "[android:keep-awake] Device will stay awake while plugged in."
    : "[android:keep-awake] Device can sleep normally.");
}

function enableKeepAwake(adbPath) {
  runShell(adbPath, ["svc", "power", "stayon", "true"]);
  runShell(adbPath, ["settings", "put", "global", "stay_on_while_plugged_in", "7"]);
  runShell(adbPath, ["input", "keyevent", "KEYCODE_WAKEUP"]);
  console.log("[android:keep-awake] Enabled. Device should stay awake while plugged in and connected over adb.");
  printStatus(adbPath);
}

function disableKeepAwake(adbPath) {
  runShell(adbPath, ["svc", "power", "stayon", "false"]);
  runShell(adbPath, ["settings", "put", "global", "stay_on_while_plugged_in", "0"]);
  console.log("[android:keep-awake] Disabled. Device can sleep normally again.");
  printStatus(adbPath);
}

function main() {
  const action = String(process.argv[2] || "status").trim().toLowerCase();
  if (!["on", "off", "status"].includes(action)) {
    console.log("Usage: node scripts/android-keep-awake.js [on|off|status]");
    process.exit(1);
  }

  const adbPath = resolveAdbPath();
  ensureDevice(adbPath);

  if (action === "on") {
    enableKeepAwake(adbPath);
    return;
  }

  if (action === "off") {
    disableKeepAwake(adbPath);
    return;
  }

  printStatus(adbPath);
}

main();