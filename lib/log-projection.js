'use strict';
const crypto=require('crypto');
const referenceKey=crypto.randomBytes(32);
const SAFE_EVENTS=new Set(['runtime_incident','console_incident','pipeline_summary','server_started',
 'chat_trace','chat_input_received','chat_stream_opened','chat_stream_closed','chat_stream_result_error','chat_stream_result_ok',
 'emergency_refresh_skipped','emergency_refresh_updated','emergency_refresh_failed','human_support_request_sent',
 'human_support_request_failed','admin_settings_cache_initialized','admin_settings_cache_init_failed',
 'admin_settings_listener_error','chat_request_canceled','memory_update_failed','memory_persist_retry_failed']);
const SAFE_CODES=new Set(['unauthorized','forbidden','invalid_request','auth_failed','chat_request_canceled',
 'quota_exhausted','insufficient_quota','streaming_disabled','invalid_configuration','runtime_error']);
const NUMBERS=new Set(['port','statusCode','httpStatus','totalMs','elapsedMs','deltaMs','waitMs','latencyMs',
 'promptTokens','completionTokens','totalTokens','chargedTokens','count','retryCount','attempt','stageCount']);
function projectLog(input={}) {
 const source=input&&typeof input==='object'&&!Array.isArray(input)?input:{};
 const out={event:SAFE_EVENTS.has(source.event)?source.event:'runtime_incident'};
 for(const [key,value] of Object.entries(source)) {
  if(NUMBERS.has(key)&&Number.isFinite(value))out[key]=Math.max(0,Math.min(value,1e12));
  else if(['requestId','conversationId','userId','traceId'].includes(key)&&typeof value==='string')
   out[key+'Ref']=crypto.createHmac('sha256',referenceKey).update(value).digest('hex').slice(0,24);
  else if(['code','errorCode'].includes(key)&&SAFE_CODES.has(value))out[key]=value;
  else if(key==='stageTimings'&&Array.isArray(value))out.stageTimings=value.slice(0,100).map(x=>({deltaMs:Number.isFinite(x?.deltaMs)?Math.max(0,x.deltaMs):null}));
 }
 return out;
}
function createSafeConsole(destination) {
 const out={};for(const level of ['log','info','warn','error','debug','trace'])out[level]=(...args)=>{
  const object=args.find(x=>x&&typeof x==='object'&&!Array.isArray(x));
  destination[level==='log'?'info':level]?.(projectLog({event:'console_incident',...(object||{})}));
 };return out;
}
module.exports={projectLog,createSafeConsole};
