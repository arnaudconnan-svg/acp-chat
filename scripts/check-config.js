'use strict';

require('dotenv').config({ quiet: true });

const { inspectConfig, summarizeConfig } = require('../lib/config');

const inspected = inspectConfig(process.env);

if (!inspected.ok) {
  console.error('[config-check] invalid configuration');
  for (const issue of inspected.issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log('[config-check] configuration valid');
console.log(JSON.stringify(summarizeConfig(inspected.config), null, 2));
