import pathlib,json,hashlib,subprocess
p=pathlib.Path('docs/launch-gate/evidence/CODE-PROMOTE-SECURITY-20261024-0027');rows=[]
for label in ['main-audit-all','main-audit-prod','candidate-audit-all','candidate-audit-prod','final-audit-all','final-audit-prod']:
 d=json.loads((p/(label+'.stdout')).read_text());assert d['auditReportVersion']==2
 unique={a['url']:a for v in d['vulnerabilities'].values() for a in v['via'] if isinstance(a,dict)}
 severities={s:sum(a['severity']==s for a in unique.values()) for s in ['critical','high','moderate','low']}
 rows.append(dict(label=label,vulnerable_package_counts=d['metadata']['vulnerabilities'],unique_advisories=len(unique),unique_advisory_severity_counts=severities,advisories=[dict(url=a['url'],severity=a['severity'],range=a['range']) for a in unique.values()]))
before=json.loads((p/'candidate-audit-all.stdout').read_text())['vulnerabilities'];after=json.loads((p/'final-audit-all.stdout').read_text())['vulnerabilities'];assert set(after)=={'fast-copy','protobufjs'}
for name in after:assert before[name]==after[name]
physical=[]
for label,root,commit in [('main-audit-all',pathlib.Path('/workspace/work/promote/rollback'),'11a41e9ea6765418737ad7f8e2b8a31fe404b9b1'),('final-audit-all',pathlib.Path('/workspace/acp-chat'),subprocess.check_output(['git','rev-parse','HEAD']).decode().strip())]:
 lock=json.loads((root/'package-lock.json').read_text());audit=json.loads((p/(label+'.stdout')).read_text())
 for name,v in audit['vulnerabilities'].items():
  for node in v['nodes']:
   f=root/node/'package.json';pkg=json.loads(f.read_text());assert pkg['version']==lock['packages'][node]['version'];physical.append(dict(commit=commit,name=name,path=str(f),physical_version=pkg['version'],lock_version=lock['packages'][node]['version'],package_json_sha256=hashlib.sha256(f.read_bytes()).hexdigest()))
output=dict(audits=rows,residuals_exactly_unchanged=True,physical_vulnerable_package_metadata=physical)
(p/'audit-summary.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(output,indent=2))
