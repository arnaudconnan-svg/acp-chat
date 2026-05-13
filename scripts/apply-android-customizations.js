const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAUNCHER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'LauncherActivity.java');
const LAUNCHER_ACTIVITY_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'java', 'io', 'facilitat', 'app', 'LauncherActivity.java');
const BIOMETRIC_GATE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'BiometricGateActivity.java');
const BIOMETRIC_GATE_ACTIVITY_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'java', 'io', 'facilitat', 'app', 'BiometricGateActivity.java');
const SHORTCUT_ICON_TEMPLATE_PATH = path.join(__dirname, 'templates', 'shortcut_legacy_background.xml');
const SHORTCUT_ICON_TARGET_DIR = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'drawable');
const SHORTCUT_ICON_TARGET_PATH = path.join(SHORTCUT_ICON_TARGET_DIR, 'shortcut_legacy_background.xml');
const WEB_MANIFEST_PATH = path.join(ROOT, 'public', 'manifest.json');
const ANDROID_MANIFEST_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'AndroidManifest.xml');
const SHORTCUTS_XML_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
const SHORTCUT_STRINGS_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'values', 'shortcut_strings.xml');
const ANDROID_BUILD_GRADLE_PATH = path.join(ROOT, 'android-project', 'app', 'build.gradle');
const SHORTCUT_TARGET_CLASS = 'io.facilitat.app.BiometricGateActivity';

