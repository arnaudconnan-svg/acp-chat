import pathlib, subprocess, hashlib, json, datetime, base64, difflib
root=pathlib.Path('/workspace/acp-chat'); p=root/'docs/launch-gate/evidence/CODE-FORMDATA-20261020-1605'
code='285b66719cf1a872a4ad1b175e7b2ec640456e56'; base='d8434f1f524f691549ace6367471687b1b096aea'
def sha(b): return hashlib.sha256(b).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
def readjson(file): return json.loads(file.read_text())
assert git('rev-parse','HEAD').decode().strip()==code
assert git('rev-parse',code+'^').decode().strip()==base
files=['package.json','package-lock.json','scripts/synthetic/guard.cjs','scripts/synthetic/formdata-harness.cjs']
checked={}
for f in files:
    committed=git('show',code+':'+f); current=(root/f).read_bytes(); assert committed==current
    checked[f]={'sha256':sha(current),'git_show_equals_tested_checkout':True}
assert git('show',base+':scripts/synthetic/guard.cjs')==(root/files[2]).read_bytes()
labels=['node','npm-ci','baseline-crlf','syntax-server','syntax-harness','final-formdata','final-isolation','final-verify','audit-before','audit-after']
commands=[]
for label in labels:
    m=readjson(p/(label+'.json'))
    for stream in ['stdout','stderr']:
        f=p/(label+'.'+stream)
        if f.exists(): assert sha(f.read_bytes())==m[stream+'_sha256']
    commands.append({'capture':label+'.json',**m})
receipt={'code_commit':code,'base':base,'code_committed_at':git('show','-s','--format=%cI',code).decode().strip(),'checked_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':readjson(p/'node.stdout'),'node_limit':'Observed before checks and directly inside baseline/final form-data harness; no per-command version capture claimed for the other harnesses.','files':checked,'commands':commands,'scope':'Only four useful code-file hashes. Technical commit precedes final tests; this proof commit does not change technical files.'}
(p/'tested-code-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
a=readjson(p/'audit-before.stdout');b=readjson(p/'audit-after.stdout')
res=lambda x:{k:v for k,v in x['vulnerabilities'].items() if k!='form-data'}
assert res(a)==res(b);assert 'form-data' not in b['vulnerabilities'];assert len(res(b))==5
projection={'target_before':a['vulnerabilities']['form-data'],'target_after':None,'counts_before':a['metadata']['vulnerabilities'],'counts_after':b['metadata']['vulnerabilities'],'residuals_exactly_unchanged':True,'residuals':[{'name':k,'severity':v['severity'],'range':v['range'],'nodes':v['nodes'],'advisory_urls':[z['url'] for z in v['via'] if isinstance(z,dict)],'canonical_sha256_before_and_after':sha(json.dumps(v,sort_keys=True).encode())} for k,v in res(b).items()],'audit_codes':[1,1],'meaning':'Valid npm audit JSON; exit 1 expected for residual findings, not CI PASS.'}
(p/'audit-projection.json').write_text(json.dumps(projection,indent=2)+'\n')
oldlock=json.loads(git('show',base+':package-lock.json'));newlock=readjson(root/'package-lock.json');assert oldlock['packages'].keys()==newlock['packages'].keys()
changed=[k for k in oldlock['packages'] if oldlock['packages'][k]!=newlock['packages'][k]];assert changed==['node_modules/form-data']
baseline=readjson(p/'baseline-crlf.stdout');raw=(p/'final-formdata.stdout').read_text();final=json.loads(raw[raw.index('{'):])
assert baseline['chain'][:4]==final['chain'][:4]
(p/'parent-invariants.json').write_text(json.dumps({'changed_lock_packages':changed,'all_other_lock_entries_identical':True,'guard_unchanged_from_base':True,'physical_parents_identical_before_after':baseline['chain'][:4],'runtime_claim':'This is an installed metadata/type-dependency chain; not evidence that Admin invokes form-data at runtime.'},indent=2)+'\n')
oldfile=pathlib.Path('/workspace/work/formdata/form_data-2.5.5.js');newfile=root/'node_modules/form-data/lib/form_data.js';old=oldfile.read_bytes();new=newfile.read_bytes()
assert sha(old)==baseline['formEntrySha256'];assert sha(new)==final['formEntrySha256']
assert new==pathlib.Path('/workspace/work/formdata/fixed/package/lib/form_data.js').read_bytes()
excerpts={'old_file':'npm form-data@2.5.5/lib/form_data.js','old_sha256':sha(old),'new_file':'node_modules/form-data/lib/form_data.js','new_sha256':sha(new),'functions':['escapeHeaderParam','FormData.prototype._multiPartHeader','FormData.prototype._getContentDisposition'],'line_numbered_diff':''.join(difflib.unified_diff(old.decode().splitlines(True),new.decode().splitlines(True),fromfile='npm/form-data@2.5.5/lib/form_data.js',tofile='npm/form-data@2.5.6/lib/form_data.js',n=3)),'type_import':{'file':'node_modules/@types/request/index.d.ts','line':10,'text':(root/'node_modules/@types/request/index.d.ts').read_text().splitlines()[9]}}
(p/'source-excerpts.json').write_text(json.dumps(excerpts,indent=2)+'\n')
meta=readjson(p/'npm-formdata.stdout');tar=pathlib.Path('/workspace/work/formdata/form-data-2.5.6.tgz').read_bytes();sri='sha512-'+base64.b64encode(hashlib.sha512(tar).digest()).decode();assert sri==meta['dist']['integrity'];assert hashlib.sha1(tar).hexdigest()==meta['dist']['shasum']
(p/'integrity-provenance.json').write_text(json.dumps({'version':meta['version'],'registry_tarball':meta['dist']['tarball'],'integrity':sri,'tarball_matches_registry_sha512_and_shasum':True,'physical_source_matches_tarball':True,'registry_gitHead':meta['gitHead'],'registry_signatures_present':bool(meta['dist'].get('signatures')),'registry_attestation_field_present':bool(meta['dist'].get('attestations')),'limitation':'Official npm HTTPS metadata and tarball retrieved; no independent npm signature/Sigstore verification, and no provenance attestation inferred from gitHead.'},indent=2)+'\n')
print(json.dumps({'code_commit':code,'base':base,'four_code_files_match':checked,'five_residuals_unchanged':True,'only_lock_dependency_changed':'form-data','physical_parents_identical':True,'baseline_crlf_code':commands[2]['code'],'final_formdata_code':commands[5]['code'],'final_verify_code':commands[7]['code'],'tarball_integrity_matches':True},indent=2))
