# Launch Gate M0 + M1 — rapport final de validation synthétique

5 octobre 2026. Les correctifs G02/G03 et le consentement publiés ont été acceptés
par Work. La vérification globale dans le clone indépendant est verte. La
livraison est proposée à la revue vers **beta**, sans fusion ni activation réelle.

## Références et état Git

- Base initiale et distante : `beta`,
  `f20d84f1962c552eaebb095d7a9e5ddb63719be7` ; inchangée au contrôle final.
- Branche distante existante : `work/m0-m1-launch-gate`, publications sans force.
- Dernier SHA de code/tests vérifié :
  `3db45bb8827ed14b9cd9399b61de8b8da8213dc1`.
- Arbre de ce SHA : `898ad8b3888ba38776ba333ef5f274bf20e1111b`.
- Clone indépendant : `/workspace/work/acp-clean-m0m1-031c063`, avancé uniquement
  par fast-forward au SHA ci-dessus. `git status --porcelain` vide avant et après
  les tests ; `git diff --check` code 0. Checkout de mission également propre
  avant l'ajout de ces preuves.
- Le commit de publication de ce rapport ajoute seulement des documents/preuves.
  Il ne modifie pas le code ni les tests du SHA vérifié. Les checkpoints « M1 en
  cours » restent des archives datées ; les validations restantes qu'ils
  annonçaient sont soldées par ce rapport.
- Mise à jour documentaire après lecture Render Work : aucun code/test modifié
  depuis `3db45bb` ; `git diff --check` et comparaison des fichiers exécutables
  contrôlés avant publication. Aucun nouveau test global pour cette mise à jour.

## Commandes et résultats

Node `v24.19.0`, npm `11.9.0`. Depuis le clone indépendant :

```sh
npm ci --ignore-scripts --no-audit --no-fund
bash scripts/synthetic/verify.sh
git status --porcelain
git diff --check
```

Installation : **code 0**, 369 paquets. Elle précède le dernier fast-forward ;
`package.json` et `package-lock.json` sont identiques entre `031c063` et le SHA
vérifié. Vérification : **code 0**, huit harnesses M0/M1 puis tout `npm run verify`,
dont `node --check server.js`, cohérence des prompts et témoins de crise.
Aucun échec masqué. Les avertissements de dépréciation npm et de Promises
inter-realm du routeur Express dans la VM sont conservés dans les logs.

Le runner versionné assainit l'environnement, précharge le garde, refuse réseau
fournisseur/SDK réels et neutralise boot/listeners/intervalles avant chargement.
Le véritable pipeline Express utilise des flux mémoire ; RTDB, LLM et mail sont
simulés. Aucun secret ni `/workspace/acp-validation` n'est requis pour reproduire
les commandes. L'installation demande seulement le registre de dépendances.
L'exécution Cloud a levé la restriction de capture stdout des sous-processus Git
des tests historiques ; le garde hermétique versionné reste actif.

Preuves publiées : [installation](evidence/m1-clean-install.log),
[vérification du clone indépendant](evidence/m1-clean-verify.log),
[manifeste et SHA256](evidence/m1-final-manifest.json).
La preuve globale du checkout de mission [antérieur](evidence/m1-final-verify.log)
et les [preuves initiales](evidence/initial) sont conservées.

## Bilan par gate

Toutes les lignes « PASS » ci-dessous désignent des tests synthétiques au SHA
vérifié. Elles ne constituent pas une attestation des services déployés.

