import pathlib,subprocess,json,hashlib,datetime,re
root=pathlib.Path('/workspace/acp-chat');p=root/'docs/launch-gate/evidence/CODE-UX-ADMIN-20261021-1500'
code='e7b03af936713ad8850ef087b09905cfcb99d811';base='b745f01c49230b88c42adf8848e353c84c1d1b76'
def git(*a):return subprocess.check_output(['git',*a],cwd=root)
def sha(b):return hashlib.sha256(b).hexdigest()
assert git('rev-parse','HEAD').decode().strip()==code
assert git('rev-parse',code+'~2').decode().strip()==base
files=git('diff','--name-only',base,code).decode().splitlines()
checked={}
for file in files:
 data=(root/file).read_bytes();assert data==git('show',code+':'+file);checked[file]={'sha256':sha(data),'git_show_equals_tested_checkout':True}
assert git('show',base+':scripts/synthetic/guard.cjs')==(root/'scripts/synthetic/guard.cjs').read_bytes()
assert git('show',base+':package-lock.json')==(root/'package-lock.json').read_bytes()
commands=[]
for label in ['qualified-unit','qualified-browser','qualified-lint','qualified-syntax','qualified-professional','qualified-consent','qualified-isolation','qualified-verify','syntax-server','syntax-inline','runtime','chromium-version']:
 m=json.loads((p/(label+'.json')).read_text());assert m['code']==0
 for stream in ['stdout','stderr']:assert sha((p/(label+'.'+stream)).read_bytes())==m[stream+'_sha256']
 commands.append({'capture':label+'.json',**m})
for name in ['admin.html','pros.html','pros-login.html']:
 for i,body in enumerate(re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>',(root/'public'/name).read_text(),re.S)):
  if body.strip():assert body==pathlib.Path('/workspace/work/uxadmin/'+name+str(i)+'.js').read_text()
renders={f.name:sha(f.read_bytes()) for f in sorted((p/'renders').glob('*.png'))};assert len(renders)==10
browser=[json.loads(line) for line in (p/'qualified-browser.stdout').read_text().splitlines() if line.startswith('{')]
assert {b['viewport'] for b in browser}=={'desktop','mobile'}
assert all(b['externalNetwork'] is False and all(r['reason'] for r in b['requests']) for b in browser)
receipt={'code_commit':code,'base':base,'technical_commits':git('rev-list','--reverse',base+'..'+code).decode().splitlines(),'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime_observed_at_receipt':json.loads((p/'runtime.stdout').read_text()),'chromium':(p/'chromium-version.stdout').read_text().strip(),'runtime_limit':'Resolved under same env-i PATH as tests; no per-command contemporaneous version capture claimed. Browser uses the recorded /usr/bin/chromium.','files':checked,'guard_unchanged':True,'lock_unchanged':True,'commands':commands,'render_sha256':renders,'browser_boundaries':'Real frontend served through Playwright route fulfill; all API responses are synthetic route doubles, all unexpected origins aborted. Chromium launched with native one-command network permission for required local IPC; no server/provider network in fixtures. M0 unchanged and used for backend/unit/verify checks; browser driver necessarily runs separately from its child-process-denying guard.','limitations':['No deployed authentication or personal professional account tested','No Firebase/SMTP/Mistral or real conversation/corpus','Role/consent/audit backend verified separately with existing genuine Express synthetic harnesses','Known inherited global lint baseline not rerun; targeted lint code 0 with eleven existing server warnings']}
(p/'tested-code-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'code_commit':code,'base':base,'checked_files':len(checked),'all_git_show_hashes_match':True,'guard_and_lock_unchanged':True,'qualified_commands_all_code_0':True,'screenshots':len(renders),'rendered_viewports':[b['viewport'] for b in browser],'audit_reason_present_every_synthetic_protected_request':True},indent=2))
