# Checkpoint opérationnel M0/M1 — 5 octobre 2026

Reprise depuis `3a137d99b886f4bc3f1a5e03fc98b4f781a3ddba`, checkout propre,
PR27 ouverte draft. Sources examinées : `f20d84f` et HEAD M1. Les résultats acquis
au SHA code/tests `3db45bb` et leurs empreintes sont inchangés. Lecture de sources
et docs seulement : aucun boot, test global ou accès réel Cloud aux services.

Reprise séquence20 : [plan de clôture ciblé et helpers](M0-M1-closure-plan.md).
Propriétaire historique explicitement autorisé ; une identité active, rôle unique
`administrator`, aucun practitioner/support, affectation ou grant. Provisioning
et login/session/révocation réels acquis ; ne pas reprovisionner. Préparation et
échecs historiques conservés.

**Verdict final : M0/M1 clos — prêt pour protocole pré-FF et livraison vers main.**
IAM réduit et contrôlé beta/main, SDK qualifié et trois marqueurs nettoyés selon
les preuves Work finales ci-dessous. Pré-FF/livraison non exécutés ; PR27 draft
base beta, services f20d84f, protections HTTP M1 candidates non déployées.

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
`messages.conversationId` et `users.email`. IAM console et panneau Cloud Shell :
**Site Unavailable**. Les résultats bornés Work ci-dessous remplacent l'attente
de collecte ; ils ne constituent pas une qualification exhaustive des droits.

### Résultats finaux Work et correspondance des sources

Collecte sur les processus `server.js` : beta PID85, main PID84. Pour les deux :
`dotenvPresent=false`, `credentialMode=json`, `configSchemaOk=true`, secrets
dédiés présents/longueur minimale/distinction PASS, projet/principal/cible attendus
PASS, `REFRESH_EMERGENCY_ON_BOOT=false`, **`LOG_PERSIST=true`, rétention 14 jours**,
`NODE_ENV=production`, port10000. L'exploitation normale des logs est conservée ;
`LOG_PERSIST=false` n'est ni acquis ni un prérequis. L'empreinte runtime de
`server.js`, `e53e8469a084896b1ad58b19413c12dfa659a9f67db623f90df748168ba7d555`,
correspond exactement au SHA256 calculé par Cloud sur `git show f20d84f:server.js`.
La sonde `/api/auth/session` était explicitement sans cookie : retour avant tout
renouvellement d'usage.

| Contrôle Work | Résultat réel |
| --- | --- |
| OAuth beta | OK ; aucun token consigné |
| `testIamPermissions` projet beta, HTTP200 | `resourcemanager.projects.get`, `firebase.projects.get`, `firebasedatabase.instances.get/list/update`, `firebasedatabase.data.get/update` accordés ; `resourcemanager.projects.getIamPolicy=false` |
| Complément projet beta puis main, HTTP200 | `firebasedatabase.instances.delete=true`, `resourcemanager.projects.setIamPolicy=false`, `firebaseauth.users.delete=false` ; main confirme aussi `data.get/update` et `instances.get/list/update=true`, même projet/principal JSON |
| Bindings du principal, beta | HTTP403 `PERMISSION_DENIED`, aucune reason renvoyée |
| `service_account_permissions`, `principal_key_metadata`, beta | HTTP403 `PERMISSION_DENIED`, reason `SERVICE_DISABLED` |
| Inventaire `professionalIdentities`, mode identities | HTTP succès, total0, complete=true, active/inactive0, chaque rôle0, readFailures0 |

**Verdict historique avant réduction IAM :** cible partagée acceptable dans l'architecture actée ; droits de
données prouvés et **suppression d'instance excessive pour les accès métier M1
prouvée depuis les deux services**. Bindings, clés et ensemble complet des droits
restent non qualifiés. Les règles racine fermées ne bornent pas ces droits AdminSDK.
Aucune mutation IAM/RTDB ni compte créé ; aucun secret fournisseur déclaré compromis.

Précision officielle Work : `instances.get/update` portent les données ; `update`
porte aussi règles et enable/disable. Les noms `data.get/update` observés ne sont
pas une base de rôle custom documentée ni une garantie SDK. Inspection des bindings
et sonde SDK dédiée après réduction : [plan actuel](M0-M1-closure-plan.md).

