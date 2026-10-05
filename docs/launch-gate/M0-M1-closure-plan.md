# Clôture opérationnelle ciblée M0/M1 — 5 octobre 2026

Inspection depuis `b78acf8cc6ee20ecedceb682a0c399c6a3bac02d`, checkout propre.
Code live `f20d84f1962c552eaebb095d7a9e5ddb63719be7` ; code M1 validé
`3db45bb8827ed14b9cd9399b61de8b8da8213dc1`, inchangé. Instructions AGENTS/WORKFLOW
relues. Aucun boot, test global acquis, accès fournisseur, provisioning ou
déploiement exécuté par Cloud. Les helpers ci-dessous sont opérateurs temporaires,
sans modification applicative. PR27 draft ; aucune fusion beta/main, M2 exclu.

## Usages Firebase réellement présents dans les deux sources

Le serveur utilise seulement **AdminSDK Realtime Database**, avec
`credential.cert(serviceAccount)` et URL explicite (`server.js:60`). Aucun appel
Firebase Authentication, Firestore, Storage, Messaging, Remote Config, App Check,
API de gestion d'instances/projets, IAM policy ou clés. `lib/config.js` donne
priorité au credential PATH, sinon JSON ; même fichier dans les deux versions.
`lib/password-reset.js` reçoit `usersRef` et fait lecture/transactions RTDB :
reset des credentials applicatifs, sans Firebase Authentication.

| Chemins / consommateur | Opérations RTDB constatées | Évolution M1 |
| --- | --- | --- |
| `users` | lookup email, lecture identité/version/préférences/usage/mémoire, set/update/transactions, remove sur routes historiques reset/close | Gardes d'autorité ; cycle lifecycle inchangé, aucun M2 exécuté |
| `conversations`, `messages` | once, queries userId/conversationId, push/set/update/transactions, suppressions de données sur routes historiques | Autorité parent/enfants, imports/branches/public et refus des objets ambigus ; pas de lecture privée par les helpers |
| `branches`, `branchSeeds` | queries/lecture, push/set/update/remove | Associations acteur/source/seed/destination bornées |
| `userLabels`, `accountArchives`, `accountResetAudits` | lecture, set/push/update/remove de nœuds | Historique conservé ; pas de reset/purge opérateur |
| `adminSettings/mailsEnabled` | once + listener `on(value)` au boot ; update par API administrateur | Même besoin de données ; aucun boot de collecte |
| `privateConversationMemory` | lecture/set dans le code live | Retiré de M1 ; ancien nœud non purgé |
| `professionalIdentities`, `professionalSessions`, `professionalAccessJournal` | Nouveau M1 : query/lecture identité, set session, update révocation, push journal | Aucune gestion Firebase Auth ; contenu absent des helpers |
| `practitionerAssignments`, `contentGrants` | Nouveau M1 : lectures/query ; transactions grant utilisateur | Aucune affectation/grant créé par ce plan |
| `scripts/reset-app-data.js` | Live : remove des nœuds de données et fichiers locaux ; **pas de suppression d'instance** | Simulation pure et verrou total, jamais lancé ici |
| `scripts/ensure-rtdb-index.js` | Live : getRules/setRules via `.settings/rules.json` | Verrou avant SDK ; hors runtime serveur, ne pas déverrouiller |

`once`, queries et listeners demandent lecture ; set/push/update/remove et
transactions demandent écriture (transactions aussi lecture). Une suppression
de **nœud de données** n'est pas `instances.delete`. L'AdminSDK installé utilise
l'URL fournie (`firebase-admin/lib/database/database.js:122`) sans découverte/listing
d'instance. Ses scopes OAuth généraux ne prouvent pas l'usage de tous les services.
La clé locale sert à obtenir un token OAuth ; aucun besoin de signBlob,
serviceAccountTokenCreator, lecture de policy ou gestion de clés dans ces sources.
L'inspection ne qualifie pas d'autres consommateurs externes du principal partagé.

## IAM : minimum documenté et réduction à préparer