function toXmlEscaped(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeStartUrl(origin, startPath) {
  const safeOrigin = String(origin || '').replace(/\/+$/, '');
  const rawPath = String(startPath || '/').trim();
  const safePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${safeOrigin}${safePath}`;
}

function normalizeShortcutUrl(origin, rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return normalizeStartUrl(origin, value);
}

function readShortcutConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(WEB_MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.warn('[android-customize] Unable to read public/manifest.json for shortcuts: ' + err.message);
    return [];
  }

  const host = String(process.env.TWA_WEB_HOST || 'acp-chat-beta.onrender.com').trim();
  const protocol = String(process.env.TWA_WEB_PROTOCOL || 'https').trim();
  const origin = `${protocol}://${host}`;
  const shortcuts = Array.isArray(parsed.shortcuts) ? parsed.shortcuts : [];

  return shortcuts
    .map((item, index) => {
      const name = String(item && item.name ? item.name : '').trim();
      const shortName = String(item && item.short_name ? item.short_name : '').trim() || name;
      const shortcutUrl = normalizeShortcutUrl(origin, item && item.url);
      if (!name || !shortName || !shortcutUrl) {
        return null;
      }
      return {
        id: `shortcut_${index + 1}`,
        longLabel: name,
        shortLabel: shortName,
        url: shortcutUrl
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function writeShortcutsXml(shortcuts) {
  const lines = [
    '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">'
  ];

  for (const shortcut of shortcuts) {
    const shortLabelRef = `@string/${shortcut.id}_short_label`;
    const longLabelRef = `@string/${shortcut.id}_long_label`;
    lines.push(
      `    <shortcut android:shortcutId="${toXmlEscaped(shortcut.id)}" android:enabled="true" android:icon="@mipmap/ic_launcher" android:shortcutShortLabel="${shortLabelRef}" android:shortcutLongLabel="${longLabelRef}">`,
      `        <intent android:action="android.intent.action.VIEW" android:targetPackage="io.facilitat.app" android:targetClass="${SHORTCUT_TARGET_CLASS}" android:data="${toXmlEscaped(shortcut.url)}" />`,
      '    </shortcut>'
    );
  }

  lines.push('</shortcuts>');
  fs.writeFileSync(SHORTCUTS_XML_PATH, `${lines.join('\n')}\n`);
  console.log(`[android-customize] Synced shortcuts.xml (${shortcuts.length} shortcut(s)).`);
}

function writeShortcutStringResources(shortcuts) {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>'];

  for (const shortcut of shortcuts) {
    lines.push(
      `    <string name="${toXmlEscaped(shortcut.id)}_short_label">${toXmlEscaped(shortcut.shortLabel)}</string>`,
      `    <string name="${toXmlEscaped(shortcut.id)}_long_label">${toXmlEscaped(shortcut.longLabel)}</string>`
    );
  }

  lines.push('</resources>');
  fs.writeFileSync(SHORTCUT_STRINGS_PATH, `${lines.join('\n')}\n`);
  console.log(`[android-customize] Synced shortcut string resources (${shortcuts.length} shortcut(s)).`);
}

function toGroovySingleQuoted(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function syncBuildGradleShortcuts(shortcuts) {
  if (!fs.existsSync(ANDROID_BUILD_GRADLE_PATH)) {
    console.warn('[android-customize] app/build.gradle not found; skipping shortcuts sync.');
    return;
  }

  const shortcutRows = shortcuts.map((shortcut) => {
    const relativeUrl = (() => {
      try {
        const url = new URL(shortcut.url);
        return `${url.pathname}${url.search || ''}${url.hash || ''}` || '/';
      } catch (_) {
        return '/';
      }
    })();

    return `    [name: '${toGroovySingleQuoted(shortcut.longLabel)}', short_name: '${toGroovySingleQuoted(shortcut.shortLabel)}', url: '${toGroovySingleQuoted(relativeUrl)}', icon: 'shortcut_legacy_background']`;
  });

  const shortcutsBlock = shortcutRows.length > 0
    ? `    shortcuts: [\n${shortcutRows.join(',\n')}\n    ],`
    : '    shortcuts: [],';

  let gradle = fs.readFileSync(ANDROID_BUILD_GRADLE_PATH, 'utf8');
  const nextGradle = gradle.replace(
    /\s*shortcuts:\s*\[[\s\S]*?\],\s*\n\s*\/\/ The duration of fade out animation in milliseconds to be played when removing splash screen\./,
    `\n${shortcutsBlock}\n    // The duration of fade out animation in milliseconds to be played when removing splash screen.`
  );

  if (nextGradle === gradle) {
    console.warn('[android-customize] Could not update shortcuts block in app/build.gradle.');
  } else {
    gradle = nextGradle;
  }

  const targetClassPattern = /('android:targetClass':\s*)twaManifest\.applicationId \+ '\.LauncherActivity'/;
  const targetClassReplacement = `$1twaManifest.applicationId + '.BiometricGateActivity'`;
  const actionPattern = /('android:action':\s*)'android\.intent\.action\.MAIN'/;
  const actionReplacement = `$1'android.intent.action.MAIN'`;

  const withGateTarget = gradle.replace(targetClassPattern, targetClassReplacement).replace(actionPattern, actionReplacement);
  fs.writeFileSync(ANDROID_BUILD_GRADLE_PATH, withGateTarget, 'utf8');
  console.log(`[android-customize] Synced app/build.gradle shortcuts (${shortcuts.length} shortcut(s)).`);
}

function ensureManifestShortcutMetadata() {
  if (!fs.existsSync(ANDROID_MANIFEST_PATH)) {
    console.warn('[android-customize] AndroidManifest.xml not found; skipping shortcut metadata patch.');
    return;
  }

  let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  const gateShortcutMeta = '            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />\n';

  manifest = manifest.replace(/\n\s*<meta-data android:name="android\.app\.shortcuts" android:resource="@xml\/shortcuts" \/>\n/g, '\n');

  if (manifest.includes('<activity android:name="BiometricGateActivity"') && manifest.includes('android:name="android.app.shortcuts"')) {
    fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest, 'utf8');
    console.log('[android-customize] BiometricGateActivity shortcut metadata already present.');
    return;
  }

  const gateNeedle = '            android:theme="@android:style/Theme.Translucent.NoTitleBar">\n';
  const gateIndex = manifest.indexOf(gateNeedle);
  if (gateIndex === -1) {
    console.warn('[android-customize] Could not find BiometricGateActivity marker; skipping shortcut metadata patch.');
    return;
  }

  const insertAt = gateIndex + gateNeedle.length;
  manifest = `${manifest.slice(0, insertAt)}${gateShortcutMeta}${manifest.slice(insertAt)}`;
  fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest);
  console.log('[android-customize] Added android.app.shortcuts metadata to BiometricGateActivity.');
}

function syncShortcutIconDrawable() {
  if (!fs.existsSync(SHORTCUT_ICON_TEMPLATE_PATH)) {
    console.warn('[android-customize] Missing shortcut icon template: ' + SHORTCUT_ICON_TEMPLATE_PATH);
    return;
  }

  try {
    fs.mkdirSync(SHORTCUT_ICON_TARGET_DIR, { recursive: true });
    fs.copyFileSync(SHORTCUT_ICON_TEMPLATE_PATH, SHORTCUT_ICON_TARGET_PATH);
    console.log('[android-customize] Synced shortcut icon drawable.');
  } catch (err) {
    console.warn('[android-customize] Failed to sync shortcut icon drawable: ' + err.message);
  }
}

function ensureLauncherPortraitOrientation() {
  if (!fs.existsSync(ANDROID_MANIFEST_PATH)) {
    console.warn('[android-customize] AndroidManifest.xml not found; skipping orientation patch.');
    return;
  }

  let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  if (manifest.includes('android:name="LauncherActivity"') && manifest.includes('android:screenOrientation="portrait"')) {
    return;
  }

  const nextManifest = manifest.replace(
    /<activity android:name="LauncherActivity"(\s)/,
    '<activity android:name="LauncherActivity"\n            android:screenOrientation="portrait"$1'
  );

  if (nextManifest !== manifest) {
    fs.writeFileSync(ANDROID_MANIFEST_PATH, nextManifest, 'utf8');
    console.log('[android-customize] Added screenOrientation=portrait to LauncherActivity in AndroidManifest.xml.');
  }
}

function ensureBiometricDependency() {
  if (!fs.existsSync(ANDROID_BUILD_GRADLE_PATH)) {
    console.warn('[android-customize] app/build.gradle not found; skipping biometric dependency patch.');
    return;
  }

  const dependency = "implementation 'androidx.biometric:biometric:1.1.0'";
  let gradle = fs.readFileSync(ANDROID_BUILD_GRADLE_PATH, 'utf8');
  if (gradle.includes(dependency)) {
    return;
  }

  let nextGradle = gradle.replace(
    /(implementation 'com\.google\.androidbrowserhelper:androidbrowserhelper:2\.6\.2'\s*)/,
    `$1\n    ${dependency}\n`
  );

  if (nextGradle === gradle) {
    nextGradle = gradle.replace(/dependencies\s*\{/, `dependencies {\n    ${dependency}`);
  }

  if (nextGradle !== gradle) {
    fs.writeFileSync(ANDROID_BUILD_GRADLE_PATH, nextGradle, 'utf8');
    console.log('[android-customize] Added androidx.biometric dependency.');
  } else {
    console.warn('[android-customize] Could not patch biometric dependency in app/build.gradle.');
  }
}

function ensureBiometricGateManifestWiring() {
  if (!fs.existsSync(ANDROID_MANIFEST_PATH)) {
    console.warn('[android-customize] AndroidManifest.xml not found; skipping biometric gate patch.');
    return;
  }

  let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  const original = manifest;

  if (!manifest.includes('android:name="LauncherActivity"') || !manifest.includes('android:launchMode="singleTop"')) {
    manifest = manifest.replace(
      /<activity android:name="LauncherActivity"(\s)/,
      '<activity android:name="LauncherActivity"\n            android:launchMode="singleTop"$1'
    );
  }

  const launcherStart = manifest.indexOf('<activity android:name="LauncherActivity"');
  if (launcherStart !== -1) {
    const launcherEnd = manifest.indexOf('</activity>', launcherStart);
    if (launcherEnd !== -1) {
      const launcherBlock = manifest.slice(launcherStart, launcherEnd + '</activity>'.length);
      const nextLauncherBlock = launcherBlock.replace(
        /\n\s*<intent-filter>\s*\n\s*<action android:name="android.intent.action.MAIN" \/>\s*\n\s*<category android:name="android.intent.category.LAUNCHER" \/>\s*\n\s*<\/intent-filter>\n/,
        '\n'
      );
      manifest = `${manifest.slice(0, launcherStart)}${nextLauncherBlock}${manifest.slice(launcherEnd + '</activity>'.length)}`;
    }
  }

  if (!manifest.includes('android:name="BiometricGateActivity"')) {
    const insertionPoint = manifest.indexOf('<activity android:name="LauncherActivity"');
    if (insertionPoint !== -1) {
      const gateBlock = `        <activity android:name="BiometricGateActivity"\n            android:exported="true"\n            android:noHistory="true"\n            android:screenOrientation="portrait"\n            android:theme="@android:style/Theme.Translucent.NoTitleBar">\n            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />\n            <intent-filter>\n                <action android:name="android.intent.action.MAIN" />\n                <category android:name="android.intent.category.LAUNCHER" />\n            </intent-filter>\n\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="facilitat"\n                    android:host="biometric-config"\n                />\n            </intent-filter>\n        </activity>\n\n`;
      manifest = `${manifest.slice(0, insertionPoint)}${gateBlock}${manifest.slice(insertionPoint)}`;
    } else {
      console.warn('[android-customize] Could not find LauncherActivity insertion point for BiometricGateActivity.');
    }
  }

  manifest = manifest.replace(
    /(<activity android:name="BiometricGateActivity"[\s\S]*?)\n\s*android:excludeFromRecents="true"/,
    "$1"
  );

  if (manifest !== original) {
    fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest, 'utf8');
    console.log('[android-customize] Wired BiometricGateActivity and Launcher launchMode in AndroidManifest.xml.');
  }
}

function syncJavaTemplate(templatePath, targetPath, label) {
  if (!fs.existsSync(templatePath)) {
    console.error(`[android-customize] Missing template: ${templatePath}`);
    process.exit(1);
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(templatePath, targetPath);
    console.log(`[android-customize] ${label} already up to date.`);
  } catch (err) {
    console.error(`[android-customize] Failed to copy ${label}: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  console.log('[android-customize] Applying persistent Android customizations...');

  syncJavaTemplate(LAUNCHER_TEMPLATE_PATH, LAUNCHER_ACTIVITY_PATH, 'LauncherActivity');
  syncJavaTemplate(BIOMETRIC_GATE_TEMPLATE_PATH, BIOMETRIC_GATE_ACTIVITY_PATH, 'BiometricGateActivity');

  const shortcuts = readShortcutConfig();
  syncBuildGradleShortcuts(shortcuts);
  ensureBiometricDependency();
  syncShortcutIconDrawable();
  writeShortcutStringResources(shortcuts);
  writeShortcutsXml(shortcuts);
  ensureManifestShortcutMetadata();
  ensureLauncherPortraitOrientation();
  ensureBiometricGateManifestWiring();

  console.log('[android-customize] Done.');
}

main();
