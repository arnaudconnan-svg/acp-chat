'use strict';
const fs = require('fs');
const cp = require('child_process');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  const result = original.apply(this, arguments);
  if (command === 'node') fs.appendFileSync(process.env.M3_TRACE_FILE,
    JSON.stringify({command,args,status:result.status,signal:result.signal,
      stdout:result.stdout,stderr:result.stderr,error:result.error?.code}) + '\n');
  return result;
};
