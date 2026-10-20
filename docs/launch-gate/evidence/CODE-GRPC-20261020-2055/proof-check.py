import pathlib,subprocess,hashlib,json,datetime,base64
root=pathlib.Path('/workspace/acp-chat');p=root/'docs/launch-gate/evidence/CODE-GRPC-20261020-2055'
code='dfc8ac925e4f5aa8c3f9e5ab25e608ff4d73b1d0';base='30e3e74fb7b47da6c4df72d19172e1ac4f99e6cc'
def sha(b):return hashlib.sha256(b).hexdigest()
def git(*a):return subprocess.check_output(['git',*a],cwd=root)
def js(file):return json.loads(file.read_text())
def harness(label):
 s=(p/(label+'.stdout')).read_text();return json.loads(s[s.index('{'):])
assert git('rev-parse','HEAD').decode().strip()==code
assert git('rev-parse',code+'^').decode().strip()==base
checked={}
for f in ['package.json','package-lock.json','scripts/synthetic/guard.cjs','scripts/synthetic/grpc-harness.cjs']:
 b=(root/f).read_bytes();assert git('show',code+':'+f)==b;checked[f]={'sha256':sha(b),'git_show_equals_tested_checkout':True}
assert git('show',base+':scripts/synthetic/guard.cjs')==(root/'scripts/synthetic/guard.cjs').read_bytes()
labels=['baseline-ci','baseline-auth-real','baseline-errors-real','baseline-framing-real','baseline-compression-real','npm-ci','final-grpc','syntax-harness','syntax-server','final-isolation','final-verify','audit-before','audit-after']
commands=[]
for label in labels:
 m=js(p/(label+'.json'))
 for stream in ['stdout','stderr']:
  f=p/(label+'.'+stream)
  if f.exists():assert sha(f.read_bytes())==m[stream+'_sha256']
 commands.append({'capture':label+'.json',**m})