| Gate | Fichiers / commits principaux | Preuve exécutée et résultat | Limite et opération restante |
| --- | --- | --- | --- |
| M0 — isolation et opérateurs | `scripts/synthetic/{guard,runtime,verify}`, `lib/operator-target.js`, scripts reset/index ; `7c5263d`, `afe991f`, `f43b9b5` | `operator:harness`, `isolation:harness` **PASS** : cible/principal/périmètre obligatoires, simulation bornée, refus ; Express réel avec montages/ordre/erreurs, boot/timers/fournisseurs refusés avant chargement | Verrou total `--apply` **conservatoire** ; aucune opération réelle testée. Attestation service/base/principal/IAM par Work ; opérations beta dans les autorisations M0/M1 déjà accordées, après satisfaction des prérequis vérifiables. Firebase partagé intentionnel, non bloquant par principe ; pas de nouvelle base. Carte [M0](M0.md). |
| G01 — secrets et sessions | `server.js`, `lib/professional-access.js` ; `91d6e4e`, `3cb24ac` | `professional:harness` **PASS** : aucun repli full/TWA large actif, sessions individuelles opaques, schéma strict, expiration absente/NaN/infinie refusée chaud/froid, redémarrage et révocation | Quatre secrets dédiés distincts de 512 bits configurés et consommés sur les deux services selon Work. M1 non déployé : anciennes capacités codées en dur à abandonner ; provisioning individuel/remise non exécutés. |
| G19 / CJ4 — rôles, grants et audit | Module professionnel, routes et `public/js/{content-grants,professional-review}.js`, UI praticien ; `91d6e4e`, `3cb24ac`, `3c434b2`, `3db45bb` | `professional:harness`, `consent-ui:harness` **PASS** : affectation + grant, scope spécifique/période, synthèse explicite positive/refusée, révocation, cumul admin+praticien en rôle praticien, supports sans contenu ; journal admin à motif et unmask distinct. UI par titres/dates, portée/synthèse/échéance restaurées, instant persisté égal à l'affichage | Identités/affectations réelles à provisionner dans les autorisations M0/M1 déjà accordées, après satisfaction des prérequis vérifiables ; politique audit à attester. Lecture praticien minimale ; gardes copie/sélection/impression proportionnés, sans garantie contre toute capture. Aucun vrai grant modifié. |
| G02 — autorité objet et associations | `server.js`, module professionnel ; `3cb24ac`, `3c434b2` | `professional:harness`, `object-private:harness`, `associations:harness` **PASS** : témoins autorisés et refus avant effets, clé canonique, objets absents/étrangers/retirés ; requestId scoped, owner-cancel/progress, finalisation inverse ; branches/source/seed/destination contradictoires sans effet B, enfants étrangers/privés/non fiables exclus ; import nouveau explicite, collisions/orphelins/path/mixed batch refusés, overwrite légitime borné | Persistance en mémoire : aucune preuve d'IAM ou concurrence distribuée RTDB. Objets hérités ambigus conservés et refusés ; aucune réattribution. Cycle delete/reset/closure et refonte replay M2 non engagés. |
| G03 — séparation navigateur | `public/js/identity-storage.js`, `public/index.html`, autres pages et SW ; `91d6e4e`, `3cb24ac`, `3c434b2`, `3db45bb` | `browser-identity:harness`, `object-private:harness` **PASS** : namespaces A/B, logout, onglets, offline et héritage quarantiné ; sondes session retenues avant logout/login B, acteur initial inconnu ou A connu ; fetch résolu puis JSON/chunk tardif refusé ; stockage et retours applicatifs clôturés par génération | DOM/stockage/fetch simulés, pas de recette sur appareil réel. Données légitimes conservées, héritage inconnu non réattribué. Aucun cycle serveur M2 changé. |
| G04 / CJ2 — privé local et continuité | `server.js`, `public/index.html`, `public/js/conversation-data.js` ; `91d6e4e`, `3cb24ac`, `3c434b2` | `object-private:harness`, `associations:harness` **PASS** : privé multi-tour/rechargement/redémarrage avec memoryState complet IDs/dates, debug N-1, identifiant réutilisé par B isolé, aucun effet durable/cache privé serveur ; réponse normale et crise, tokens avant consolidation finale ; feedback volontaire borné et import privé→public explicite conservés | Transit fournisseur autorisé mais simulé. Consolidation privée attendue pour la réponse finale. Ancien nœud privé et sauvegardes non purgés ; inventaire après bascule dans les autorisations M0/M1 déjà accordées, après satisfaction des prérequis vérifiables ; purge irréversible soumise à ses limites et contrôles propres. |
| G06 — minimisation des traces | `lib/{log-projection,logger}.js`, `server.js` ; `3cb24ac`, `031c063` | `log-projection:harness`, `object-private:harness`, `professional:harness` **PASS** : sorties du vrai mécanisme de projection avant pino/console/child bindings et serveur privé sans marqueurs factices de secret/transcript/mémoire/debug ; identifiant adversarial absent du journal admin ; diagnostic client sensible désactivé | Aucun dump de logs réels. Work atteste runtime live `LOG_PERSIST=true`, rétention14, exploitation normale conservée ; historique/destinations et contenu non inspectés. Aucun blocage ni changement `LOG_PERSIST=false`. |
| G12 — destinations locales | `public/js/local-destination.js`, auth/pro/TWA, routes serveur ; `91d6e4e`, `3cb24ac`, `3c434b2` | `browser-identity:harness` et témoins auth historiques **PASS** : parcours locaux autorisés ; URLs externes, //, backslashes, encodages, fragments et traversées normalisées refusés, repli local sûr | Validation déterministe client/serveur, aucun parcours authentifié réel utilisé. |

