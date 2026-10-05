# Checkpoint opérationnel M0/M1 — 5 octobre 2026

Reprise depuis `3a137d99b886f4bc3f1a5e03fc98b4f781a3ddba`, checkout propre,
PR27 ouverte draft. Sources examinées : `f20d84f` et HEAD M1. Les résultats acquis
au SHA code/tests `3db45bb` et leurs empreintes sont inchangés. Lecture de sources
et docs seulement : aucun boot, test global ou accès réel Cloud aux services.

## Architecture et preuves reçues de Work

**Pas de production publique distincte actuellement : beta validation, main future
bêta ouverte après pré-FF ; Firebase partagé intentionnel et non bloquant par
principe. Aucun projet/base Firebase à créer.** Configuration des deux services,
rotations nécessaires et préparation des identités prévues sont autorisées M0/M1,
après satisfaction des prérequis vérifiables ; aucun nouveau GO général.
Aucune fusion beta/main avant clôture des blocages ; aucune fusion main avant bilan
final. M2/purge irréversible exclus ; droits/ressources non définis gardent leurs
contrôles propres.

Work a généré quatre secrets de 512 bits, distincts, et configuré les deux services
par merge Render MCP. L'API a automatiquement redéployé le code `f20d84f`, sans
fusion : beta `dep-db1tcp9srm7s73d684ig`, main `dep-db1tcsm0tbcc73cc93hg`, live,
terminés à **18:56:02 Europe/Paris (16:56:02 UTC)**. Runtime shell des deux : deux
secrets dédiés présents/forts/distincts, projet `facilitat-io`, principal
`firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com`, même RTDB
`https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/`,
`REFRESH_EMERGENCY_ON_BOOT=false`. PUBLIC_APP_URL beta est celui de beta ; main
`https://facilitat.io`. Aucune valeur de secret reçue ou consignée.

Contrôles Work standalone sans cookie sur les deux PUBLIC_APP_URL : `/health`
HTTP200, status=ok, SHA `f20d84f`, Cache-Control=no-store ; `/api/auth/session`
HTTP200, authenticated=false, user=null. Une instance stable chacune sur
18:55–19:02 Europe/Paris (16:55–17:02 UTC). Work atteste aucun appel provider ni
écriture métier de ces contrôles ; checkpoint externe séquence17 durable.
Ce sont des preuves Work, pas des commandes réexécutées par Cloud.

Console Firebase : racine `.read=false/.write=false`, seuls index
`messages.conversationId` et `users.email`. IAM console Google Cloud :
**Site Unavailable**. Droits du principal et liste de ses clés non encore attestés.

## Consommation des sources et effets

`lib/config`, `auth-session`, `auth-password`, `emergency-updater`, `health` sont
identiques entre les deux versions.

| Sujet | `f20d84f` | HEAD M1 |
| --- | --- | --- |
| Secrets dédiés | Prioritaires sur SESSION_SECRET/ADMIN_PASSWORD/repli littéral | Obligatoires, ≥32 caractères après trim, aucun repli ; distinction non imposée par le code mais attestée par Work |
| Utilisateur | Cookie HMAC 30 jours, cache puis reconstruction, authVersion RTDB | Même codec ; secrets utilisateur distincts empêchent copie interservices à froid ; authVersion partagé révoque sur les deux |
| Professionnel | Cookie HMAC 24 h, reconstruction héritée par scope et accès codés en dur | Opaque 64 hex, fiche `professionalSessions/<sha256(token)>`, identité/rôles/version relus, révocation durable |
| Secret professionnel M1 | Signature cookie héritée | HMAC des références, **pas** signature/liaison du token durable à un service |
| Firebase | PATH credential prioritaire sur JSON, credential.cert et URL explicite | Même choix ; aucun ADC ou databaseAuthVariableOverride |