Correction officielle transmise par Work :
[Firebase permissions, Realtime Database](https://firebase.google.com/docs/projects/iam/permissions)
documente **`firebasedatabase.instances.get`** pour métadonnées **et données**,
**`firebasedatabase.instances.update`** pour lecture/écriture des données **et règles,
enable/disable**. Les noms `firebasedatabase.data.get/update` retournés par les
sondes précédentes restent une observation conservée, **pas une base documentée
pour un custom rôle ni une garantie AdminSDK**. Les tests SDK ci-dessous sont
nécessaires après réduction.

Préparer sur le **projet/principal existants** une définition custom comprenant
`instances.get` et `instances.update`, réutiliser un rôle custom existant adapté
s'il est trouvé. Aucune création/modification de rôle ici. N'ajouter list ou
métadonnées de projet que si un autre consommateur réellement identifié l'exige :
aucun appel correspondant dans le runtime inspecté à URL explicite. Exclure
create/delete et toutes les permissions de gestion supplémentaires du catalogue
réel (disable/reenable/undelete si disponibles). **Limite résiduelle : `update`
couple les données aux règles/activation de l'instance ; l'exclusion de permissions
supplémentaires ne supprime pas ce couplage.** Ne pas annoncer une isolation par
chemin ou l'impossibilité de désactiver une instance avec ce rôle.

[Catalogue officiel RTDB](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasedatabase)
: plusieurs rôles contiennent delete ; aucun rôle attribué n'est déduit du nom
AdminSDK. Firebase UI ne montre pas ces bindings. UI IAM/Cloud Shell indisponibles ;
principal runtime sans getIamPolicy/setIamPolicy : blocage concret conservé.

Observation utilisateur ultérieure : capture du projet attendu et du seul principal
attendu, libellé tronqué **« Administrateur Firebase Realtime… »**, case des rôles
fournis Google non cochée. Correspondance attendue `roles/firebasedatabase.admin`,
à qualifier par documentation/UI et export avant tout retrait. Ce libellé ne
prouve ni l'identifiant exact ni l'exhaustivité des bindings, conditions ou droits
hérités. GCP reste inaccessible à Work ; aucun IAM modifié, aucune capture publiée.
Le plan custom `instances.get/update` ci-dessus reste inchangé.

Commandes **lecture seule** depuis un opérateur déjà habilité, gcloud déjà
authentifié ; le credential runtime ne peut pas faire cette inspection/réduction.
Ne pas extraire un token navigateur ni créer un compte/droit pour la contourner.
Le fichier policy complet reste privé, avec etag/conditions ; jamais dans le rapport.

```sh
umask 077
M0M1_IAM_DIR=$(mktemp -d /tmp/m0m1-iam.XXXXXX)
gcloud projects describe facilitat-io --format='value(projectNumber)'
gcloud projects get-iam-policy facilitat-io --format=json > "$M0M1_IAM_DIR/project-policy.json"
python3 - "$M0M1_IAM_DIR/project-policy.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))
member='serviceAccount:firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com'
rows=[{'role':b['role'],'conditional':bool(b.get('condition')),
       'otherMembers':len([m for m in b.get('members',[]) if m != member])}
      for b in p.get('bindings',[]) if member in b.get('members',[])]
print(json.dumps({'directBindings':rows,'policyVersion':p.get('version',1)}))
PY
gcloud projects get-ancestors facilitat-io --format='table(type,id)'
M0M1_PROJECT_NUMBER=$(gcloud projects describe facilitat-io --format='value(projectNumber)')
gcloud iam list-testable-permissions "//cloudresourcemanager.googleapis.com/projects/$M0M1_PROJECT_NUMBER" \
  --filter='name:firebasedatabase.' --format='table(name,customRolesSupportLevel,stage)'
```

Puis décrire **les seuls rôles réellement retournés** :
`gcloud iam roles describe roles/<nom_observé> --format=json`, ou
`gcloud iam roles describe <id_observé> --project=facilitat-io --format=json` pour
un rôle custom du projet ; rôle d'organisation avec `--organization=<id_observé>`.
Inspecter aussi l'héritage depuis les parents retournés, conditions/deny et autres
consommateurs. Un retrait local ne supprime pas un octroi hérité. Aucun
set-iam-policy/remove-iam-policy-binding préparé contre un rôle présumé ; la policy
à modifier ne sera définie qu'après ces observations, en préservant etag/conditions.
403/SERVICE_DISABLED ou accès gcloud absent = limite factuelle, pas nouveau GO général.
Pas d'activation API automatique ni nouvelle base/projet.

Après réduction : nouvelle sonde `testIamPermissions` du credential des deux
services, pour get/update/delete/create/list et setIamPolicy ; vérifier get/update
accordés, delete/create et élargissements supprimés selon catalogue/bindings.
Réutiliser la commande OAuth du [collecteur](M0-M1-render-readonly.md), en remplaçant
uniquement sa liste `projectPermissions` par ces noms **documentés**. Aucun appel
de suppression/gestion d'instance pour tester un refus.

## Une seule identité nécessaire pour ce lancement

Propriétaire historique déjà nommé et autorisé par l'utilisateur ; aucun nominatif
manquant. **Rôle unique `administrator`** : `lib/professional-access.js:134-136`
ouvre admin et support-cases, `server.js:1805-1930` impose ce rôle et un motif aux
API, `server.js:2995` protège le réglage mails. `practitioner` ouvre un autre
parcours (`server.js:6533`) sous affectation/grant ; inutile pour l'exploitation
initiale, donc absent. Les deux rôles support n'ajoutent aucun accès d'exploitation
nécessaire. Aucun autre acteur, compte de recette, affectation ou grant à créer.
La restriction AGENTS sur les smoke tests HTTP sous identité personnelle reste
respectée : aucune session navigateur/cookie ni lecture métier par Work. La
validation directe du module ci-dessous est explicitement demandée par l'utilisateur.

Schéma exact, mapping résolu uniquement en mémoire depuis la source live épinglée :

```text
professionalIdentities/launch-owner
  email: mapping propriétaire autorisé, trim/lowercase
  displayName: propriétaire historique
  passwordHash: scrypt:<sel hex 16 octets>:<hash hex 64 octets>
  active: true
  roles: [administrator]
  authorizationVersion: 0
```

`active:true` permet la validation du vrai module isolé ; le code live f20 ne
consomme pas ce nœud. Cela ne déploie ni n'active le code M1. Nouveau password
établi/conservé par le propriétaire dans son canal privé ; pas de génération Cloud,
SMTP, hash/password/token imprimé ou sauvegardé par le helper. Ni args/env/history
ni chat/GitHub/checkpoint. Le canal concret proposé est **saisie directe par le propriétaire
dans sa session Render Web Shell**, avec conservation privée dans son gestionnaire
habituel. Work démarre le helper et passe la main ; seul l'utilisateur saisit/confirme
et soumet le nouveau credential, conformément à la passation navigateur demandée.

## Commande prête — provisioning et validation du module exact

Depuis le répertoire applicatif de **beta Web Shell**, aucune variable/secrète
à ajouter. Télécharger seulement dans un répertoire opérateur privé temporaire,
sans checkout ni remplacement dans l'app. Sources auth/professionnel **embarquées dans ce seul helper** au
SHA déjà testé `3db45bb` ; octets restaurés uniquement sous `/tmp`, empreintes
contrôlées avant chargement natif. Aucun téléchargement séparé de module.
Le helper refuse toute différence, mauvais service/SHA/contexte ou absence de TTY.

```sh
umask 077 && M0M1_OWNER_FILE=$(mktemp /tmp/m0m1-owner.XXXXXX.cjs) && curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 60 https://raw.githubusercontent.com/arnaudconnan-svg/acp-chat/work/m0-m1-launch-gate/docs/launch-gate/operators/owner-provision.cjs -o "$M0M1_OWNER_FILE" && node -e 'const fs=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")!=="999309f751a68121cc36ffee5a7e45ab70b5bc624089b6a936c4bb8c07bb674d")process.exit(1)' "$M0M1_OWNER_FILE" && node "$M0M1_OWNER_FILE"
```

Commande volontairement **mono-ligne**, sans heredoc ni collage de source multiligne.
Si dépôt privé, récupérer ce seul helper par l'accès GitHub existant puis vérifier
la même empreinte ; aucun token dans la commande. Le module peut
manquer dans f20 : **ce seul helper temporaire suffit**, sans npm install, boot,
timer applicatif ou déploiement. Il charge AdminSDK déjà installé et config locale
identique entre live/M1 ; aucun server/logger/provider.

Avant toute saisie : contexte exact projet/base/principal, service beta et SHA
f20, empreinte exacte de server.js live puis extraction de sa seule liste propriétaire
et vérification SHA256 de l’email normalisé attendu, sans eval/require du serveur
ni extraction/copie des passwords legacy. Aucune constante email en clair dans
le helper. Modules/schéma, absence de fiche/email **et namespace professionnel vide**.
Inventaire Work précédent total0. Création atomique par transaction sur
`professionalIdentities` **uniquement si encore null** : une seule fiche, aucune
réécriture d'une fiche ni de la racine RTDB ; un ajout concurrent fait refuser la
transaction. Cette condition stricte empêche aussi un doublon concurrent lors de
ce premier provisioning. Aucune saisie si ces préconditions échouent.

Après confirmation masquée : scrypt existant, création, unicité vérifiée ; vrai
module M1 `login` → `session` avec **rôle unique administrator**, aucun bypass TWA
ni facilitation ; `revoke` → session refusée. Une session de sonde révoquée reste
durable (aucune purge) ; token en mémoire seulement, aucun cookie. Sortie : ID
technique, booléens et codes d'échec fixes décrits ci-dessous. En échec après création, révocation tentée et désactivation
bornée de **sa seule fiche nouvelle** si hash/identité/rôle/version correspondent.
Network/SIGKILL peuvent empêcher cette fermeture : tout booléen de révocation ou
désactivation non confirmé impose réconciliation sur ce seul ID, sans reset.
Le helper supprime l'écho TTY ; les valeurs restent brièvement en mémoire, sans
promesse d'effacement physique de la RAM. Aucune lecture conversations/mémoire privée.
IAM peut rester bloqué : cette préparation/provisioning borné autorisé ne clôt pas
le gate IAM et ne permet aucune fusion. Pas de provisioning exécuté par Cloud.

### Correction ciblée de saisie et diagnostics — revue Work avant exécution

Version corrigée SHA256
`999309f751a68121cc36ffee5a7e45ab70b5bc624089b6a936c4bb8c07bb674d`,
transfert mono-ligne épinglé par cette empreinte : toute différence est refusée.
Les deux tentatives Work de la version `c661db9f…` se sont terminées avant création,
la seconde au prompt Confirmation ; aucun compte/session créé. Le catch ancien
ne permet pas de connaître leur cause. Ne pas attribuer cet échec à une saisie
particulière ni au défaut reproduit sans nouvelle preuve.

Défauts démontrés sur l'ancien lecteur archivé : CR puis LF dans deux événements
termine la confirmation vide ; un collage contenant deux lignes dans un événement
perd sa seconde ligne ; EOF du flux laisse la promesse en attente. Le lecteur
unique corrigé garde la TTY masquée entre les deux prompts, normalise CR/LF/CRLF
même entre événements et conserve le reste du collage pour la confirmation.
Backspace/DEL retirent un caractère entier, UTF-8 découpé est décodé ; aucune saisie
ni longueur effective n'est affichée. Les contrôles ESC/tabulation/autres C0 sont
refusés, y compris les séquences de collage encadré. Ctrl-C annule, Ctrl-D/fin du
flux refuse. Limite initiale inchangée de 1024 octets par ligne, tampon en attente
borné à 4096 octets. Politique `isStrongPassword` existante inchangée, pas de trim.

`failureReason`, `failurePhase` et éventuellement `cleanupFailureReason` sont des
codes à liste blanche ; aucune propriété d'erreur SDK/TTY n'est lue ou imprimée.
`entries_differ` = confirmation différente ; `password_policy` = politique existante
non satisfaite ; `input_cancelled`/`input_eof` = annulation/fin ;
`input_control_not_allowed` = contrôle refusé ; `input_too_long` = limite dépassée,
sans taille effective ; `tty_unavailable`/`tty_io_failed` = entrée indisponible.
Les autres refus restent bornés aux gardes modules/propriétaire/contexte, préflight,
identité préexistante, transaction ou phase hash/unicité/login/session/révocation/
nettoyage. Une erreur externe inconnue ne produit que le code fixe de sa phase.
`inputCleanupOk` indique la restauration TTY ; tous les autres gardes, modules
embarqués exacts, rôles, scrypt et atomicité restent inchangés.

Contrôle ciblé réellement exécuté, **32 cas PASS, code0**, entrées exclusivement
synthétiques, sous garde hermétique, sans SDK ni réseau :

```sh
node --require ./scripts/synthetic/guard.cjs docs/launch-gate/operators/owner-provision-input-test.cjs
```

[Preuve ciblée](evidence/owner-tty-targeted.json). Aucune suite acquise relancée,
aucune exécution de cette nouvelle version Render par Cloud. Work revoit la version
publiée avant démarrage et conserve la passation personnelle obligatoire.
Revue Work reçue : diff de saisie et sortie réelle des 32 cas PASS relus,
gardes et modules M1 conservés ; aucun contrôle supplémentaire demandé.

## Vérification SDK après réduction — seule sonde réversible dédiée

Depuis chacun des deux shells, nouveau processus/OAuth avec credential réellement
local ; pas de réutilisation du cache du serveur. Télécharger et vérifier :

```sh
umask 077 && M0M1_SDK_FILE=$(mktemp /tmp/m0m1-sdk.XXXXXX.cjs) && curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 60 https://raw.githubusercontent.com/arnaudconnan-svg/acp-chat/work/m0-m1-launch-gate/docs/launch-gate/operators/sdk-probe.cjs -o "$M0M1_SDK_FILE" && node -e 'const fs=require("node:fs"),c=require("node:crypto");if(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")!=="325aa65ad926c81056f3908a0ecd92b58037bb24e92208d3f309dbb35b8e1fc4")process.exit(1)' "$M0M1_SDK_FILE" && node "$M0M1_SDK_FILE"
```

Seul chemin `_launchGateSdkProbe/probe_<nonce>` : transaction création si absent,
lecture, update du compteur factice, relecture, transaction null **uniquement si
notre marqueur exact**, absence vérifiée. Aucune lecture/écriture métier ni règle,
aucun test destructif d'instance. `app.delete()` ferme l'app SDK locale, jamais
l'instance RTDB. Résultat attendu : tous booléens de succès vrais, ID technique,
code0. Si nettoyage non confirmé, conserver ID/résultat et réconcilier seulement
la sonde dédiée ; ne pas déclarer réversibilité accomplie. La preuve vaut cet accès
SDK sur cette sonde et la nouvelle policy, pas tous les chemins/transactions en
concurrence ni suppression garantie par IAM seul. Aucun de ces appels exécuté ici.

## Preuves locales de préparation

Sources inspectées intégralement pour les imports/accès Firebase, modules et
gardes cités. SHA256 `server.js` live :
`e53e8469a084896b1ad58b19413c12dfa659a9f67db623f90df748168ba7d555`, concordant Work ;
candidat M1 : `eca5fb9148a737a5e549993ec244ccd5680e09007a4660b31d82882be357dc85`.
`lib/config`, `auth-password`, `password-reset` identiques entre les sources.
Modules auth/professionnel identiques au SHA testé. Nouveaux helpers :
`node --check` réussi, commandes mono-ligne `bash -n` réussies ; sources embarquées
comparées octet pour octet au SHA testé, empreintes de notice concordantes.
Résolveur propriétaire vérifié sans SDK : source live acceptée, source altérée et
empreinte email différente refusées ; server.js jamais évalué.
**Aucune exécution réelle**, aucune répétition de harness.
`git diff --check` et absence de modification applicative contrôlés à publication.
Restent les observations bindings/réduction IAM, puis la saisie/remise privée du
nouveau credential et les booléens réels du helper/SDK, dans les autorisations
M0/M1 déjà accordées. Aucun nominatif/rôle manquant, aucun nouveau GO général.
