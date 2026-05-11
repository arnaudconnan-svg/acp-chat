#!/usr/bin/env node

const { execSync } = require('child_process');

const action = process.argv[2];

if (!action || !['enable', 'disable', 'status'].includes(action)) {
  console.log(`
Usage: npm run testpin:mode enable|disable|status

Examples:
  npm run testpin:mode enable    # Enable test PIN mode (accepts 999999)
  npm run testpin:mode disable   # Disable test PIN mode (requires biometric)
  npm run testpin:mode status    # Check current status
`);
  process.exit(1);
}

try {
  const packageName = 'io.facilitat.app';
  const prefsName = 'facilitat_security';
  const key = 'test_pin_mode';
  
  if (action === 'enable') {
    console.log('Enabling test PIN mode...');
    execSync(`adb shell am broadcast -a android.intent.action.QUERY_PACKAGE_RESTART -p ${packageName}`, { stdio: 'ignore' }).toString();
    // Use sqlite3 directly on the shared prefs
    const cmd = `adb shell "su -c 'cd /data/data/${packageName}/shared_prefs && sqlite3 ${prefsName}.xml \"UPDATE entries SET value='true' WHERE key='${key}'\" || echo true'"`;
    console.log('Note: This requires root or manual setting via the app interface.');
    console.log('Alternative: Manually enable in the app settings if available.');
    console.log('Test PIN code when enabled: 999999');
  } else if (action === 'disable') {
    console.log('Disabling test PIN mode...');
    console.log('Note: This requires root or manual setting via the app interface.');
  } else if (action === 'status') {
    console.log('To check status, use logcat:');
    console.log('  npm run logcat:recents');
    console.log('Look for: "test pin mode enabled" in the logs.');
  }
  
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
