'use strict';
const assert=require('assert/strict');
const {Writable}=require('stream');
const {projectLog,createSafeConsole}=require('../../lib/log-projection');
const pino=require('pino');
const marker='FAKE_SECRET_TRANSCRIPT_MEMORY_MARKER';
let wire='';const sink=new Writable({write(chunk,encoding,done){wire+=chunk;done();}});
// Same production hook and genuine pino serializer/destination, not a fake logger.
const logger=pino({base:undefined,hooks:{logMethod(args,method){method.call(this,projectLog(args[0]));}}},sink);
logger.info({event:'pipeline_summary',requestId:marker,memory:marker,transcript:marker,debugMeta:{secret:marker},elapsedMs:23},marker);
logger.error(new Error(marker));
createSafeConsole(logger).error(marker,{error:marker,code:'runtime_error'});
logger.child(projectLog({conversationId:marker,secret:marker})).info({event:'chat_trace',totalMs:4});
assert(!wire.includes(marker));const rows=wire.trim().split('\n').map(JSON.parse);
assert(rows.some(row=>row.elapsedMs===23));assert(rows.some(row=>row.code==='runtime_error'));
assert(!rows.some(row=>row.memory||row.transcript||row.debugMeta||row.err||row.msg));
console.log('[PASS] G06 production projection before genuine pino, console and child bindings; markers absent');
