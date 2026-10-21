import pathlib,subprocess,hashlib,json,datetime,base64,difflib
root=pathlib.Path('/workspace/acp-chat');p=root/'docs/launch-gate/evidence/CODE-JSYAML-20261021-0931'
code='2c87a1db8dac795594ea95d1f3e952356fabfd06';base='e23bc20e06c14438a02034c6feb49bf0dcec41d8'
def sha(b):return hashlib.sha256(b).hexdigest()
def git(*a):return subprocess.check_output(['git',*a],cwd=root)
def js(f):return json.loads(f.read_text())
def harness(label):
 s=(p/(label+'.stdout')).read_text();return json.loads(s[s.index('{'):])
assert git('rev-parse','HEAD').decode().strip()==code
assert git('rev-parse',code+'~2').decode().strip()==base
checked={}
for f in ['package.json','package-lock.json','scripts/synthetic/guard.cjs','scripts/synthetic/jsyaml-harness.cjs']:
 b=(root/f).read_bytes();assert git('show',code+':'+f)==b;checked[f]={'sha256':sha(b),'git_show_equals_tested_checkout':True}
assert git('show',base+':scripts/synthetic/guard.cjs')==(root/'scripts/synthetic/guard.cjs').read_bytes()
labels=['baseline-ci','baseline-merges','baseline-lint','npm-ci','qualified-jsyaml','qualified-syntax','qualified-syntax-server','qualified-target-lint','qualified-lint','qualified-isolation','qualified-verify','audit-before','audit-after']
commands=[]
for label in labels:
 m=js(p/(label+'.json'))
 for stream in ['stdout','stderr']:
  f=p/(label+'.'+stream)
  if f.exists():assert sha(f.read_bytes())==m[stream+'_sha256']
 commands.append({'capture':label+'.json',**m})
