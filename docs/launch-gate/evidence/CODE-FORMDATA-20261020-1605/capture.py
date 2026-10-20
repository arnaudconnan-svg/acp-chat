import subprocess,sys,datetime,pathlib,json,hashlib
p=pathlib.Path('/workspace/acp-chat/docs/launch-gate/evidence/CODE-FORMDATA-20261020-1605');label=sys.argv[1];a=sys.argv[2:];start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(a,capture_output=True);end=datetime.datetime.now(datetime.timezone.utc).isoformat()
for k,b in [('stdout',r.stdout),('stderr',r.stderr)]: (p/f'{label}.{k}').write_bytes(b)
m=dict(argv=a,start=start,end=end,code=r.returncode,stdout_sha256=hashlib.sha256(r.stdout).hexdigest(),stderr_sha256=hashlib.sha256(r.stderr).hexdigest());(p/f'{label}.json').write_text(json.dumps(m,indent=2));print(json.dumps(m));print(r.stdout.decode());print(r.stderr.decode())