final=harness('final-grpc');old=harness('baseline-auth-real')
assert final['chain'][:3]==old['chain'][:3]
receipt={'code_commit':code,'base':base,'code_committed_at':git('show','-s','--format=%cI',code).decode().strip(),'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':final['node'],'node_evidence':'Observed directly inside baseline/final harness; no independent per-command version observation claimed for other scripts.','files':checked,'commands':commands,'scope':'Technical commit precedes final tests. Proof-only follow-up, no repository/data manifest.'}
(p/'tested-code-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
a=js(p/'audit-before.stdout');b=js(p/'audit-after.stdout');res=lambda x:{k:v for k,v in x['vulnerabilities'].items() if k!='@grpc/grpc-js'}
assert res(a)==res(b);assert len(res(b))==4;assert '@grpc/grpc-js' not in b['vulnerabilities']
projection={'target_before':a['vulnerabilities']['@grpc/grpc-js'],'target_after':None,'before_counts':a['metadata']['vulnerabilities'],'after_counts':b['metadata']['vulnerabilities'],'residuals_exactly_unchanged':True,'residuals':[{'name':k,'severity':v['severity'],'range':v['range'],'nodes':v['nodes'],'advisory_urls':[z['url'] for z in v['via'] if isinstance(z,dict)],'canonical_sha256_before_and_after':sha(json.dumps(v,sort_keys=True).encode())} for k,v in res(b).items()],'audit_codes':[1,1],'interpretation':'JSON valid; code 1 is expected for residual findings, not CI PASS.'}
(p/'audit-projection.json').write_text(json.dumps(projection,indent=2)+'\n')
bl=json.loads(git('show',base+':package-lock.json'));nl=js(root/'package-lock.json');assert bl['packages'].keys()==nl['packages'].keys();changes=[k for k in bl['packages'] if bl['packages'][k]!=nl['packages'][k]];assert changes==['node_modules/@grpc/grpc-js']
(p/'parent-invariants.json').write_text(json.dumps({'changed_lock_packages':changes,'actual_base_locked_version':bl['packages'][changes[0]]['version'],'new_locked_version':nl['packages'][changes[0]]['version'],'all_other_lock_entries_identical':True,'guard_unchanged':True,'physical_parents_unchanged':final['chain'][:3],'parent_range':'google-gax@4.6.1 requires ^1.10.9','baseline_discrepancy':'Task named 1.14.4; exact fetched beta and clean-installed physical baseline are 1.14.3. No claim of a 1.14.4 baseline test.'},indent=2)+'\n')
meta=js(p/'npm-fixed.stdout');tar=pathlib.Path('/workspace/work/grpc/grpc-grpc-js-1.14.5.tgz').read_bytes();sri='sha512-'+base64.b64encode(hashlib.sha512(tar).digest()).decode();assert sri==meta['dist']['integrity'];assert hashlib.sha1(tar).hexdigest()==meta['dist']['shasum']
(p/'integrity-provenance.json').write_text(json.dumps({'version':meta['version'],'tarball':meta['dist']['tarball'],'integrity':sri,'tarball_matches_registry_sha512_and_shasum':True,'registry_gitHead':meta['gitHead'],'signatures_present':bool(meta['dist'].get('signatures')),'attestation_field_present':bool(meta['dist'].get('attestations')),'limitation':'npm HTTPS metadata and tarball retrieved. Signatures/Sigstore not independently verified; gitHead is registry metadata, not a provenance attestation.'},indent=2)+'\n')
excerpts=[]
locations={'server-interceptors.js':[('decompressMessage','decompresser.on(\'error\'',-1,7),('getAuthContext','if (!this.stream.session.socket.authorized)',-4,13)],'server.js':[('_streamHandler','_streamHandler(extraInterceptors, stream, headers)',0,10),('handleUnary','details = \'Unknown error\';',-6,14)],'transport.js':[('Http2Transport.constructor','session.socket instanceof tls_1.TLSSocket && session.socket.authorized',-1,10)]}
for source in final['sources']:
 file=pathlib.Path(source['file']);new=file.read_bytes();assert sha(new)==source['sha256'];assert new==(pathlib.Path('/workspace/work/grpc/fixed/package/build/src')/file.name).read_bytes()
 oldbytes=(pathlib.Path('/workspace/work/grpc/baseline')/file.name).read_bytes();assert sha(oldbytes)==next(s['sha256'] for s in old['sources'] if pathlib.Path(s['file']).name==file.name)
 lines=new.decode().splitlines();snips=[]
 for function,needle,offset,count in locations.get(file.name,[]):
  anchor=next(i for i,line in enumerate(lines) if needle in line);start=max(0,anchor+offset);snips.append({'function':function,'lines':[{'line':i+1,'text':lines[i]} for i in range(start,min(start+count,len(lines)))]})
 excerpts.append({'file':str(file.relative_to(root)),'baseline_version':'1.14.3','baseline_sha256':sha(oldbytes),'tested_version':'1.14.5','tested_sha256':sha(new),'physical_source_matches_registry_tarball':True,'snippets':snips})
for relative,needle in [('node_modules/firebase-admin/lib/firestore/firestore-internal.js',"require('@google-cloud/firestore').Firestore"),('node_modules/@google-cloud/firestore/build/src/index.js',"gax = this._gax = require('google-gax')"),('node_modules/google-gax/build/src/grpc.js','const grpc = require("@grpc/grpc-js")')]:
 data=(root/relative).read_bytes();lines=data.decode().splitlines();i=next(i for i,l in enumerate(lines) if needle in l);excerpts.append({'file':relative,'sha256':sha(data),'function':'dependency loading','lines':[{'line':i+1,'text':lines[i]}]})
(p/'source-excerpts.json').write_text(json.dumps({'sources':excerpts,'client_auth_limit':'Client transport authorization branch inspected as physical source; no handshake or private-class extraction. Runtime tests cover real server-side auth and exported server dispatch using synthetic I/O boundary fixtures.'},indent=2)+'\n')
print(json.dumps({'code_commit':code,'base':base,'four_useful_code_files_match':checked,'actual_baseline':'1.14.3','candidate':'1.14.5','four_residuals_unchanged':True,'only_dependency_changed':'@grpc/grpc-js','physical_parents_unchanged':True,'final_grpc_code':js(p/'final-grpc.json')['code'],'final_verify_code':js(p/'final-verify.json')['code'],'tarball_integrity_matches':True},indent=2))
