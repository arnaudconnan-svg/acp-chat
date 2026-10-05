# Collecte Render standalone — IAM et inventaire professionnel

Commande préparée pour Work ; **non exécutée dans Cloud**. À coller dans le Shell
Render du service déjà démarré, depuis son répertoire applicatif. Node ≥18,
dotenv et credentials locaux existants suffisent ; pas de gcloud, SDK Firebase,
`require server.js`, logger, listener, LLM, SMTP ou fichier écrit. Elle authentifie
le seul principal attendu par JWT OAuth en mémoire, sans imprimer clé/token.

Par défaut `M0M1_METADATA_ACTION=iam` : uniquement métadonnées Google Cloud.
Pour l'inventaire explicitement demandé, recopier la même commande en remplaçant
`iam` par `identities` : uniquement noms de clés en mémoire et champs
`roles`, `active`, `authorizationVersion` de `professionalIdentities`, puis
compteurs agrégés. Jamais `/users`, conversations/messages, email, displayName,
passwordHash, sessions, grants ou autres données. Aucun PATCH/PUT/DELETE ; les
POST OAuth/testIamPermissions/getIamPolicy sont des opérations d'authentification
ou de lecture, pas des mutations IAM.

```sh
M0M1_METADATA_ACTION=iam node - <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PROJECT = 'facilitat-io';
const PRINCIPAL = 'firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com';
const DATABASE = 'https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/';
const CRM = `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}`;
const SA = `https://iam.googleapis.com/v1/projects/${PROJECT}/serviceAccounts/${encodeURIComponent(PRINCIPAL)}`;
const action = process.env.M0M1_METADATA_ACTION || 'iam';
let failures = 0;
const emit = value => console.log(JSON.stringify(value));
const apiCode = value => typeof value === 'string' && /^[A-Za-z0-9_.\/-]{1,128}$/.test(value) ? value : null;
function refusal(label, response, data) {
  failures++;
  const e = data?.error;
  emit({action: label, ok: false, httpStatus: response.status,
    apiCode: typeof e?.code === 'number' ? e.code : null,
    apiStatus: apiCode(e?.status), oauthError: typeof e === 'string' ? apiCode(e) : null,
    reasons: (e?.details || []).filter(x => x && typeof x === 'object')
      .map(x => apiCode(x.reason)).filter(Boolean)});
}
async function jsonRequest(label, url, options) {
  try {
    const response = await fetch(url, {redirect: 'error',
      signal: AbortSignal.timeout(15000), ...options});
    let data = null;
    try { data = await response.json(); } catch {}
    if (!response.ok) { refusal(label, response, data); return null; }
    if (data === null && label !== 'identity_field' && label !== 'identity_keys') {
      failures++; emit({action: label, ok: false, httpStatus: response.status,
        code: 'invalid_metadata_response'}); return null;
    }
    return {data, httpStatus: response.status};
  } catch (error) {
    failures++;
    emit({action: label, ok: false, code: 'metadata_transport_failure',
      transportCode: apiCode(error?.cause?.code) || apiCode(error?.name)});
    return null;
  }
}
(async () => {
  if (!['iam','identities'].includes(action)) throw new Error('invalid_action');
  require('dotenv').config({quiet: true});
  const file = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim();
  if (file && path.extname(file).toLowerCase() !== '.json') throw new Error('credential_not_json');
  const account = file ? JSON.parse(fs.readFileSync(path.resolve(file),'utf8'))
    : JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
  if (account?.project_id !== PROJECT || account?.client_email !== PRINCIPAL ||
    new URL(process.env.FIREBASE_DATABASE_URL || '').href !== DATABASE ||
    typeof account?.private_key !== 'string') throw new Error('credential_target_mismatch');
  const scopes = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
  const timestamp = Math.floor(Date.now()/1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:PRINCIPAL,
    scope:scopes,aud:'https://oauth2.googleapis.com/token',iat:timestamp,exp:timestamp+3600})}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256',Buffer.from(unsigned),account.private_key).toString('base64url')}`;
  const auth = await jsonRequest('oauth', 'https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()});
  if (!auth || typeof auth.data?.access_token !== 'string') {
    if (auth) { failures++; emit({action:'oauth',ok:false,code:'oauth_token_missing'}); }
    return;
  }
  const headers = {Authorization:`Bearer ${auth.data.access_token}`};
  const readPost = (label,url,body) => jsonRequest(label,url,{method:'POST',
    headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
  emit({action:'context',ok:true,project:PROJECT,principal:PRINCIPAL,
    credentialSource:file?'path':'json',mode:action});
  if (action === 'iam') {
    const projectPermissions = ['resourcemanager.projects.get','resourcemanager.projects.getIamPolicy',
      'firebase.projects.get','firebasedatabase.instances.get','firebasedatabase.instances.list',
      'firebasedatabase.instances.update','firebasedatabase.data.get','firebasedatabase.data.update'];
    const serviceAccountPermissions = ['iam.serviceAccounts.get','iam.serviceAccounts.getIamPolicy',
      'iam.serviceAccountKeys.list','iam.serviceAccountKeys.get'];
    for (const [label,url,requested] of [
      ['project_permissions',`${CRM}:testIamPermissions`,projectPermissions],
      ['service_account_permissions',`${SA}:testIamPermissions`,serviceAccountPermissions]]) {
      const r = await readPost(label,url,{permissions:requested});
      if (r) {
        const granted = new Set(Array.isArray(r.data?.permissions)?r.data.permissions:[]);
        emit({action:label,ok:true,httpStatus:r.httpStatus,resource:label==='project_permissions'?PROJECT:PRINCIPAL,
          permissions:requested.map(permission=>({permission,granted:granted.has(permission)}))});
      }
    }
    const policy = await readPost('principal_project_bindings',`${CRM}:getIamPolicy`,
      {options:{requestedPolicyVersion:3}});
    if (policy) emit({action:'principal_project_bindings',ok:true,httpStatus:policy.httpStatus,
      bindings:(Array.isArray(policy.data?.bindings)?policy.data.bindings:[])
        .filter(b=>Array.isArray(b.members)&&b.members.includes(`serviceAccount:${PRINCIPAL}`))
        .map(b=>({role:apiCode(b.role),conditional:!!b.condition}))});
    const keys = await jsonRequest('principal_key_metadata',`${SA}/keys`,{headers});
    if (keys) emit({action:'principal_key_metadata',ok:true,httpStatus:keys.httpStatus,
      keys:(Array.isArray(keys.data?.keys)?keys.data.keys:[]).map(k=>({
        keyId:apiCode(String(k.name||'').split('/').pop()),
        matchesConsumedKey:String(k.name||'').split('/').pop()===account.private_key_id,
        validAfterTime:typeof k.validAfterTime==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(k.validAfterTime)?k.validAfterTime:null,
        validBeforeTime:typeof k.validBeforeTime==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(k.validBeforeTime)?k.validBeforeTime:null,
        disabled:typeof k.disabled==='boolean'?k.disabled:null,
        keyType:['USER_MANAGED','SYSTEM_MANAGED'].includes(k.keyType)?k.keyType:null,
        keyOrigin:['GOOGLE_PROVIDED','USER_PROVIDED'].includes(k.keyOrigin)?k.keyOrigin:null}))});
  } else {
    const base = `${DATABASE}professionalIdentities`;
    const root = await jsonRequest('identity_keys',`${base}.json?shallow=true`,{headers});
    if (!root) return;
    if (root.data!==null && (typeof root.data!=='object'||Array.isArray(root.data))) {
      failures++;emit({action:'identity_inventory',ok:false,code:'invalid_identity_container'});return;
    }
    const all = Object.keys(root.data||{}), valid = all.filter(id=>/^[A-Za-z0-9_-]{1,128}$/.test(id));
    const selected = valid.slice(0,100), known = ['practitioner','commercial_support','technical_support','administrator'];
    const result = {action:'identity_inventory',ok:true,total:all.length,
      inspected:0,invalidIds:all.length-valid.length,complete:valid.length<=100,
      active:0,inactive:0,invalidActive:0,validVersion:0,invalidVersion:0,
      invalidRoles:0,roles:Object.fromEntries(known.map(role=>[role,0])),readFailures:0};
    for (const id of selected) {
      const rows = [];
      for (const field of ['roles','active','authorizationVersion'])
        rows.push(await jsonRequest('identity_field',`${base}/${encodeURIComponent(id)}/${field}.json`,{headers}));
      if (rows.some(x=>!x)) { result.readFailures++;result.complete=false;continue; }
      const [roles,active,version] = rows.map(x=>x.data);
      result.inspected++;
      if (active===true) result.active++; else if(active===false)result.inactive++; else result.invalidActive++;
      if(Number.isSafeInteger(version)&&version>=0)result.validVersion++;else result.invalidVersion++;
      if(!Array.isArray(roles)||!roles.length||!roles.every(role=>known.includes(role)))result.invalidRoles++;
      else for(const role of new Set(roles))result.roles[role]++;
    }
    if(result.invalidIds)result.complete=false;
    result.ok=result.readFailures===0;
    emit(result);
  }
})().catch(error => {
  failures++;
  const allowed = ['invalid_action','credential_not_json','credential_target_mismatch'];
  emit({action:'setup',ok:false,code:allowed.includes(error.message)?error.message:'metadata_setup_failed'});
}).finally(() => {if(failures)process.exitCode=1;});
NODE
```

Sorties IAM : permissions **demandées** accordées/refusées à ce principal sur le
projet et le compte ; bindings projet filtrés sur ce seul principal ; métadonnées
de ses clés uniquement. Le POST `testIamPermissions` ne demande aucune permission
IAM préalable pour le projet, mais OAuth/API/network peuvent encore refuser.
`httpStatus`, `apiCode`, `apiStatus`, `reasons` ou `oauthError` reprennent les codes
de refus reçus sans corps brut/message/clé/token. Un 403 policy/keys n'est pas un
refus global RTDB ; un HTTP 200 sans permission retournée est une liste vide,
pas un refus API. Ne pas accorder de nouveaux droits au compte applicatif pour
faire réussir la collecte : Work peut employer son accès opérateur existant.

Limites : test projet, liste de permissions finie ; pas un inventaire exhaustif
des droits ni une preuve de conditions sur chaque chemin RTDB. Les bindings
directs ne couvrent pas seuls héritage/groupes/deny ; `conditional:true` impose
un examen opérateur de la condition. `data.update` peut être demandé et retourné
sans effectuer une écriture. La lecture des rôles professionnels, si exécutée,
prouve seulement l'accès à ces métadonnées, pas à toutes les données de la base.

L'inventaire professionnel est limité à 100 IDs : `complete:false` signale un
inventaire partiel, jamais une clôture ; aucune continuation ne sort les IDs dans
le chat. L'unicité email/hashes n'est volontairement pas inspectée ici : c'est
un contrôle borné de provisioning séparé, sans contenu utilisateur. Compteurs de
rôles cumulés non exclusifs ; absence/malformation comptée comme telle. Le mode
IAM n'accède jamais à la RTDB ; le mode identities ne lit aucun contenu de fiche.

Contrats officiels consultés pour cette préparation :
[testIamPermissions projet](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/testIamPermissions),
[métadonnées des clés](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts.keys/list),
[permissions RTDB get/update](https://firebase.google.com/support/guides/cloud-audit-logging/firebase-realtime-database?hl=fr).
