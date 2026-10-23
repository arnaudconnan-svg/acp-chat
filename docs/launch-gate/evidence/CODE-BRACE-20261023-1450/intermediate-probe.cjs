const fs=require('fs'),vm=require('vm'),{createRequire}=require('module');
const requireRepo=createRequire('/workspace/acp-chat/package.json');
for(const file of ['/workspace/work/brace/v17/package/index.js','/workspace/work/brace/fixed/package/index.js']){
 const req=createRequire(requireRepo.resolve('brace-expansion'));let stats={calls:0,commaDepth:0};let source=fs.readFileSync(file,'utf8').replace(/function parseCommaParts\(str\) \{/,"function parseCommaParts(str) { __probe();");
 for(const [name,input,opt] of [['empty','x'+'{}'.repeat(8)+',z}',{}],['length','{aaaa,bbbb}'.repeat(5),{maxLength:32}],['intermediate','{'+Array(80).fill('abcd').join(',')+'}',{max:100,maxLength:16}],['comma','{'+('{a},'.repeat(24))+'z}',{}],['nest','{'.repeat(12)+'a,b'+'}'.repeat(12),{maxDepth:2}],['rewrite','{a}'+'}'.repeat(12)+',z}',{maxRewrites:2}]]){
 stats={calls:0,commaDepth:0};const sandbox={module:{exports:{}},require:n=>{const real=req(n);if(n!=='balanced-match')return real;return(...a)=>{if(++stats.calls>2000)throw Error('operation cap');return real(...a)}},__probe:()=>{const save=Error.stackTraceLimit;Error.stackTraceLimit=100;stats.commaDepth=Math.max(stats.commaDepth,(new Error().stack.match(/at parseCommaParts/g)||[]).length);Error.stackTraceLimit=save;}};
 vm.runInNewContext(source,sandbox,{filename:file});try{let out=sandbox.module.exports(input,opt);console.log(file,name,stats,'count',out.length,'length',out.reduce((s,x)=>s+x.length,0),'sample',out.slice(0,2));}catch(e){console.log(name,e.message,stats)}
 }
}
