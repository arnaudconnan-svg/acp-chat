import pathlib,json,hashlib,base64
p=pathlib.Path(__file__).parent;root=pathlib.Path('/workspace/acp-chat');rows=[]
for label,file in [('node-metadata','node-linux-x64-22.23.4.tgz'),('bodyparser-metadata','body-parser-2.4.0.tgz'),('zod-metadata','zod-4.6.6.tgz')]:
 m=json.loads((p/(label+'.stdout')).read_text());b=(pathlib.Path('/workspace/work/promote')/file).read_bytes();assert 'sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()==m['dist']['integrity'];rows.append(dict(tarball=file,version=m['version'],integrity_verified=True,sha256=hashlib.sha256(b).hexdigest(),signatures_sigstore_independently_verified=False))
for installed,unpacked in [('node_modules/body-parser/lib/read.js','body-fixed/package/lib/read.js'),('node_modules/zod/v4/core/schemas.cjs','zod-fixed/package/v4/core/schemas.cjs')]:
 b=(root/installed).read_bytes();assert b==(pathlib.Path('/workspace/work/promote')/unpacked).read_bytes();rows.append(dict(physical_file=installed,sha256=hashlib.sha256(b).hexdigest(),equals_official_tarball_source=True))
(p/'provenance.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(rows,indent=2))
# Small exact public source snippets with line numbers, never app data.
with (p/'public-source-excerpts.txt').open('w') as out:
 for name,a,b in [('node_modules/body-parser/lib/read.js',150,173),('node_modules/zod/v4/core/schemas.cjs',863,886),('node_modules/zod/v4/core/schemas.cjs',911,929)]:
  text=(root/name).read_text();out.write(name+' SHA256='+hashlib.sha256(text.encode()).hexdigest()+'\n');out.writelines(str(i)+': '+line+'\n' for i,line in enumerate(text.splitlines(),1) if a<=i<=b)