## Statut opérationnel et suite Work

**Implémenté et testé synthétiquement : M0 puis M1. Déployé : non. Purgé : non.**
La PR cible beta pour revue et ne doit pas être fusionnée automatiquement.
Pendant la validation Cloud, aucun service réel, compte, rôle/grant, configuration,
déploiement ou donnée réelle n'a été modifié ; aucun appel réel Firebase/Mistral/SMTP
ni listener applicatif. Les opérations Work ultérieures sont attestées ci-dessous.
Aucun M2 ni promotion main/production.

**Connexion Render débloquée — faits transmis par Work le 05/10/2026.** Les pages
Environment de `srv-d6lh0094tr6s73b71kug` (beta) et
`srv-d6kuf4ftskes73d0k15g` (main) déclarent toutes deux
`FIREBASE_DATABASE_URL=https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/`,
projet `facilitat-io`, principal
`firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com`.
Les deux services live restent `f20d84f` : M0/M1 ne sont pas déployés.
Même cible/principal déclarés, **aucune isolation beta/main démontrée** ; partage
intentionnel. Métadonnées runtime et règles live confirmées par Work ; droits de
données prouvés, `instances.delete=true` excessif pour M1 sur beta **et main**.
`setIamPolicy=false`, `firebaseauth.users.delete=false`. Bindings HTTP403
`PERMISSION_DENIED` sans reason, endpoints permissions du compte/clés HTTP403
`PERMISSION_DENIED` reason `SERVICE_DISABLED` ; UI IAM et Cloud Shell indisponibles.
Policies/clés et tous les autres privilèges ne sont pas entièrement qualifiés.
Ces faits viennent des contrôles bornés Work, sans contenu utilisateur, clé/token
consigné ou mutation IAM/RTDB. Le [checkpoint](M0-M1-operational-checkpoint.md)
conserve les permissions accordées/refus exacts et la correction IAM minimale.

Le constat Environment beta initial, avant configuration Work, montrait `USER_SESSION_SECRET` et
`ADMIN_SESSION_SECRET` **absents**, `ADMIN_PASSWORD` et `SESSION_SECRET`
**présents**, aucun groupe d'environnement lié ni secret file visible.
Ce prérequis est désormais satisfait selon Work : quatre secrets de 512 bits
installés, quatre valeurs distinctes, consommation runtime confirmée des deux
services. Redéploiements automatiques `f20d84f` live, sans fusion ; contrôles santé
et session explicitement sans cookie acquis : retour avant toute actualisation
d'usage. Processus beta PID85/main PID84 : credential JSON, schéma attendu,
`dotenvPresent=false`, `LOG_PERSIST=true`, rétention14, refreshfalse, production,
port10000. SHA256 `server.js` runtime
`e53e8469a084896b1ad58b19413c12dfa659a9f67db623f90df748168ba7d555`
identique à la source Git `f20d84f`, vérifié par Cloud. M1 non déployé.

