const {createRequire}=require('node:module');const {IncomingMessage}=require('node:http');const {Duplex}=require('node:stream');const zlib=require('node:zlib');const {Buffer}=require('node:buffer');const r=createRequire('/workspace/acp-chat/package.json');
const body=r('body-parser');const kind=process.argv[2]||'br';const zip={gzip:zlib.gzipSync,deflate:zlib.deflateSync,br:zlib.brotliCompressSync}[kind];const input=zip(Buffer.from('{"ok":true}'));const tail=Buffer.from('synthetic-trailing-bytes');
const socket=new Duplex({read(){},write(c,e,cb){cb()}});const s=new IncomingMessage(socket);s.headers={'content-type':'application/json','content-encoding':kind,'content-length':String(input.length+tail.length)};s.method='POST';
process.on('uncaughtException',e=>{console.log('UNCAUGHT',e.code,e.message);process.exitCode=2});
let callback=false;
body.json()(s,{},e=>{callback=true;console.log('CALLBACK',e?.status,e?.code,s.body,'data listeners',s.listenerCount('data'));setImmediate(()=>{console.log('late synthetic data');s.emit('data',tail)})});s.push(input);s.push(null);s.complete=true;setTimeout(()=>console.log('done',callback),50);
