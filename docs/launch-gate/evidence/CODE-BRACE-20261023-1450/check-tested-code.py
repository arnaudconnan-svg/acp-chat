import pathlib,subprocess,json,hashlib,datetime
root=pathlib.Path.cwd(); p=root/'docs/launch-gate/evidence/CODE-BRACE-20261023-1450'
base='737b94156f23eadca27c5366dcf6c82853079bd0'; code='90673565e115939611926646cad56851d5bcd1d2'
def git(*args): return subprocess.check_output(['git',*args])
def sha(b): return hashlib.sha256(b).hexdigest()
assert git('rev-parse','HEAD').decode().strip()==code
assert git('remote','get-url','origin').decode().strip()=='https://github.com/arnaudconnan-svg/acp-chat.git'
assert git('rev-parse',code+'^').decode().strip()==base
files=['package.json','package-lock.json','scripts/synthetic/guard.cjs','scripts/synthetic/brace-harness.cjs']
hashes=[]
for f in files:
 committed=git('show',code+':'+f);current=(root/f).read_bytes();assert committed==current
 hashes.append(dict(file=f,tested_worktree_sha256=sha(current),git_show_sha256=sha(committed),equal=True))
assert git('show',base+':scripts/synthetic/guard.cjs')==(root/'scripts/synthetic/guard.cjs').read_bytes()
before=json.loads(git('show',base+':package-lock.json'));after=json.loads((root/'package-lock.json').read_bytes())
assert before['packages'].keys()==after['packages'].keys()
changed=[k for k in before['packages'] if before['packages'][k]!=after['packages'][k]]
assert changed==['node_modules/brace-expansion']
assert after['packages'][changed[0]]['dev'] is True
for k in set(before)-{'packages'}:assert before[k]==after[k]
assert before['packages']['node_modules/minimatch']==after['packages']['node_modules/minimatch']
assert before['packages']['node_modules/@eslint/eslintrc']==after['packages']['node_modules/@eslint/eslintrc']
final=(p/'final-brace.stdout').read_text();observed=json.JSONDecoder().raw_decode(final[final.index('{'):])[0]
assert observed['physical']['version']=='1.1.21'
labels=['npm-ci','final-brace','final-syntax','final-isolation','final-lint','final-verify','audit-before','audit-after','resolution-proof']
commands=[]
for label in labels:
 m=json.loads((p/(label+'.json')).read_text())
 for stream in ['stdout','stderr']:assert sha((p/(label+'.'+stream)).read_bytes())==m[stream+'_sha256']
 assert m['code']==(1 if label.startswith('audit-') else 0)
 commands.append(dict(label=label,**m))
receipt=dict(code_commit=code,base_commit=base,node_effective_tests=observed['node'],node_observation='final-brace.stdout (inside env-i/M0 process)',checked_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),files=hashes,changed_lock_entries=changed,all_other_lock_entries_unchanged=True,guard_unchanged=True,commands=commands)
(p/'tested-code-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
