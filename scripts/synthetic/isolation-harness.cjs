'use strict';
const assert=require('assert/strict');
const {loadApplication}=require('./runtime.cjs');
(async()=>{
  const a=loadApplication();
  const r=await a.request('get','/health');assert.equal(r.statusCode,200);assert.equal(r.body.status,'ok');
  assert(a.blocked.includes('listen'));assert(a.blocked.includes('interval'));
  assert.deepEqual(a.db.operations,[],'boot must not read/write persistence');
  assert.throws(()=>require('https').get('https://synthetic.example.test'));
  assert.throws(()=>require('net').connect(443,'synthetic.example.test'));
  assert.throws(()=>require('firebase-admin'));
  assert.throws(()=>require('../../server.js'));
  console.log('[PASS] M0 full source/health with doubles, boot/timers/providers refused before load');
})().catch(e=>{console.error(e);process.exitCode=1;});