Inventaire `professionalIdentities` Work HTTP succès : total0, complete=true,
active/inactive0, chaque rôle0, readFailures0. Aucun compte durable à migrer ni
écriture. Les **deux blocages précis** : réduction des permissions de gestion
inutiles, notamment suppression d'instance, impossible avec les accès disponibles ;
provisioning/remise privée du nouveau credential du seul propriétaire connu à
exécuter via le [helper préparé](M0-M1-closure-plan.md), rôle unique administrator,
sans acteur/rôle inventé ni réutilisation du password publié. Identité nominative
connue/autorisation explicite, aucun nominatif/rôle manquant. Inspecter bindings et
autres consommateurs depuis un accès opérateur existant avant réduction ; aucune
base/projet nouveau, aucun rôle deviné. Aucun secret fournisseur déclaré compromis
sans preuve, aucune rotation additionnelle automatique. Ces actions relèvent des
autorisations M0/M1 déjà accordées, pas d'un nouveau GO général.

Précision IAM officielle Work : les permissions documentées de données sont
`instances.get/update`, avec couplage résiduel règles/enable/disable pour update.
`data.get/update` renvoyés restent des observations, pas une définition custom
supportée ou une garantie AdminSDK. Le [plan ciblé](M0-M1-closure-plan.md) prépare
inspection gcloud et sonde SDK réversible après réduction, sans retrait présumé.
Préparation locale des helpers : syntaxe vérifiée, aucune exécution réelle,
application/tests validés inchangés ; module professionnel exact au SHA testé.