**Correction IAM minimale à préparer sur le projet/principal existants :** rétablir
un accès opérateur déjà habilité à lire/modifier la policy, inspecter bindings et
héritage, identifier leurs rôles exacts et les autres consommateurs, puis retirer
les permissions de gestion d'instance inutiles en conservant les accès nécessaires.
Ne pas deviner un rôle, révoquer une clé, créer une base ou accorder `setIamPolicy`
à ce principal. Il ne peut pas se réduire lui-même ; UI/Cloud Shell indisponibles
et accès actuels insuffisants. Une modification future sera bornée à la policy
identifiée, avec contrôle des consommateurs et vérification des permissions après.
Ce blocage d'accès concret ne requiert aucun nouveau GO général M0/M1.

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
mode `identities` pour inventaire borné des compteurs/roles/état. Ces collectes ont
été exécutées par Work ; ne pas les répéter pour cette publication. Chaque refus sort
HTTP/API status/reason ou OAuth code exact, sans clé/token/corps brut. Permissions
mesurées ne sont pas déduites du seul nom AdminSDK. Les règles racine n'empêchent
pas un principal ayant les droits administratifs d'accéder via Admin SDK.

- **Déjà fait :** quatre nouveaux secrets dédiés et redémarrages des deux services.
  Ne pas les régénérer sans nouvelle raison concrète.
- **À retirer avec les dépendances vérifiées :** anciens ADMIN_PASSWORD/SESSION_SECRET
  devenus inutiles sous M1 ; passwords/replis littéraux publiés sont abandonnés
  par le code M1 et ne deviennent pas des mots de passe individuels. Leur rotation
  env seule ne supprime pas les chemins codés en dur de `f20d84f`.
- **Identités durables :** inventaire complet total0, aucun compte durable à
  migrer ni credential individuel existant à rotater identifié. Les sessions
  n'ont pas été inventoriées ; aucun reset/purge ou token fabriqué. Si une session
  M1 préexistante est ultérieurement identifiée, révocation ciblée/version ; la
  rotation HMAC seule ne suffit pas.
- **AdminSDK/Mistral/SMTP :** rotation seulement si exposition/compromission,
  expiration ou nécessité opérationnelle attestée. La présence du principal ou
  d'un nom d'env ne prouve pas une exposition de clé. Remplacer chez tous les
  consommateurs avant révocation d'une clé partagée ; pas d'élargissement IAM.
- **Index de login :** préparer `professionalIdentities.email` après inventaire ;
  ajout d'index seulement, sans changer les règles racine ni les index existants.
  `rtdb:index` M1 est verrouillé : ne pas le lancer ni le déverrouiller pour cela.

## Identités : entrées manquantes et préparation exacte

**Actualisation séquence20 :** les entrées du propriétaire sont connues et le rôle
unique d'exploitation `administrator` est désormais choisi et autorisé. Utiliser
uniquement le [helper actuel à TTY masquée](M0-M1-closure-plan.md), création atomique
du seul namespace professionnel encore vide et validation module exact, sans
credential dans fichier/env/args. Le schéma/préparation génériques ci-dessous
documentent l'étape antérieure ; ils ne sont pas la commande actuelle de provisioning.

CJ4/CJ5 ne donnent **aucune liste nominative email→rôles**. Restent à fournir pour
chaque identité prévue : ID stable, email normalisé unique, displayName, rôles
explicitement prévus et **canal privé de remise d'un nouveau credential**. Aucun
nom/personne/affectation/grant déduit ou inventé. Autre chemin borné possible :
migrer le **seul compte propriétaire déjà configuré dans le code hérité**. Lecture
de source sans publier son email/password : un email dans la configuration
professionnelle et un dans l'accès full, même email. Ce n'est pas une fiche durable
existante : inventaire total0. Réutiliser cette identité connue depuis la source
contrôlée, définir ID/libellé/rôles minimaux et canal de remise ; ne pas traduire
automatiquement « full » en administrator/practitioner, ni reprendre son ancien
password publié. Aucun autre acteur ajouté, aucune migration exécutée ici.
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

