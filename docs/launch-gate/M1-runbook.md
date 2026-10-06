# M1 — prérequis avant activation

Le code et les tests sont synthétiques. La validation Cloud n'a modifié aucun
compte, grant, secret, service ou donnée réel ; la configuration/redéploiement
Render exécutés ensuite par Work sont attestés au checkpoint opérationnel. Ne pas activer ni fusionner automatiquement ce
chantier ; Work doit vérifier les prérequis avant livraison beta.

Architecture actée : pas de production publique distincte actuellement ; beta
validation, main future bêta ouverte après pré-FF. Firebase partagé est intentionnel,
non bloquant par principe ; aucun projet/base à créer. Configuration/rotation des
deux services et préparation des identités prévues sont autorisées M0/M1 ; fusions
beta/main bloquées tant que les prérequis ne sont pas clos, main avant bilan final.

Les [preuves opérationnelles Work et actions restantes](M0-M1-operational-checkpoint.md)
et la [commande standalone IAM/inventaire](M0-M1-render-readonly.md) sont le
checkpoint courant. Aucun compte nominatif/rôle déduit de CJ4/CJ5.

Reprise ciblée séquence20 : propriétaire déjà connu et explicitement autorisé,
**une identité, administrator seul**. Le [plan/helper actuel](M0-M1-closure-plan.md)
remplace l'attente générique de liste nominative : restent saisie/remise privée et
preuves réelles du provisioning. Aucune affectation/grant ni autre acteur.
IAM : minimum documenté instances.get/update, couplage règles/enable/disable
résiduel ; ne pas construire un rôle sur les seuls noms data.get/update observés.

## Configuration et identités

1. Attester séparément par service la branche/SHA, la base, le projet Firebase,
   le principal **consommé au runtime** et ses droits IAM/règles RTDB. La
   [carte M0](M0.md) contient désormais les déclarations Render vérifiées par
   Work : même cible/principal beta/main, runtime attesté, droits de données et
   suppression d'instance prouvés. Réduction IAM bloquée par les accès disponibles ;
   bindings/clés et autres privilèges non entièrement qualifiés.
2. Secrets dédiés acquis : quatre valeurs distinctes de 512 bits installées par
   Work sur les deux services, consommation et redémarrages attestés. Ne pas les
   régénérer sans anomalie. Abandonner avec M1 les capacités publiées héritées et
   retirer les anciens secrets devenus inutiles après contrôle des consommateurs.
   Aucun secret AdminSDK/Mistral/SMTP déclaré compromis sans preuve. Aucun repli
   sur `SESSION_SECRET` ou mot de passe admin partagé ; aucune capacité TWA large.
3. Provisionner, dans les autorisations M0/M1 déjà accordées, après satisfaction
   des prérequis vérifiables, des identités individuelles dans
   `professionalIdentities/<id>` : email normalisé unique, `passwordHash` scrypt
   via le mécanisme existant, `active`, `roles` explicitement choisis parmi
   practitioner/commercial_support/technical_support/administrator,
   `authorizationVersion` entier non négatif, `displayName` lisible pour le
   consentement. Inventaire complet total0 : aucun compte durable à migrer.
   Le propriétaire déjà connu est désormais autorisé avec administrator seul ;
   restent saisie/remise privée et provisioning par le helper ciblé, sans déduire
   d'autres rôles de son ancien full. Aucun compte inventé ni créé dans Cloud.
4. Les cookies professionnels anciens sont refusés. Les nouvelles sessions
   opaques ont un schéma versionné, une durée maximale de 24 h et une révocation
   durable ; changer `authorizationVersion`, désactiver l'identité ou retirer
   un rôle coupe l'accès dès la prochaine requête. Contrôler la politique
   d'expiration et de conservation du journal avant activation.

## Plan de bascule sûre sur la cible partagée

Ce plan s'exécute dans les autorisations M0/M1 déjà accordées, après satisfaction
des prérequis vérifiables contrôlés par Work ; aucune étape réelle n'est exécutée
dans cette livraison documentaire. PR27 reste **draft**, sans
fusion, déploiement, provisioning ni modification de secrets/services/comptes.

**Point de départ confirmé par Work, 05/10/2026.** Beta et main sont live à
`f20d84f1962c552eaebb095d7a9e5ddb63719be7`. Leurs pages Environment déclarent la
RTDB `https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/`,
projet `facilitat-io`, principal
`firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com`.
Constat initial avant configuration Work : en beta les secrets dédiés
`USER_SESSION_SECRET`/`ADMIN_SESSION_SECRET` manquaient ;
`ADMIN_PASSWORD`/`SESSION_SECRET` sont présents ; aucun groupe lié ni secret file
visible. Métadonnées seules, sans valeur de secret/clé privée ni lecture de
données applicatives. Connexion Render débloquée ; isolation non démontrée.

