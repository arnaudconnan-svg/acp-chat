if (!/(?:^|\/)(?:npm|npm-cli\.js)$/.test(process.argv[1] || '')) {
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const repoRoot = path.resolve(__dirname, '../..');
function denied() { throw new Error('Synthetic validation: prohibited side effect'); }
for (const name of ['http','https']) {
 const m = require(name); m.request = denied; m.get = denied;
}
const net = require('net');
net.connect = denied; net.createConnection = denied;
net.Socket.prototype.connect = denied; net.Server.prototype.listen = denied;
require('tls').connect = denied;
require('dgram').createSocket = denied;
global.fetch = denied;
// Server execution is blocked before its boot code and recurring timers can run.
// Synthetic DOM timers remain available to existing frontend harnesses.
const load = Module._load;
Module._load = function(name, parent, main) {
 if (/^(firebase-admin|nodemailer|dotenv)(\/|$)/.test(name)) denied();
 if ((path.resolve(String(name)) === path.join(repoRoot, 'server.js')) || (parent?.filename && path.resolve(path.dirname(parent.filename), name) === path.join(repoRoot, 'server.js'))) denied();
 return load.apply(this, arguments);
};
function checkFile(p) {
 if (typeof p !== 'string' && !Buffer.isBuffer(p) && !(p instanceof URL)) return;
 const s = path.resolve(String(p));
 if (s.startsWith(path.join(repoRoot, 'data') + path.sep) || /\/(\.env(?:\.[^/]*)?|serviceAccount\.json)$/.test(s)) denied();
}
for (const name of ['readFileSync','readFile','openSync','open','createReadStream','writeFileSync','writeFile','appendFileSync','appendFile']) {
 const original = fs[name]; fs[name] = function(p, ...args) { checkFile(p); return original.call(this,p,...args); };
}
for (const name of ['readFile','open','writeFile','appendFile']) {
 const original = fs.promises[name]; fs.promises[name] = function(p,...args) { checkFile(p); return original.call(this,p,...args); };
}
const cp = require('child_process');
const spawnSync = cp.spawnSync;
cp.spawnSync = function(command,args,options) {
 const cwd = path.resolve(options?.cwd || process.cwd());
 if (!cwd.startsWith('/tmp/preff-guard-') || !['git','node'].includes(command)) denied();
 if (args.some(a => /https?:\/\/|git@/.test(String(a)))) denied();
 return spawnSync.apply(this,arguments);
};
for (const name of ['exec','execSync','execFile','execFileSync','fork']) cp[name] = denied;
if (!process.argv[1]?.endsWith('/npm-cli.js')) cp.spawn = denied;

}