Work : inventaire sans email/hash acquis (total0) ; puis unicité de l'email précis sur
le seul nœud professionnel, provisionnement sérialisé et transaction **sur l'ID
prévu uniquement**, `current === null ? record : undefined`. Aucun overwrite
ou écriture racine. Revérifier unicité, puis activation délibérée de la fiche
validée. Fiche existante : revue bornée des droits/version avant modification.
Login M1 crée les sessions ; aucune fiche session fabriquée. Affectation sous
`practitionerAssignments/<professionalId>/<userId>` seulement si fournie ; grant
créé par consentement utilisateur, jamais déduit d'un contact. Preuves sans email,
hash, contenu ou token : compteur/code/version/résultat. Aucun provisioning réel ici.

## Contrôles restants et seuil de livraison

1. **IAM clos par les preuves finales Work :** rôle custom get/update exactement,
   delete/create/list non accordés dans beta/main. SDK qualifié et trois sondes
   nettoyées ; limitation initiale removed/ok=false conservée, cause non prouvée.
2. **Provisioning clos par la preuve finale Work ci-dessous :** seul `launch-owner`
   actif, `administrator` unique, saisie personnelle et validation réelle module M1
   acquises. Ne plus relancer le provisioning ni demander propriétaire/password.
3. Preuves intégrées, bilan M0/M1 clos ; pré-FF et livraison restent à exécuter.
   Main reste code hérité ; le partage n'impose pas une autre base.
   Aucune fusion pendant cette étape.
4. Après env, santé/SHA sans cookie sont **déjà contrôlés par Work**, pas à relancer
   pour les docs. `config:check` seul ne teste pas minimum/distinction des secrets.
   `smoke:ui:preff` force LLM : ne pas l'utiliser dans cette phase sans provider.
   Pas de garde pré-FF supplémentaire pour ce commit docs sans promotion.
   À la future promotion, `preff:git:guard` vérifie Git/ascendance (pas de boot) ;
   synchronisation post-promotion obligatoire selon WORKFLOW, jamais avant.

Checkpoint docs seulement ; résultats acquis préservés, aucun nouveau test.

Précision du helper préparé : email propriétaire dérivé seulement en mémoire de
la source live f20 épinglée et contrôlé par empreinte normalisée ; aucune constante
email en clair dans le helper courant, aucun eval du serveur/password legacy copié.
Résolveur ciblé validé (source exacte acceptée, source/empreinte altérées refusées),
aucune exécution Render à ce checkpoint de préparation Cloud. Preuves publiques :
launch-owner + administrator uniquement.

## Checkpoint Work historique — helper lancé jusqu'au préflight, en attente personnelle

Preuve réelle reçue de Work : helper SHA256
`c661db9f2d65efae8f82714ca4c5161dd7d294812a3b5b18134bddf0a26bcb3e`
téléchargé, empreinte vérifiée et démarré dans beta Web Shell, instance `c44mq`.
L'UI présente exactement « Prêt. Passation à l’utilisateur : saisir et confirmer
lui-même le nouveau credential. » puis « Nouveau mot de passe (entrée masquée) : ».
Le prompt atteste les gardes modules exacts, service/SHA f20, source owner/hash,
config projet/base/principal et namespace professionnel vide.

**À ce checkpoint historique, le process attend la saisie. Aucun password saisi/généré, aucune fiche/session
écrite, aucun login/session/révocation testé.** Work passe la main après ce checkpoint
durable. Préparation Cloud historique inchangée ; exécution Work limitée au
préflight, aucun provisioning accompli. Identité publique : launch-owner + administrator.

IAM reste bloqué : console indisponible, propriétaire Firebase déjà authentifié,
rôle réellement attribué inconnu. Seul besoin humain minimal à ce stade :
capture/export des seuls bindings du principal depuis console opérateur accessible,
sans retrait à l'aveugle ni nouveau GO général. PR27 draft, aucune fusion.
Cette publication ne touche que docs/evidence ; aucun nouveau contrôle, helper ou code modifié.