1. **Établir l'autorité opérationnelle M0.** Work doit disposer d'un accès
   permettant de consulter les métadonnées du principal, rôles/bindings IAM,
   règles RTDB, sources des credentials et dépendances de chaque service.
   Consigner base/projet/principal réellement consommés, SHA et source de
   configuration au runtime, sans clé ni contenu utilisateur. Si un accès IAM
   manque pour réduire les droits excessifs, conserver ce prérequis bloquant
   et la PR en draft. Runtime/règles et permissions de données sont attestés ;
   `instances.delete=true` sur les deux services est excessif pour M1.
   `setIamPolicy=false` interdit l'autocorrection ; UI IAM/Cloud Shell indisponibles.
   Inspecter les bindings et les consommateurs depuis un accès opérateur existant,
   puis réduire les permissions de gestion inutiles sans deviner un rôle ni
   modifier la cible partagée. Ne pas remplacer cette preuve par un test sur la base.
2. **Traiter la RTDB comme une cible commune.** Inventorier les chemins concernés
   (users/conversations/messages, anciens privés, identités/sessions
   professionnelles, affectations/grants/journal) et les consommateurs main/beta
   avant toute écriture dans les autorisations M0/M1 déjà accordées, après
   satisfaction des prérequis vérifiables. Un namespace ou une variable portant « beta »
   ne fournit pas d'isolation avec ce même principal. Les règles RTDB seules
   ne bornent pas un SDK Admin disposant d'accès administratif ; attester aussi
   les droits du principal. Les barrières M1 sont applicatives, pas une séparation
   IAM. Tant que main reste au code hérité, ne pas présenter le privé local, les
   grants ou révocations beta comme une protection des parcours main encore
   hérités. Le partage est intentionnel et ne bloque pas la validation beta par
   principe ; pas de projet/base à créer. Configuration des deux services et
   rotations sont autorisées M0/M1 ; fusions bloquées avant clôture des prérequis,
   main avant bilan final. Droits/ressources non définis gardent leurs contrôles.
3. **Préparer rotation et configuration avant fusion.** Dans les autorisations
   M0/M1 déjà accordées : Work a installé les quatre secrets dédiés distincts de
   512 bits sur les deux services et confirmé leur consommation runtime. Ne pas
   régénérer ces valeurs acquises sans anomalie. M1 les requiert sans repli sur
   `SESSION_SECRET`/`ADMIN_PASSWORD`. Vérifier l'autoDeploy et prévoir une fenêtre
   de configuration/bascule avant toute fusion susceptible de déployer.
   Inventorier les consommateurs des secrets publiés, puis organiser leur
   remplacement/révocation. Si une clé de service ou un ancien secret est partagé,
   ne pas le révoquer depuis beta seule : coordonner tous ses consommateurs et
   attester leurs remplacements ; configuration/rotation des deux services permises,
   sans promotion du code main avant bilan final. La rotation d'une
   signature utilisateur invalide les anciens cookies ; la rotation du secret
   professionnel ne révoque pas à elle seule les tokens opaques durables :
   utiliser révocation/authorizationVersion dans les autorisations M0/M1 déjà
   accordées, après satisfaction des prérequis vérifiables. Ne pas supposer que les
   anciennes capacités main sont supprimées par le nouveau code beta.
4. **Provisionner M1 seulement après contrôle des droits.** Préparer une liste
   validée d'identités individuelles et rôles minimaux ; comptes de recette
   explicitement automatisés, jamais identité personnelle de l'utilisateur.
   Provisionner selon le schéma ci-dessus, vérifier unicité email, hash/version et
   révocations ; affectations explicites. Aucun grant de contenu automatique :
   l'utilisateur choisit scope/date/synthèse. Établir les droits d'accès et la
   rétention des nœuds professionnels/journal sur la base commune. Les droits
   de données sont prouvés ; réduction IAM et provisioning/remise restent à
   finaliser. Aucun acteur/affectation/grant inventé ; le partage intentionnel
   n'est pas en lui-même un blocage. La future ouverture main attend bilan final
   et pré-FF ; ses protections M1 ne sont pas revendiquées avant promotion.
5. **Bascule beta dans les autorisations M0/M1 déjà accordées, après satisfaction
   des prérequis vérifiables et revue Work.** Une fois les
   prérequis précédents attestés, fixer le SHA de livraison et le périmètre de
   recette restreint ; ne pas ouvrir la beta au public. Déployer seulement beta
   après satisfaction des prérequis vérifiables, attester son nouveau SHA et sa
   configuration effective. Contrôler d'abord santé et fermeture des anciennes
   capacités, puis les parcours du compte technique minimal et le journal sans
   contenu dans les autorisations M0/M1 déjà accordées. Les tests synthétiques existants restent la preuve
   disponible ; aucun test fournisseur réel n'est exécuté dans cette mise à jour documentaire.
   Préserver les données locales légitimes/IDs/dates ; aucune migration par
   réattribution des objets hérités. Le comportement privé local ne vaut que
   pour les parcours utilisant le code M1, pas pour main resté à `f20d84f`.
