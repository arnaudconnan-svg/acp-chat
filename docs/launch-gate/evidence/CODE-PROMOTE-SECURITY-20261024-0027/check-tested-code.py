import pathlib,subprocess,json,hashlib,datetime
root=pathlib.Path.cwd();p=pathlib.Path(__file__).parent;code='7dd3ce6f003a0cbe441fa68e367ce458abe9fedc';base='c6650835eec849655c9e92754a446a14c5928927';old='11a41e9ea6765418737ad7f8e2b8a31fe404b9b1'
def git(*a):return subprocess.check_output(['git',*a])
def sha(b):return hashlib.sha256(b).hexdigest()
assert git('rev-parse','HEAD').decode().strip()==code
files=['package.json','package-lock.json','lib/runtime-schemas.js','scripts/synthetic/promotion-security-harness.cjs','scripts/synthetic/guard.cjs','server.js'];rows=[]
for f in files:
 b=(root/f).read_bytes();committed=git('show',code+':'+f);assert b==committed;rows.append(dict(file=f,tested_sha256=sha(b),git_show_sha256=sha(committed),equal=True))
for f in ['scripts/synthetic/guard.cjs','server.js','public/admin.html','public/index.html','public/js/professional-review.js','scripts/synthetic/admin-review-browser.cjs','lib/config.js']:assert git('show',base+':'+f)==(root/f).read_bytes()
a=json.loads(git('show',base+':package-lock.json'));b=json.loads((root/'package-lock.json').read_bytes());assert a['packages'].keys()==b['packages'].keys();changed=[k for k in a['packages'] if a['packages'][k]!=b['packages'][k]];assert set(changed)=={'','node_modules/body-parser','node_modules/iconv-lite','node_modules/zod'}
labels=['runtime','candidate-ci','baseline-verify','baseline-admin','corrected-ci','exact-verify','exact-lint','qualified-admin','qualified-professional','qualified-isolation','qualified-admin-browser','real-sdk-compatibility','physical-check','provenance-check','restoration-check','restoration-syntax','restoration-schemas','restoration-final-verify','preff-check','candidate-audit-all','candidate-audit-prod','main-audit-all','main-audit-prod','final-audit-all','final-audit-prod'];commands=[]
for label in labels:
 m=json.loads((p/(label+'.json')).read_text())
 for stream in ['stdout','stderr']:assert sha((p/(label+'.'+stream)).read_bytes())==m[stream+'_sha256']
 assert m['code']==(1 if '-audit-' in label else 0),(label,m['code'])
 commands.append(dict(label=label,**m))
node=json.loads((p/'runtime.stdout').read_text());assert node['version']=='v22.23.4';assert '"node": "v22.23.4"' in (p/'exact-verify.stdout').read_text()
receipt=dict(code_commit=code,base_beta=base,return_main=old,checked_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),node_effective_tests=node['version'],node_path=node['execPath'],node_binary_sha256=sha(pathlib.Path(node['execPath']).read_bytes()),files=rows,changed_lock_entries=changed,all_other_lock_entries_unchanged=True,server_guard_admin_and_config_unchanged=True,commands=commands,limitations='Graphical deployed Chat gate belongs to Work and is not replaced; no deployed auth, Render rollback/config/secrets verification or promotion performed')
(p/'tested-code-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