## Reprise historique après `78d60f6` — correction opérateur ciblée, prête pour revue Work

Work : deux tentatives de l'ancien helper `c661db9f…` sur beta `c44mq`, terminées
avant création. Première avant confirmation ; seconde atteint Confirmation.
Seconde sortie : `moduleExact/ownerSourceExact/ownerEmailExpected/contextOk/preflightOk`
et `cleanupOk=true` ; `confirmed/created/loginOk/uniqueAdministrator/revoked/`
`revokedSessionRejected/identityDisabledOnFailure/ok=false`. Aucun compte/session
créé, aucun résultat login/session/révocation acquis. Cause indéterminée, catch
ancien silencieux ; aucune saisie, taille ou erreur brute retenue dans les preuves.

Correction **du seul helper opérateur**, SHA256
`999309f751a68121cc36ffee5a7e45ab70b5bc624089b6a936c4bb8c07bb674d` :
lecture masquée continue des deux lignes, normalisation CR/LF/CRLF entre événements,
reste de collage conservé, EOF refusé ; motifs fixes à liste blanche. Confirmation
vide CR/LF séparés, collage tronqué et EOF pendant reproduits sur le lecteur ancien
archivé. Cause Render non attribuée ; politique force/limites initiales/gardes/
atomicité/modules M1 exacts inchangés. [Notice et transfert épinglé](M0-M1-closure-plan.md).

Commande réellement exécutée :
`node --require ./scripts/synthetic/guard.cjs docs/launch-gate/operators/owner-provision-input-test.cjs`
— **32 cas PASS, code0**, entrées synthétiques uniquement, aucun SDK réel/réseau,
[preuve](evidence/owner-tty-targeted.json). Syntaxe/helper/empreintes/transfert et
`git diff --check` ciblés contrôlés ; aucune suite acquise relancée, aucun boot,
service Render, fournisseur, provisioning ou déploiement exécuté par Cloud.
Nouvelle version préparée pour revue Work, pas encore exécutée dans Render.

Nouvelle observation IAM utilisateur : projet et principal attendus ; libellé
tronqué « Administrateur Firebase Realtime… », case rôles fournis Google non
cochée. `roles/firebasedatabase.admin` est la correspondance attendue à qualifier,
pas un binding exact/exhaustif confirmé. Conditions/héritage/autres consommateurs
restent à inspecter ; GCP indisponible à Work, aucun IAM modifié, capture non publiée.
Plan custom get/update inchangé, couplage règles/activation conservé.

Prochaines actions : revue Work puis démarrage du nouveau helper et passation
personnelle masquée au seul `launch-owner` + `administrator` ; intégrer résultats
réels login/session/révocation. Pour IAM, obtenir export borné des bindings du
principal via opérateur accessible avant réduction, jamais retrait à l'aveugle.
Aucun nominatif/rôle manquant ni nouveau GO général. PR27 draft, aucune fusion
beta/main, M2 exclu ; code et résultats acquis préservés.

Dernière preuve Work : diff de saisie et sortie réelle des 32 cas PASS relus ;
gardes et modules M1 conservés. Aucun contrôle supplémentaire requis. Cette
correction reste préparée, pas exécutée dans Render ; prochaine action Work :
transfert épinglé puis passation personnelle au champ sécurisé.

## Checkpoint historique Work — identité active, IAM alors restant

Render beta `c44mq`, helper `24cf6272ea270040f3b593af85800988bed0f4eb`, SHA256
`999309f751a68121cc36ffee5a7e45ab70b5bc624089b6a936c4bb8c07bb674d` :
après saisie personnelle, Work observe `id=launch-owner` et
`moduleExact/ownerSourceExact/ownerEmailExpected/contextOk/preflightOk/confirmed/`
`created/loginOk/uniqueAdministrator/revoked/revokedSessionRejected/inputCleanupOk/`
`cleanupOk/ok=true` ; `identityDisabledOnFailure=false` ;
`failureReason/failurePhase/cleanupFailureReason=null`. Console revenue au shell.

