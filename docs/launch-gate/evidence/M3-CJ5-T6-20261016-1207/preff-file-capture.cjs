'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command !== 'node') return original.apply(this, arguments);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-preff-capture-'));
  const stdoutFile = path.join(dir, 'stdout');
  const stderrFile = path.join(dir, 'stderr');
  const out = fs.openSync(stdoutFile, 'w');
  const err = fs.openSync(stderrFile, 'w');
  let result;
  try {
    result = original(command, args, {...options, stdio:['ignore',out,err]});
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  result.stdout = fs.readFileSync(stdoutFile,'utf8');
  result.stderr = fs.readFileSync(stderrFile,'utf8');
  fs.appendFileSync(process.env.M3_TRACE_FILE,
    JSON.stringify({command,args,status:result.status,signal:result.signal,
      stdout:result.stdout,stderr:result.stderr,error:result.error?.code}) + '\n');
  fs.rmSync(dir,{recursive:true});
  return result;
};
