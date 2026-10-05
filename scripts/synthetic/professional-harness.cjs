'use strict';
const assert=require('assert/strict');
const {hashPassword}=require('../../lib/auth-password');
const {loadApplication}=require('./runtime.cjs');
let done=false;process.on('beforeExit',()=>{if(!done)process.exitCode=1;});
(async()=>{
 const identity=(email,roles)=>({email,passwordHash:hashPassword('SyntheticPassword123!'),active:true,roles,authorizationVersion:1});
 const seed={professionalIdentities:{p:identity('p@example.test',['practitioner']),s:identity('s@example.test',['commercial_support']),
  t:identity('t@example.test',['technical_support']),a:identity('a@example.test',['administrator'])},
  practitionerAssignments:{p:{u_A:{active:true}}},contentGrants:{u_A:{p:{id:'g_A',version:1,active:true,scope:'conversation_specific',conversationIds:['c_A'],startsAt:0,endsAt:Date.now()+100000}}},
  conversations:{c_A:{userId:'u_A',title:'A'},c_B:{userId:'u_B',title:'B'},c_private:{userId:'u_A',isPrivate:true}},
  messages:{m_A:{userId:'u_A',conversationId:'c_A',role:'user',content:'VISIBLE',debugMeta:{secret:'MARKER_DEBUG'},timestamp:1},
   m_foreign:{userId:'u_B',conversationId:'c_A',content:'FOREIGN'}}};
 const a=loadApplication({seed});
 async function login(email){const r=await a.request('post','/api/pros/login',{body:{email,password:'SyntheticPassword123!'}});
  assert.equal(r.statusCode,200);return r.headers['set-cookie'].split(';')[0];}
 const cookie=await login('p@example.test');
 const directory=await a.request('get','/api/facilitation/users',{cookie});assert.equal(directory.body.users.length,1);
 const userRef=directory.body.users[0].userRef;
 const list=await a.request('get',`/api/facilitation/users/${userRef}/conversations`,{cookie});assert.equal(list.body.conversations.length,1);
 const conversationRef=list.body.conversations[0].conversationRef;
 const messages=await a.request('get',`/api/facilitation/conversations/${conversationRef}/messages`,{cookie,query:{userRef}});
 assert.equal(messages.statusCode,200);assert.deepEqual(messages.body.messages,[{role:'user',content:'VISIBLE',timestamp:1}]);
 assert(!JSON.stringify(messages.body).includes('MARKER_DEBUG'));assert(!JSON.stringify(messages.body).includes('u_A'));
 assert.equal((await a.request('get',`/api/facilitation/conversations/${conversationRef}/messages`,{cookie,query:{userRef:'other'}})).statusCode,404);
 assert.equal((await a.request('get',`/api/facilitation/intersession-memory/${userRef}`,{cookie})).statusCode,403);
 const restarted=loadApplication({seed:a.db.data});assert.equal((await restarted.request('get','/api/facilitation/users',{cookie})).body.users.length,1);
 a.db.data.contentGrants.u_A.p.active=false;
 assert.equal((await a.request('get',`/api/facilitation/conversations/${conversationRef}/messages`,{cookie})).statusCode,404);
 a.db.data.professionalIdentities.p.authorizationVersion++;
 assert.equal((await a.request('get','/api/facilitation/users',{cookie})).statusCode,401);
 for(const email of ['s@example.test','t@example.test']){
  const support=await login(email);assert.equal((await a.request('get','/api/admin/conversations',{cookie:support,headers:{'x-access-reason':'support_incident'}})).statusCode,403);
  assert.equal((await a.request('get','/api/facilitation/users',{cookie:support})).statusCode,403);
 }
 const admin=await login('a@example.test');assert.equal((await a.request('get','/api/admin/users',{cookie:admin})).statusCode,403);
 assert.equal((await a.request('get','/api/admin/users',{cookie:admin,headers:{'x-access-reason':'security_review'}})).statusCode,200);
 assert.equal((await a.request('get','/api/admin/session',{cookie:'adminSessionId=legacy.full'})).body.authenticated,false);
 assert.equal((await a.request('post','/api/twa/login',{body:{password:'synthetic-unused'}})).statusCode,403);
 assert(Object.values(a.db.data.professionalAccessJournal).some(e=>e.result==='denied'));
 assert(Object.values(a.db.data.professionalAccessJournal).some(e=>e.result==='allowed'));
 assert(!JSON.stringify(a.db.data.professionalAccessJournal).includes('VISIBLE'));
 done=true;console.log('[PASS] M1 individual roles, cold restart, grants/revocation, minimal API, supports/admin and journal through genuine Express');
})().catch(e=>{done=true;console.error(e);process.exitCode=1;});
