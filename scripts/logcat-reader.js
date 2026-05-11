#!/usr/bin/env node

const { execSync } = require('child_process');

const lines = parseInt(process.argv[2] || '100', 10);

try {
  const output = execSync('adb logcat -d', { encoding: 'utf-8' });
  const allLines = output.split('\n');
  
  // Filter for Facilitat logs
  const facilitatLogs = allLines.filter(line => 
    line.includes('Facilitat') || line.includes('facilitat')
  );
  
  // Show the last N lines
  const selectedLogs = facilitatLogs.slice(-lines);
  
  console.log(`\n=== Facilitat Logcat (last ${lines} lines) ===\n`);
  selectedLogs.forEach(line => console.log(line));
  console.log(`\n=== End of logcat (${facilitatLogs.length} total Facilitat lines) ===\n`);
  
} catch (err) {
  console.error('Error reading logcat. Make sure adb is available and device is connected.');
  process.exit(1);
}