Le redémarrage sous code live avec les nouveaux secrets invalide les anciens
cookies de ce service après perte des caches. Il ne retire pas les mots de passe
codés en dur ni la reconstruction héritée : retrait par M1, sans les réutiliser.
Les cookies sont host-only, HttpOnly/Secure/SameSite=Lax. Quand les deux services
seront M1, un token professionnel copié manuellement pourra être accepté sur
l'autre : lookup/identité/version communs, aucune audience de service. Sa révocation
est commune ; changer le secret professionnel seul ne le révoque pas. Les refs
HMAC diffèrent par service. Partage explicite, sans prétendre à une isolation.

Boot réel : listener HTTP et lecture/listener `adminSettings/mailsEnabled` ;
logger peut créer/pruner des fichiers si `LOG_PERSIST=true` (défaut, 14 jours).
`REFRESH_EMERGENCY_ON_BOOT=false` coupe le rafraîchissement à cinq minutes, **pas
le timer Wikidata inconditionnel à 24 h** avec écriture du fichier local. SMTP
est construit mais pas envoyé au seul boot ; pas de LLM lancé au seul boot dans
les blocs inspectés. Trafic existant peut appeler les providers. Jobs reset,
biométrie et requêtes/progress locaux sont perdus au restart. Aucun boot de
collecte : les commandes standalone ne chargent ni server/logger ni SDK réseau.
`/api/auth/session` sans cookie revient avant l'usage ; authentifiée, cette route
peut persister le renouvellement d'enveloppe, donc pas de sonde de contenu.

## Commandes immédiates Work et rotations réellement restantes

La [commande standalone prête à copier](M0-M1-render-readonly.md) utilise le
credential local sans gcloud : mode `iam` pour permissions/bindings/clé-métadonnées,
mode `identities` pour inventaire borné des compteurs/roles/état. Chaque refus sort
HTTP/API status/reason ou OAuth code exact, sans clé/token/corps brut. Permissions
mesurées ne sont pas déduites du seul nom AdminSDK. Les règles racine n'empêchent
pas un principal ayant les droits administratifs d'accéder via Admin SDK.

- **Déjà fait :** quatre nouveaux secrets dédiés et redémarrages des deux services.
  Ne pas les régénérer sans nouvelle raison concrète.
- **À retirer avec les dépendances vérifiées :** anciens ADMIN_PASSWORD/SESSION_SECRET
  devenus inutiles sous M1 ; passwords/replis littéraux publiés sont abandonnés
  par le code M1 et ne deviennent pas des mots de passe individuels. Leur rotation
  env seule ne supprime pas les chemins codés en dur de `f20d84f`.
- **Révocation ciblée si sessions M1 préexistantes :** revoked ou hausse de
  authorizationVersion ; une rotation HMAC seule ne suffit pas. Ne pas créer ni
  purger des sessions pour les tester.
- **AdminSDK/Mistral/SMTP :** rotation seulement si exposition/compromission,
  expiration ou nécessité opérationnelle attestée. La présence du principal ou
  d'un nom d'env ne prouve pas une exposition de clé. Remplacer chez tous les
  consommateurs avant révocation d'une clé partagée ; pas d'élargissement IAM.
- **Index de login :** préparer `professionalIdentities.email` après inventaire ;
  ajout d'index seulement, sans changer les règles racine ni les index existants.
  `rtdb:index` M1 est verrouillé : ne pas le lancer ni le déverrouiller pour cela.

## Identités : entrées manquantes et préparation exacte

CJ4/CJ5 ne donnent **aucune liste nominative email→rôles**. Restent à fournir pour
chaque identité prévue : ID stable, email normalisé unique, displayName et rôles
explicitement choisis. Aucun nom/personne/affectation/grant déduit ou inventé.
Pas d'API/CLI de gestion des identités ; `/api/pros/login` et son alias admin
ne font qu'authentifier. Pas de provisioning Firebase Authentication.

Enregistrement `professionalIdentities/<id>` : email trim/lowercase, passwordHash
`scrypt:<sel hex 16 octets>:<hash hex 64 octets>` via `lib/auth-password`, active
(préparer false), roles non vide parmi practitioner/commercial_support/
technical_support/administrator, authorizationVersion entier sûr ≥0 (0 nouveau),
displayName lisible. ID ASCII alphanumérique/_/- de 1–128 caractères.

