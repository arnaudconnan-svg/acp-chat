import datetime, hashlib, json, pathlib, subprocess, difflib
root = pathlib.Path('/workspace/acp-chat')
p = root / 'docs/launch-gate/evidence/CODE-BUSBOY-20261020-1526'
commit = 'cf1ff948b00c00bd633f14c3bde149e6fc7cd31c'
base = 'ae54db75761b90bc58786672c84f272798d93e33'
def sha(data): return hashlib.sha256(data).hexdigest()
def git(*args): return subprocess.check_output(['git', *args], cwd=root)
assert git('rev-parse', 'HEAD').decode().strip() == commit
assert git('rev-parse', commit + '^').decode().strip() == base
manifest = json.loads((p / 'tested-source-manifest.json').read_text())
files = ['package.json', 'package-lock.json', 'scripts/synthetic/guard.cjs', 'scripts/synthetic/busboy-harness.cjs']
checked = {}
for f in files:
    committed = git('show', commit + ':' + f)
    assert sha(committed) == manifest[f] == sha((root / f).read_bytes())
    checked[f] = {'sha256': manifest[f], 'commit_equals_tested_manifest_equals_checkout': True}
labels = ['syntax', 'syntax-guard', 'syntax-harness', 'final-busboy', 'final-isolation', 'final-verify', 'final-audit', 'regression-322', 'regression-323']
commands = []
for label in labels:
    record = json.loads((p / (label + '.json')).read_text())
    for stream in ['stdout', 'stderr']:
        file = p / (label + '.' + stream)
        if file.exists(): assert sha(file.read_bytes()) == record[stream + '_sha256']
    commands.append({'capture': label + '.json', **record})
runtime = json.loads(subprocess.check_output(['env', '-i', 'PATH=/usr/bin:/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin', 'node', '-p', 'JSON.stringify({version:process.version,execPath:process.execPath})']))
receipt = {'code_commit': commit, 'base': base, 'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'node_runtime': {**runtime, 'evidence': 'v24.19.0 observed before tests; same env-i PATH re-resolved for this receipt. No contemporaneous per-test Node version capture is claimed.'}, 'files': checked, 'final_commands': commands, 'scope': 'Proof-only follow-up; technical files unchanged; no verify rerun, data/corpus read, private-class loading or provider call.'}
(p / 'tested-code-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
physical = json.loads((p / 'physical-packages-manifest.json').read_text())
def source(relative, start, end, function):
    file = root / relative
    data = file.read_bytes()
    assert sha(data) == physical[relative]
    lines = data.decode().splitlines()
    return {'file': relative, 'function': function, 'sha256': sha(data), 'lines': [{'line': n, 'text': lines[n-1]} for n in range(start, end+1)]}
admin = source('node_modules/firebase-admin/lib/utils/api-request.js', 401, 419, 'AsyncRequestCall.handleMultipartResponse')
current = source('node_modules/@fastify/busboy/lib/types/multipart.js', 274, 287, 'Multipart.prototype.write')
oldfile = pathlib.Path('/workspace/work/busboy/v3.2.2/lib/types/multipart.js')
old = oldfile.read_bytes()
new = (root / current['file']).read_bytes()
diff = ''.join(difflib.unified_diff(old.decode().splitlines(True), new.decode().splitlines(True), fromfile='npm @fastify/busboy@3.2.2/lib/types/multipart.js', tofile='npm @fastify/busboy@3.2.3/lib/types/multipart.js', n=3))
assert '+  if (!this.parser.writable)' in diff
excerpts = {'admin': admin, 'busboy_323': current, 'busboy_322': {'file': str(oldfile), 'package_version': json.loads((oldfile.parents[2] / 'package.json').read_text())['version'], 'sha256': sha(old), 'function': 'Multipart.prototype.write', 'start_line': 274}, 'npm_322_to_323_diff': diff, 'provenance_limit': 'Public package physical sources already inspected; 3.2.3 files match captured physical manifest. Registry metadata and tarball integrity evidence remain unchanged. Sigstore signatures not independently verified.'}
assert excerpts['busboy_322']['package_version'] == '3.2.2'
(p / 'source-excerpts.json').write_text(json.dumps(excerpts, indent=2) + '\n')
print(json.dumps({'code_commit': commit, 'base': base, 'node': runtime, 'four_commit_manifest_checkout_matches': checked, 'captured_commands': len(commands), 'physical_source_hashes_match': True, 'source_excerpts': 'source-excerpts.json', 'receipt': 'tested-code-receipt.json', 'technical_code_unchanged': True}, indent=2))