Le [plan de bascule sûre](M1-runbook.md#plan-de-bascule-sûre-sur-la-cible-partagée)
séquence attestation runtime/IAM, dépendances de la cible commune, préparation des
secrets avant fusion, rotation coordonnée, provisioning/grants puis recette beta
restreinte dans les autorisations M0/M1 déjà accordées, après satisfaction des
prérequis vérifiables. Pas de production publique distincte : beta validation,
main future bêta ouverte après pré-FF, Firebase partagé intentionnel et non
bloquant par principe ; aucune base/projet à créer. Configuration/rotations des
deux services autorisées. Fusions bloquées avant clôture des prérequis, main avant
bilan final ; purge irréversible et droits/ressources non définis gardent leurs
contrôles propres.
Il ne garantit pas les protections M1 aux
parcours main restés hérités. PR27 reste draft ; cette publication Cloud ne modifie
aucun service, secret ni compte réel. Les opérations de configuration/redéploiement
Work sont attestées ci-dessus. Les résidus privés et logs restent non purgés.


Le [checkpoint opérationnel](M0-M1-operational-checkpoint.md) distingue les preuves
Work reçues des actions restantes. [Commande IAM/inventaire standalone prête](M0-M1-render-readonly.md),
non exécutée par Cloud. Aucune modification de code/test ni revalidation globale.

Précision du helper préparé : email propriétaire dérivé seulement en mémoire de
la source live f20 épinglée et contrôlé par empreinte normalisée ; aucune constante
email en clair dans le helper courant, aucun eval du serveur/password legacy copié.
Résolveur ciblé validé (source exacte acceptée, source/empreinte altérées refusées),
aucune exécution Render à ce checkpoint de préparation Cloud. Preuves publiques :
launch-owner + administrator uniquement.

## Preuve Work historique — préflight Render seulement

Work atteste le téléchargement, contrôle SHA256
`c661db9f2d65efae8f82714ca4c5161dd7d294812a3b5b18134bddf0a26bcb3e`
et démarrage du helper dans beta Web Shell, instance `c44mq`. L'UI affiche exactement :

> Prêt. Passation à l’utilisateur : saisir et confirmer lui-même le nouveau credential.
>
> Nouveau mot de passe (entrée masquée) :

Ce prompt du helper épinglé prouve le passage des gardes modules exacts,
service/SHA f20, source propriétaire/empreinte, configuration projet/base/principal
et namespace professionnel vide. **À ce checkpoint historique, processus en attente de saisie personnelle :
aucun password saisi/généré, aucune fiche/session écrite, aucun login, contrôle de
session ou révocation exécuté.** Work passe la main après checkpoint durable.
Le statut historique de préparation Cloud reste conservé ; cette nouvelle preuve
Work ne constitue pas un provisioning accompli ni une validation authentifiée.

IAM à ce checkpoint : console indisponible, propriétaire Firebase déjà authentifié,
rôle attribué inconnu. Besoin humain minimal : capture/export des seuls bindings
de ce principal depuis une console opérateur accessible ; aucun retrait à l'aveugle.
PR27 reste draft, sans fusion. Mise à jour docs/evidence uniquement, `diff --check`,
aucun nouveau contrôle ni changement helper/application.

## Reprise ciblée — tentatives Work et correction du helper opérateur

Work rapporte deux tentatives de la version SHA256 `c661db9f…` sur beta `c44mq`,
toutes deux terminées avant création : première avant confirmation, seconde au
prompt Confirmation. Seconde : `moduleExact`, `ownerSourceExact`, `ownerEmailExpected`,
`contextOk`, `preflightOk`, `cleanupOk` vrais ; `confirmed`, `created`, `loginOk`,
`uniqueAdministrator`, `revoked`, `revokedSessionRejected`,
`identityDisabledOnFailure`, `ok` faux. **Aucun compte/session créé ; aucun
login/révocation validé.** Cause inconnue faute de diagnostic dans l'ancien catch ;
aucune saisie personnelle collectée ou consignée.

Seul helper opérateur corrigé : lecteur masqué unique pour les deux lignes,
CR/LF/CRLF et reste de collage conservés, EOF traité. L'ancienne version reproduit
une confirmation vide après CR/LF séparés et une seconde ligne collée perdue.
Ce sont des défauts démontrés, pas une attribution de l'échec Render. Diagnostics
à liste blanche seulement, sans saisie/longueur effective/hash/token/email/erreur
brute. Politique, gardes, transaction et modules M1 exacts inchangés.

Version préparée pour revue Work, SHA256
`999309f751a68121cc36ffee5a7e45ab70b5bc624089b6a936c4bb8c07bb674d`.
[Notice/commande mono-ligne](M0-M1-closure-plan.md),
[preuve ciblée](evidence/owner-tty-targeted.json) : **32 cas synthétiques PASS, code0**,
sous garde hermétique, sans SDK réel. Pas de suite globale acquise relancée ni
d'exécution Render de cette correction ; nouvelle saisie personnelle obligatoire.
Code applicatif et modules embarqués inchangés depuis le SHA testé.

Observation IAM utilisateur : projet/principal attendus, libellé tronqué
« Administrateur Firebase Realtime… », case rôles fournis Google non cochée.
Correspondance attendue `roles/firebasedatabase.admin` à qualifier par doc/UI
avant retrait ; aucune exhaustivité de bindings/conditions/héritage affirmée.
GCP reste inaccessible à Work, aucun IAM modifié et aucune capture publiée.
Restent accès opérateur aux bindings puis réduction custom `instances.get/update`
déjà établie, et saisie personnelle/validation réelle du seul `launch-owner`
`administrator` ; aucun roster ni nouveau GO général. PR27 draft, aucune fusion.

Work confirme avoir relu le diff de saisie et la sortie réelle des 32 cas PASS ;
gardes et modules M1 conservés, aucun contrôle supplémentaire nécessaire. Reste
le démarrage Work de cette version et la saisie personnelle masquée.
