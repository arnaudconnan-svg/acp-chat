const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAUNCHER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'LauncherActivity.java');
const LAUNCHER_ACTIVITY_PATH = path.join(ROOT, 'android-project', 'app', 'src', 'main', 'java', 'io', 'facilitat', 'app', 'LauncherActivity.java');

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

  console.log('[android-customize] Done.');
}

main();
