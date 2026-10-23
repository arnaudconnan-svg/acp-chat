'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),console=require('node:console'),process=require('node:process');
const {createRequire}=require('node:module');
function owner(entry){let dir=path.dirname(entry);for(;;){let f=path.join(dir,'package.json');if(fs.existsSync(f)){let p=JSON.parse(fs.readFileSync(f));if(p.name&&p.version)return{file:f,entry,name:p.name,version:p.version};}dir=path.dirname(dir);}}
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const observations=[];
function walk(names){let r=createRequire(path.resolve('package.json'));const chain=[];for(const name of names){const entry=r.resolve(name);const o=owner(entry);chain.push({...o,sourceSha256:digest(entry)});r=createRequire(entry);}observations.push(chain);return r;}
walk(['express','body-parser','iconv-lite']);
walk(['pino-pretty','fast-copy']);
walk(['firebase-admin','@google-cloud/firestore','google-gax','protobufjs']);
walk(['firebase-admin','@google-cloud/firestore','google-gax','@grpc/proto-loader','@grpc/grpc-js']);
walk(['firebase-admin','@google-cloud/storage','retry-request','@types/request/package.json','form-data']);
walk(['@eslint/eslintrc','minimatch','brace-expansion']);
walk(['@eslint/eslintrc','js-yaml']);
walk(['firebase-admin','@fastify/busboy']);
const filter=require('pino-pretty/lib/utils/filter-log');assert.deepEqual(filter({log:{synthetic:true,omit:'x'},context:{ignoreKeys:['omit']}}),{synthetic:true});
const pb=require('protobufjs');const root=pb.parse('syntax="proto3"; message Synthetic { string value = 1; }').root;const type=root.lookupType('Synthetic');const bytes=type.encode({value:'synthetic'}).finish();assert.equal(type.decode(bytes).value,'synthetic');
assert.equal(require('zod/package.json').version,'4.6.6');
console.log(JSON.stringify({node:process.version,execPath:process.execPath,chains:observations,realFastCopyParentFilter:'passed',realProtobufRoundTrip:'passed',limits:'No Firebase/SMTP/Mistral load, credentials, providers or untrusted .proto; public package metadata/source only'},null,2));