Préparation locale pure depuis checkout M1, **seulement une fois ces entrées
connues** ; fichier privé hors Git et aucun mot de passe dans argv/chat :

```sh
umask 077
export M0M1_PRO_ID='<id fourni>' M0M1_PRO_EMAIL='<email fourni>'
export M0M1_PRO_DISPLAY_NAME='<libellé fourni>' M0M1_PRO_ROLES='<tableau JSON des rôles fournis>'
export M0M1_IDENTITY_FILE='/tmp/m0m1-professional-identity.json'
read -r -s -p 'Mot de passe individuel nouveau : ' m0m1_password
printf '%s' "$m0m1_password" | node -e '
try {
  const fs=require("node:fs");
  const {hashPassword,isStrongPassword}=require("./lib/auth-password");
  const password=fs.readFileSync(0,"utf8"), id=process.env.M0M1_PRO_ID;
  const email=(process.env.M0M1_PRO_EMAIL||"").trim().toLowerCase();
  const displayName=(process.env.M0M1_PRO_DISPLAY_NAME||"").trim();
  const roles=JSON.parse(process.env.M0M1_PRO_ROLES||"null");
  const allowed=new Set(["practitioner","commercial_support","technical_support","administrator"]);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id||"") || !email || !displayName ||
    !Array.isArray(roles) || !roles.length || !roles.every(x=>allowed.has(x)) ||
    !isStrongPassword(password)) throw new Error("invalid_input");
  const record={email,displayName,passwordHash:hashPassword(password),active:false,
    roles:[...new Set(roles)],authorizationVersion:0};
  fs.writeFileSync(process.env.M0M1_IDENTITY_FILE,JSON.stringify({id,record}),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({prepared:true,active:false}));
} catch {console.log(JSON.stringify({prepared:false,code:"identity_preparation_failed"}));process.exitCode=1;}
'
unset m0m1_password
```

Work : inventaire sans email/hash d'abord ; puis unicité de l'email précis sur
le seul nœud professionnel, provisionnement sérialisé et transaction **sur l'ID
prévu uniquement**, `current === null ? record : undefined`. Aucun overwrite
ou écriture racine. Revérifier unicité, puis activation délibérée de la fiche
validée. Fiche existante : revue bornée des droits/version avant modification.
Login M1 crée les sessions ; aucune fiche session fabriquée. Affectation sous
`practitionerAssignments/<professionalId>/<userId>` seulement si fournie ; grant
créé par consentement utilisateur, jamais déduit d'un contact. Preuves sans email,
hash, contenu ou token : compteur/code/version/résultat. Aucun provisioning réel ici.

## Contrôles restants et seuil de livraison

1. Recevoir IAM effectif/bindings/clé-métadonnées ou refus exact et l'inventaire
   borné professionnel ; accès console IAM manquant ne vaut pas absence de GO.
2. Fournir la liste nominative/rôles prévue, résoudre unicité/index et provisioning
   borné ; confirmer les seules rotations encore nécessaires. Aucun vrai compte
   créé avant définition de ces entrées.
3. Intégrer ces preuves avant clôture des blocages et livraison beta. Main reste
   code hérité jusqu'au bilan final/pré-FF ; le partage n'impose pas une autre base.
   Aucune fusion pendant cette étape.
4. Après env, santé/SHA sans cookie sont **déjà contrôlés par Work**, pas à relancer
   pour les docs. `config:check` seul ne teste pas minimum/distinction des secrets.
   `smoke:ui:preff` force LLM : ne pas l'utiliser dans cette phase sans provider.
   À la future promotion, `preff:git:guard` vérifie Git/ascendance (pas de boot) ;
   synchronisation post-promotion obligatoire selon WORKFLOW, jamais avant.

Checkpoint docs seulement ; résultats acquis préservés, aucun nouveau test.
