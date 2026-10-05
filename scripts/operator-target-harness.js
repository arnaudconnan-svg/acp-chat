'use strict';
const assert = require('assert/strict');
const { planOperation } = require('../lib/operator-target');
const manifest = { version: 1, databaseUrl: 'https://synthetic.example.test',
  principal: 'operator@synthetic.iam.gserviceaccount.com', projectId: 'synthetic',
  operations: ['reset:data'], scopes: ['conversations'] };
const args = ['--target=https://synthetic.example.test',
  '--principal=operator@synthetic.iam.gserviceaccount.com', '--scope=conversations', '--ids=c_A,c_B'];
assert.deepEqual(planOperation({operation:'reset:data',args,manifest}).paths,['conversations/c_A','conversations/c_B']);
for (const bad of [[], [...args,'--apply'], args.slice(0,-1),
  args.map(a=>a.startsWith('--ids=')?'--ids=../users':a),
  args.map(a=>a.startsWith('--target=')?'--target=https://other.example.test':a)])
  assert.throws(()=>planOperation({operation:'reset:data',args:bad,manifest}));
assert.throws(()=>planOperation({operation:'reset:data',args}));
assert.throws(()=>planOperation({operation:'rtdb:index',args,manifest}));
console.log('[PASS] M0 bounded simulation and fail-closed refusals; no deletion adapter');
