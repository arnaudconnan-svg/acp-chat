import subprocess,pathlib,hashlib,json
root=pathlib.Path('/workspace/acp-chat');target=pathlib.Path('/workspace/work/promote/rollback');old='11a41e9ea6765418737ad7f8e2b8a31fe404b9b1';candidate='64efa303661068f3af871232a0cc578ccdf25a2c'
files=['package.json','package-lock.json','lib/runtime-schemas.js','server.js','lib/config.js','scripts/synthetic/guard.cjs']
def git(*args):return subprocess.check_output(['git','-C',str(root),*args])
def sha(b):return hashlib.sha256(b).hexdigest()
rows=[]
# Restore code artifacts only inside the isolated checkout. No data/docs,
# deployment config, secrets or network are read or modified.
for f in files:
 expected=git('show',old+':'+f);before=(target/f).read_bytes();assert before==expected
 candidate_bytes=git('show',candidate+':'+f);(target/f).write_bytes(candidate_bytes)
 assert (target/f).read_bytes()==candidate_bytes
 (target/f).write_bytes(expected)
 assert (target/f).read_bytes()==expected
 rows.append(dict(file=f,candidate_sha256=sha(candidate_bytes),restored_sha256=sha(expected),restored_matches_main=True))
assert subprocess.check_output(['git','-C',str(target),'rev-parse','HEAD']).decode().strip()==old
print(json.dumps(dict(return_commit=old,candidate=candidate,isolated_checkout=str(target),files=rows,restoration='candidate code artifacts replaced by exact main artifacts and hashes rechecked',data_touched=False,deployment_performed=False,secrets_read_or_modified=False,live_NODE_VERSION_verified=False),indent=2))
