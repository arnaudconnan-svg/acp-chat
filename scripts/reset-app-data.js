'use strict';
const { operatorMain } = require('../lib/operator-target');
if (require.main === module) {
  try { operatorMain('reset:data'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { operatorMain };
