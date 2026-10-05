'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const realRequire = createRequire(path.join(root, 'server.js'));
const copy = x => x == null ? null : structuredClone(x);
function databaseDouble(seed = {}) {
  const data = copy(seed), operations = []; let sequence = 0;
  function ref(location = '', query = {}) {
    const parts = location.split('/').filter(Boolean);
    function read() {
      let value = data; for (const p of parts) value = value?.[p];
      if (query.order && value && typeof value === 'object')
        value = Object.fromEntries(Object.entries(value).filter(([,row]) => query.equal === undefined || row?.[query.order] === query.equal));
      return copy(value);
    }
    function assign(value) {
      if (!parts.length) throw new Error('synthetic_root_write_refused');
      let node = data; for (const p of parts.slice(0,-1)) node = node[p] ||= {};
      if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = copy(value);
    }
    const r = {
      key: parts.at(-1), child: key => ref(`${location}/${key}`),
      orderByChild: order => ref(location,{...query,order}), equalTo: equal => ref(location,{...query,equal}),
      limitToLast: () => r, limitToFirst: () => r,
      async once() {operations.push({action:'read',path:location});const v=read();
        return {val:()=>copy(v),exists:()=>v!=null,forEach(fn){for(const [key,value] of Object.entries(v||{})) fn({key,val:()=>copy(value)});}};},
      async set(value) {operations.push({action:'set',path:location});assign(value);},
      async update(patch) {operations.push({action:'update',path:location});for(const [key,value] of Object.entries(patch))await r.child(key).set(value);},
      async remove() {operations.push({action:'remove',path:location});assign(null);},
      async transaction(fn) {const value=fn(read());if(value===undefined)return {committed:false,snapshot:{val:read}};
        await r.set(value);return {committed:true,snapshot:{val:read}};},
      push(value) {const c=r.child(`synthetic_${++sequence}`);if(value!==undefined)c.set(value);return c;},
      on() {throw new Error('synthetic_listener_refused');}, off() {}
    };return r;
  }
  return {ref,data,operations};
}
function loadApplication({seed={},overrides={},env={}}={}) {
  const db=databaseDouble(seed),routes=[],middleware=[],logs=[],blocked=[];
  const app={use(...fns){middleware.push(...fns.filter(x=>typeof x==='function'));},listen(){blocked.push('listen');return {close(){}};}};
  for(const method of ['get','post','put','patch','delete'])app[method]=(route,...handlers)=>routes.push({method,route,handlers});
  const express=()=>app;express.static=()=> (req,res,next)=>next();express.json=()=> (req,res,next)=>next();
  const logger={};for(const level of ['info','warn','error','debug','trace','fatal','log'])logger[level]=(...args)=>logs.push({level,args});logger.child=()=>logger;
  const syntheticEnv={NODE_ENV:'test',MISTRAL_API_KEY:'synthetic-unused',FIREBASE_DATABASE_URL:'https://synthetic.example.test',
    FIREBASE_SERVICE_ACCOUNT:'{}',LOG_PERSIST:'false',REFRESH_EMERGENCY_ON_BOOT:'false',
    SESSION_SECRET:'synthetic-session-key-012345678901234567890',USER_SESSION_SECRET:'synthetic-user-key-012345678901234567890',
    ADMIN_SESSION_SECRET:'synthetic-professional-key-0123456789012345',...env};
  const deps={express,dotenv:{config(){}},
    'firebase-admin':{initializeApp(){blocked.push('firebase_double');},credential:{cert:()=>({})},database:()=>db},
    nodemailer:{createTransport:()=>({async sendMail(){throw new Error('synthetic_mail_refused');}})},
    './lib/logger':{childLogger:()=>logger,logger},
    './lib/emergency-updater':{updateEmergencyNumbers(){throw new Error('synthetic_updater_refused');}},
    './lib/mistral-transport':{createMistralTransport:()=>({async complete(){throw new Error('synthetic_llm_missing_fixture');},async stream(){throw new Error('synthetic_llm_missing_fixture');}})},
    fs:{...fs,readFileSync(file,...args){if(String(file).startsWith(path.join(root,'data')))return '{}';
      if(/(?:\.env|serviceAccount\.json)$/.test(String(file)))throw new Error('synthetic_secret_read_refused');return fs.readFileSync(file,...args);}},...overrides};
  const context=vm.createContext({require:name=>Object.hasOwn(deps,name)?deps[name]:realRequire(name),__dirname:root,
    __filename:path.join(root,'server.js'),module:{exports:{}},exports:{},
    process:{env:syntheticEnv,cwd:()=>root,stdout:{isTTY:false},on(){}},Buffer,URL,structuredClone,console:logger,
    setInterval(){blocked.push('interval');return 0;},clearInterval(){},setTimeout(fn,ms){return setTimeout(fn,Math.min(ms||0,5));},clearTimeout,queueMicrotask});
  vm.runInContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),context,{filename:'synthetic-server.js'});
  async function request(method,url,{body={},cookie='',headers={},query={}}={}) {
    const pathname=url.split('?')[0];let params={},selected;
    for(const r of routes){if(r.method!==method.toLowerCase())continue;
      const keys=[],pattern=r.route.replace(/:([\w]+)/g,(_,key)=>{keys.push(key);return '([^/]+)';});
      const m=pathname.match(new RegExp(`^${pattern}$`));if(m){selected=r;keys.forEach((k,i)=>params[k]=decodeURIComponent(m[i+1]));break;}}
    if(!selected)throw new Error(`missing_synthetic_route:${method}:${pathname}`);
    const req={body,params,query,headers:{cookie,...headers},path:pathname,url,method:method.toUpperCase(),
      socket:{remoteAddress:'127.0.0.1'},ip:'127.0.0.1',on(){},get(name){return this.headers[name.toLowerCase()];}};
    const res={statusCode:200,headers:{},body:null,writableEnded:false,
      setHeader(name,value){this.headers[name]=value;},set(name,value){this.setHeader(name,value);return this;},
      status(code){this.statusCode=code;return this;},json(value){this.body=copy(value);this.writableEnded=true;return this;},
      send(value){this.body=value;this.writableEnded=true;return this;},redirect(value){this.statusCode=302;this.headers.Location=value;this.writableEnded=true;},
      sendFile(value){this.body={file:path.basename(value)};this.writableEnded=true;},write(){},flushHeaders(){},end(){this.writableEnded=true;}};
    const handlers=[...middleware.filter(fn=>fn.length!==4),...selected.handlers];
    async function run(index){const fn=handlers[index];if(!fn||res.writableEnded)return;let pending;
      await fn(req,res,()=>{pending=run(index+1);return pending;});if(pending)await pending;}
    await run(0);return res;
  }
  return {db,request,logs,blocked,context,evaluate:code=>vm.runInContext(code,context)};
}
module.exports={databaseDouble,loadApplication};
