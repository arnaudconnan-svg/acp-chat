import subprocess,sys,datetime,json,pathlib,hashlib
out=pathlib.Path('docs/launch-gate/evidence/CODE-UX-AUTH-20261024-1447')
label=sys.argv[1]; argv=sys.argv[2:]
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(label+'.stdout')).open('wb') as stdout, (out/(label+'.stderr')).open('wb') as stderr:
    p=subprocess.run(argv,stdout=stdout,stderr=stderr)
data=dict(argv=argv,start=start,end=datetime.datetime.now(datetime.timezone.utc).isoformat(),code=p.returncode)
for stream in ['stdout','stderr']:
    data[stream+'_sha256']=hashlib.sha256((out/(label+'.'+stream)).read_bytes()).hexdigest()
(out/(label+'.json')).write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data))
sys.exit(p.returncode)