**Seul propriétaire créé et actif, rôle unique administrator ; provisioning clos.**
Login/session/révocation et refus de la session révoquée réellement validés par le
module M1 exact sur RTDB partagée. Aucun compte/praticien/support/grant supplémentaire,
aucun accès conversation. Ne plus relancer le provisioning ; aucune demande
propriétaire/password restante. App `f20d84f` toujours live, aucun test HTTP/UI M1.
Capture expurgée privée Work, aucun secret/email recopié. Historique préparation,
préflight et deux échecs conservé ; aucune réexécution Cloud.

Capture IAM propriétaire : panneau Modifier l'accès du projet attendu pour le
principal runtime connu, un rôle visible « Administrateur Firebase Real… »,
description « Accès complet en lecture/écriture aux ressources de Firebase Realtime
Database ». Aucune condition attachée visible, seulement Ajouter une condition IAM ;
pas d'autre rôle visible. Correspondance `roles/firebasedatabase.admin` étayée par
description officielle ; héritage/bindings fournis Google non exhaustifs. Aucun IAM
modifié ni capture publiée.

**Seul blocage : IAM.** Action humaine minimale dans console opérateur accessible :
créer/reprendre rôle custom projet avec seulement `firebasedatabase.instances.get`
et `firebasedatabase.instances.update`, remplacer la seule attribution Admin RTDB
confirmée, préserver toute autre attribution. Aucun nouveau projet/base ; couplage
règles/activation de update conservé. Work vérifiera ensuite delete non accordé et
SDK lecture/écriture sur sonde dédiée réversible beta/main ; preuves encore attendues,
aucun contrôle exécuté pour cette consignation.

Publication documentaire seulement : rapport/checkpoint/manifest et PR27 draft,
sans changement helper/script/application, nouveau test, fusion, déploiement ou M2.
Vérification limitée au diff documentaire et à l'état Git ; aucune demande utilisateur.

## Checkpoint de clôture M0/M1 — preuves Work du 5 octobre 2026

Utilisateur : rôle GA `projects/facilitat-io/roles/facilitatRuntimeRtdb` créé et
enregistré, permissions **exactement** instances.get/update, remplacement de
roles/firebasedatabase.admin sur le principal runtime connu ; capture policy updated.
Work : testIamPermissions frais avec credentials runtime beta **et** main,
contexte projet/principal/URL exact, HTTP200 chacun, get/update=true,
delete/create/list=false, projects.setIamPolicy=false. **IAM clos, droit de
suppression d'instance effectivement absent** ; réserve update règles/enable-disable
conservée, héritage/bindings fournis Google non exhaustifs, partage inchangé accepté.

Sonde téléchargée épinglée df4bc47, SHA256
`325aa65ad926c81056f3908a0ecd92b58037bb24e92208d3f309dbb35b8e1fc4` :
trois marqueurs, beta initial puis beta/main après ajout local de lecture préalable.
Tous ont `context/created/read/update/cleanup=true`, **removed=false/ok=false**.
La modification locale n'a pas résolu ce résultat, cause non prouvée. Complément
borné pour chacun : schéma exact version1/probeId/step1/trois clés, remove puis
lecture absence ; markerExact=true/removed=true. **Trois marqueurs nettoyés**,
[IDs et détail](M0-M1-closure-plan.md#preuves-finales-work--iam-réduit-et-sondes-nettoyées).
Lecture/écriture/update/transaction SDK et suppression complémentaire validées ;
aucun PASS rétrospectif de la sonde initiale, limitation non bloquante après nettoyage.

**M0/M1 clos — prêt pour protocole pré-FF et livraison vers main.** Aucun blocage
opérationnel restant, owner clos administrator seul ; ne pas reprovisionner.
Services et branches beta/main f20d84f, protections HTTP M1 non déployées,
aucun test HTTP/UI M1 ou annonce de bêta ouverte. Pré-FF/livraison après bilan,
non exécutés ici. PR27 draft base beta ; aucune fusion/deploy/M2, nouvelle mission,
modification helper/script/code ou relance des tests acquis 3db45bb.
Publication rapport/checkpoint/manifest/closure-plan seulement, captures expurgées
privées Work, aucun secret/email personnel recopié.