final=harness('qualified-jsyaml');baseline=harness('baseline-merges');assert final['parent']==baseline['parent']
(p/'tested-code-receipt.json').write_text(json.dumps({'code_commit':code,'base':base,'technical_commits':git('rev-list','--reverse',base+'..'+code).decode().splitlines(),'code_committed_at':git('show','-s','--format=%cI',code).decode().strip(),'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':final['node'],'node_evidence':'Observed directly inside baseline/final harness; no independent per-command runtime-version observation claimed for every other script.','files':checked,'commands':commands,'scope':'Final technical commit precedes qualified checks. Proof-only follow-up; four useful code-file hashes, no repository/data manifest.'},indent=2)+'\n')
a=js(p/'audit-before.stdout');b=js(p/'audit-after.stdout');res=lambda x:{k:v for k,v in x['vulnerabilities'].items() if k!='js-yaml'}
assert res(a)==res(b);assert len(res(b))==3;assert 'js-yaml' not in b['vulnerabilities']
(p/'audit-projection.json').write_text(json.dumps({'target_before':a['vulnerabilities']['js-yaml'],'target_after':None,'before_counts':a['metadata']['vulnerabilities'],'after_counts':b['metadata']['vulnerabilities'],'residuals_exactly_unchanged':True,'residuals':[{'name':k,'severity':v['severity'],'range':v['range'],'nodes':v['nodes'],'advisory_urls':[z['url'] for z in v['via'] if isinstance(z,dict)],'canonical_sha256_before_and_after':sha(json.dumps(v,sort_keys=True).encode())} for k,v in res(b).items()],'audit_codes':[1,1],'interpretation':'Valid npm JSON, residual findings remain. Not global audit/CI PASS.'},indent=2)+'\n')
bl=json.loads(git('show',base+':package-lock.json'));nl=js(root/'package-lock.json');assert bl['packages'].keys()==nl['packages'].keys();changes=[k for k in bl['packages'] if bl['packages'][k]!=nl['packages'][k]];assert changes==['node_modules/js-yaml']
(p/'parent-invariants.json').write_text(json.dumps({'changed_lock_packages':changes,'all_other_lock_entries_identical':True,'guard_unchanged':True,'physical_parent_before_after':final['parent'],'dev_only_lock_flag':nl['packages']['node_modules/js-yaml']['dev'],'new_version':'4.3.2','parent_range':'^4.1.1','brief_discrepancy':'4.3.0 remains affected by GHSA-5p4m-2wfm-xmqj (<4.3.1) and GHSA-2883-xcg3-v3hh (<4.3.2). 4.3.2 is minimum compatible outside all current ranges.'},indent=2)+'\n')
assert (p/'baseline-lint.stdout').read_bytes()==(p/'qualified-lint.stdout').read_bytes();assert (p/'baseline-lint.stderr').read_bytes()==(p/'qualified-lint.stderr').read_bytes()
(p/'lint-comparison.json').write_text(json.dumps({'baseline_code':js(p/'baseline-lint.json')['code'],'qualified_code':js(p/'qualified-lint.json')['code'],'stdout_identical_byte_for_byte':True,'stderr_identical_byte_for_byte':True,'stdout_sha256':sha((p/'baseline-lint.stdout').read_bytes()),'existing_errors':337,'existing_warnings':17,'new_harness_lint_code':js(p/'qualified-target-lint.json')['code'],'scope':'Inherited global lint failure preserved; no rules disabled or unrelated findings fixed.'},indent=2)+'\n')
meta=js(p/'npm-fixed.stdout');tar=pathlib.Path('/workspace/work/jsyaml/js-yaml-4.3.2.tgz').read_bytes();sri='sha512-'+base64.b64encode(hashlib.sha512(tar).digest()).decode();assert sri==meta['dist']['integrity'];assert hashlib.sha1(tar).hexdigest()==meta['dist']['shasum']
(p/'integrity-provenance.json').write_text(json.dumps({'version':'4.3.2','tarball':meta['dist']['tarball'],'integrity':sri,'tarball_matches_registry_sha512_and_shasum':True,'registry_gitHead':meta['gitHead'],'signatures_present':bool(meta['dist'].get('signatures')),'attestation_field_present':bool(meta['dist'].get('attestations')),'limitation':'Official npm HTTPS metadata and tarball retrieved. No independent npm signature/Sigstore verification; no provenance attestation inferred from gitHead.'},indent=2)+'\n')
excerpts=[]
for relative,ranges in [('node_modules/js-yaml/lib/loader.js',[(150,156),(374,402),(435,446)]),('node_modules/js-yaml/lib/type/omap.js',[(9,36)]),('node_modules/@eslint/eslintrc/dist/eslintrc.cjs',[(2611,2622)])]:
 data=(root/relative).read_bytes();lines=data.decode().splitlines()
 if '/js-yaml/' in relative:assert data==(pathlib.Path('/workspace/work/jsyaml/fixed/package')/relative.split('/js-yaml/',1)[1]).read_bytes()
 excerpts.append({'file':relative,'sha256':sha(data),'snippets':[{'start_line':s,'end_line':e,'text':'\n'.join(lines[s-1:e])} for s,e in ranges]})
old=pathlib.Path('/workspace/work/jsyaml/loader-4.1.1.js').read_bytes();assert sha(old)==baseline['yaml']['loaderSha256'];assert sha((root/'node_modules/js-yaml/lib/loader.js').read_bytes())==final['yaml']['loaderSha256']
(p/'source-excerpts.json').write_text(json.dumps({'sources':excerpts,'baseline_loader':{'version':'4.1.1','sha256':sha(old),'function':'mergeMappings','line_numbered_excerpt':'\n'.join(f'{i+1}: {line}' for i,line in enumerate(old.decode().splitlines()) if 303<=i<=327)},'semantics':'chargeMergeWork counts source mapping itself and each source key; separate default merge-sequence guard is 100 entries. Deterministic rejection semantics, not timing/performance proof.'},indent=2)+'\n')
print(json.dumps({'code_commit':code,'base':base,'four_useful_code_files_match':checked,'physical_yaml':'4.3.2','physical_parent':'@eslint/eslintrc 3.3.5','three_residual_families_unchanged':True,'only_dependency_changed':'js-yaml','global_lint_existing_failure_identical':True,'targeted_lint_code':js(p/'qualified-target-lint.json')['code'],'qualified_jsyaml_code':js(p/'qualified-jsyaml.json')['code'],'qualified_verify_code':js(p/'qualified-verify.json')['code'],'tarball_integrity_matches':True},indent=2))