6. **Échec et résidus.** En cas d'échec concret de configuration/autorité,
   suspendre l'accès de recette beta dans les autorisations M0/M1 déjà accordées,
   après satisfaction des prérequis vérifiables ; aucun reset de la base
   partagée, aucune restauration globale, aucun rollback vers les capacités
   héritées réouvertes. Choisir un retour compatible avec les sessions/grants
   déjà durables avant de l'exécuter. Inventaire des anciens privés/logs et
   sauvegarde relèvent des autorisations M0/M1 déjà accordées, après satisfaction
   des prérequis vérifiables. La purge irréversible conserve ses limites et
   contrôles propres sur tous les consommateurs de la cible commune ; aucun
   effacement implicite M1.

Prérequis vérifiables de livraison à contrôler par Work : attestation
runtime et IAM/règles, inventaire des dépendances partagées, preuve de préparation
des secrets dédiés sans leurs valeurs, plan de rotation/révocation coordonné,
liste de provisioning et accès journal approuvés, fenêtre beta et retour sûr.
Les autorisations M0/M1 sont déjà accordées : aucun nouveau GO général requis.
Les deux blocages finaux sont la réduction IAM impossible avec les accès
disponibles et le provisioning/remise privée du credential du seul propriétaire
déjà identifié, rôle administrator seul. Aucun nominatif/rôle manquant.
L'empreinte de source runtime correspond au code live `f20d84f` ;
`LOG_PERSIST=true`, rétention14, exploitation normale conservée, sans blocage ajouté.
Configuration/rotation des deux services autorisées ; aucune fusion main avant
bilan final/pré-FF. Purge irréversible et créations/élargissements de droits ou
ressources non encore définis conservent leurs limites et contrôles propres.

## Affectations, consentement et audit

- Provisionner explicitement `practitionerAssignments/<professionalId>/<userId>`
  avec `active: true` pour les seules affectations voulues. Une affectation seule
  et une demande de contact humain ne donnent aucun accès au contenu.
- L'utilisateur accorde/révoque dans Mon compte son grant spécifique (choix des
  conversations publiques par titres/dates) ou de période (historique et futures
  publiques pendant la période). La synthèse inter-session a son propre choix.
  L'échéance est un instant local affiché avec son fuseau, persisté en epoch ms.
- Les API de grant contrôlent identité, affectation et objets ; les API praticien
  relisent affectation/grant/propriétaire avant restitution. Aucun cache de droits.
  Les rôles cumulés utilisent le rôle exercé par la route, sans promotion implicite.
- Chaque accès admin aux API exige un motif prédéfini. L'UI attend son choix.
  La levée de pseudonymisation utilise un motif distinct et produit
  `identity_unmask`. Les journaux durables contiennent des références HMAC/codes,
  jamais les paramètres bruts, transcript, mémoire ou debug.
- Le praticien reçoit la projection minimale. Sélection/copie/impression sont
  freinées dans l'UI ; aucune promesse d'impossibilité absolue de capture.

## Données privées, héritage et exploitation

- Transcript, memory/flags et memoryState complets restent dans le namespace
  authentifié de l'appareil. Le serveur attend la consolidation privée pour le
  résultat final, tout en transmettant les tokens avant sa fin. Le debug reste
  N-1. Aucun stockage privé Firebase/cache conversationnel inter-requêtes, ni
  enrichissement inter-session privé.
- La copie feedback volontaire reste une exception distincte : paire bornée,
  commentaire et contexte borné annoncés par la confirmation existante. L'import
  privé vers public reste explicite ; les IDs/dates de memoryState sont conservés.
- Les données héritées sans identité fiable restent physiquement conservées,
  en quarantaine : aucun claim ou transfert arbitraire. Les messages historiques
  orphelins ou étrangers bloquent l'import/overwrite. Les lectures/seeds excluent
  les enfants étrangers, privés ou sans propriétaire fiable.
- Après une bascule validée, inventorier l'ancien nœud privé et les logs historiques,
  leurs sauvegardes, accès et rétention. Une purge demande une cible attestée, un
  périmètre, un ordre, une preuve et un mandat opérationnel distincts. Rien n'est
  purgé ici. Le cycle serveur delete/reset/closure et la refonte replay restent M2.
- Le verrou total `--apply` des opérateurs est conservatoire. Les simulations ne
  prouvent ni une opération réelle ni l'isolation des services déployés.

## Reproduction

Dans un checkout propre, Node et npm disponibles :

```sh
npm ci --ignore-scripts --no-audit --no-fund
bash scripts/synthetic/verify.sh
```

Le runner assainit l'environnement et précharge son garde versionné. Il exécute
opérateur/isolation/professionnel/privé/navigateur/projection/associations/consentement
puis tout `npm run verify`. Aucun `/workspace/acp-validation`, secret ou serveur
externe n'est requis. Seul le téléchargement explicite des dépendances demande
l'accès au registre npm. Express réel traite parsing, montages, ordre, erreurs et
SSE sur des flux mémoire ; aucun listener réseau. RTDB reste un double local,
sans preuve de concurrence distribuée ou d'IAM réel.

Les preuves initiales exactes sont versionnées dans `evidence/initial` avec leurs
empreintes M0. Les fichiers `.cjs.txt` et `.sh.txt` sont des archives documentaires,
pas les commandes actuelles. Le runner courant se trouve dans `scripts/synthetic`.
