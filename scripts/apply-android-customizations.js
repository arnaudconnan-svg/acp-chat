const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAUNCHER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'LauncherActivity.java');
const LAUNCHER_ACTIVITY_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'java', 'io', 'facilitat', 'app', 'LauncherActivity.java');
const SHORTCUT_ICON_TEMPLATE_PATH = path.join(__dirname, 'templates', 'shortcut_legacy_background.xml');
const SHORTCUT_ICON_TARGET_DIR = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'drawable');
const SHORTCUT_ICON_TARGET_PATH = path.join(SHORTCUT_ICON_TARGET_DIR, 'shortcut_legacy_background.xml');
const WEB_MANIFEST_PATH = path.join(ROOT, 'public', 'manifest.json');
const ANDROID_MANIFEST_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'AndroidManifest.xml');
const SHORTCUTS_XML_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
const SHORTCUT_STRINGS_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'res', 'values', 'shortcut_strings.xml');
const ANDROID_BUILD_GRADLE_PATH = path.join(ROOT, 'android-project', 'app', 'build.gradle');

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
      `        <intent android:action="android.intent.action.VIEW" android:targetPackage="io.facilitat.app" android:targetClass="io.facilitat.app.LauncherActivity" android:data="${toXmlEscaped(shortcut.url)}" />`,
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
    return;
  }

  fs.writeFileSync(ANDROID_BUILD_GRADLE_PATH, nextGradle);
  console.log(`[android-customize] Synced app/build.gradle shortcuts (${shortcuts.length} shortcut(s)).`);
}

function ensureManifestShortcutMetadata() {
  if (!fs.existsSync(ANDROID_MANIFEST_PATH)) {
    console.warn('[android-customize] AndroidManifest.xml not found; skipping shortcut metadata patch.');
    return;
  }

  let manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  if (manifest.includes('android:name="android.app.shortcuts"')) {
    console.log('[android-customize] LauncherActivity shortcut metadata already present.');
    return;
  }

  const launcherMetaNeedle = '<meta-data android:name="android.support.customtabs.trusted.SCREEN_ORIENTATION"';
  const launcherMetaInsert = '            <meta-data android:name="android.app.shortcuts"\n                android:resource="@xml/shortcuts" />\n';

  const markerIndex = manifest.indexOf(launcherMetaNeedle);
  if (markerIndex === -1) {
    console.warn('[android-customize] Could not find LauncherActivity metadata marker; skipping shortcut metadata patch.');
    return;
  }

  manifest = `${manifest.slice(0, markerIndex)}${launcherMetaInsert}${manifest.slice(markerIndex)}`;
  fs.writeFileSync(ANDROID_MANIFEST_PATH, manifest);
  console.log('[android-customize] Added android.app.shortcuts metadata to LauncherActivity.');
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

function main() {
  console.log('[android-customize] Applying persistent Android customizations...');

  if (!fs.existsSync(LAUNCHER_TEMPLATE_PATH)) {
    console.error('[android-customize] Missing template: ' + LAUNCHER_TEMPLATE_PATH);
    process.exit(1);
  }

  if (fs.existsSync(LAUNCHER_ACTIVITY_PATH)) {
    try {
      fs.copyFileSync(LAUNCHER_TEMPLATE_PATH, LAUNCHER_ACTIVITY_PATH);
      console.log('[android-customize] LauncherActivity already up to date.');
    } catch (err) {
      console.error('[android-customize] Failed to copy LauncherActivity: ' + err.message);
      process.exit(1);
    }
  }

  const shortcuts = readShortcutConfig();
  syncBuildGradleShortcuts(shortcuts);
  syncShortcutIconDrawable();
  writeShortcutStringResources(shortcuts);
  writeShortcutsXml(shortcuts);
  ensureManifestShortcutMetadata();
  ensureLauncherPortraitOrientation();

  console.log('[android-customize] Done.');
}

main();
