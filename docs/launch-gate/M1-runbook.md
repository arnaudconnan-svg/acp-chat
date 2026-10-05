# M1 — prérequis avant activation

Le code et les tests sont synthétiques. Aucun compte, grant, secret, service ou
donnée réel n'a été modifié. Ne pas activer ni fusionner automatiquement ce
chantier ; Work doit vérifier les prérequis avant livraison beta.

## Configuration et identités

1. Attester séparément par service la branche/SHA, la base, le projet Firebase,
   le principal **consommé au runtime** et ses droits IAM/règles RTDB. La
   [carte M0](M0.md) contient désormais les déclarations Render vérifiées par
   Work : même cible/principal beta/main, runtime et droits non inspectés.
2. Révoquer/rotater hors Git les secrets précédemment publiés. Configurer des
   secrets dédiés et distincts `USER_SESSION_SECRET` et `ADMIN_SESSION_SECRET`
   (au moins 32 caractères aléatoires). Aucun repli sur `SESSION_SECRET` ou mot
   de passe admin partagé ; aucune capacité TWA large.
3. Provisionner sous mandat des identités individuelles dans
   `professionalIdentities/<id>` : email normalisé unique, `passwordHash` scrypt
   via le mécanisme existant, `active`, `roles` explicitement choisis parmi
   practitioner/commercial_support/technical_support/administrator,
   `authorizationVersion` entier non négatif, `displayName` lisible pour le
   consentement. Aucun compte réel inventé dans cette tâche.
4. Les cookies professionnels anciens sont refusés. Les nouvelles sessions
   opaques ont un schéma versionné, une durée maximale de 24 h et une révocation
   durable ; changer `authorizationVersion`, désactiver l'identité ou retirer
   un rôle coupe l'accès dès la prochaine requête. Contrôler la politique
   d'expiration et de conservation du journal avant activation.

## Plan de bascule sûre sur la cible partagée

Ce plan prépare une opération future à valider par Work ; aucune étape réelle
n'est exécutée dans cette livraison documentaire. PR27 reste **draft**, sans
fusion, déploiement, provisioning ni modification de secrets/services/comptes.

**Point de départ confirmé par Work, 05/10/2026.** Beta et main sont live à
`f20d84f1962c552eaebb095d7a9e5ddb63719be7`. Leurs pages Environment déclarent la
RTDB `https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/`,
projet `facilitat-io`, principal
`firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com`.
En beta les secrets dédiés `USER_SESSION_SECRET`/`ADMIN_SESSION_SECRET` manquent ;
`ADMIN_PASSWORD`/`SESSION_SECRET` sont présents ; aucun groupe lié ni secret file
visible. Métadonnées seules, sans valeur de secret/clé privée ni lecture de
données applicatives. Connexion Render débloquée ; isolation non démontrée.

1. **Établir l'autorité opérationnelle M0.** Work doit disposer d'un accès
   permettant de consulter les métadonnées du principal, rôles/bindings IAM,
   règles RTDB, sources des credentials et dépendances de chaque service.
   Consigner base/projet/principal réellement consommés, SHA et source de
   configuration au runtime, sans clé ni contenu utilisateur. Si un accès IAM,
   aux règles ou à l'attestation runtime manque, conserver ce prérequis bloquant
   et la PR en draft. Ne pas remplacer cette preuve par un test sur la base.
2. **Traiter la RTDB comme une cible commune.** Inventorier les chemins concernés
   (users/conversations/messages, anciens privés, identités/sessions
   professionnelles, affectations/grants/journal) et les consommateurs main/beta
   avant tout mandat d'écriture. Un namespace ou une variable portant « beta »
   ne fournit pas d'isolation avec ce même principal. Les règles RTDB seules
   ne bornent pas un SDK Admin disposant d'accès administratif ; attester aussi
   les droits du principal. Les barrières M1 sont applicatives, pas une séparation
   IAM. Tant que main reste au code hérité, ne pas présenter le privé local, les
   grants ou révocations beta comme une protection des accès par main. Toute
   dépendance nécessitant une action main ou une séparation effective demande
   un chantier/mandat distinct ; ne pas l'exécuter sous cette mission M0/M1.
3. **Préparer rotation et configuration avant fusion.** Sous mandat opérationnel,
   fournir à beta deux valeurs nouvelles, indépendantes et aléatoires d'au moins
   32 caractères pour les secrets dédiés, hors Git et rapports. Leur absence
   actuelle bloque le démarrage M1 : le code refuse, sans repli sur
   `SESSION_SECRET`/`ADMIN_PASSWORD`. Vérifier l'autoDeploy et prévoir une fenêtre
   de configuration/bascule avant toute fusion susceptible de déployer.
   Inventorier les consommateurs des secrets publiés, puis organiser leur
   remplacement/révocation. Si une clé de service ou un ancien secret est partagé,
   ne pas le révoquer depuis beta seule : coordonner tous ses consommateurs et
   attester leurs remplacements, sans changer main ici. La rotation d'une
   signature utilisateur invalide les anciens cookies ; la rotation du secret
   professionnel ne révoque pas à elle seule les tokens opaques durables :
   utiliser révocation/authorizationVersion sous mandat. Ne pas supposer que les
   anciennes capacités main sont supprimées par le nouveau code beta.
4. **Provisionner M1 seulement après contrôle des droits.** Préparer une liste
   validée d'identités individuelles et rôles minimaux ; comptes de recette
   explicitement automatisés, jamais identité personnelle de l'utilisateur.
   Provisionner selon le schéma ci-dessus, vérifier unicité email, hash/version et
   révocations ; affectations explicites. Aucun grant de contenu automatique :
   l'utilisateur choisit scope/date/synthèse. Établir les droits d'accès et la
   rétention des nœuds professionnels/journal sur la base commune. Si main ou
   un autre consommateur peut contourner ces barrières, garder l'activation
   professionnelle beta bloquée jusqu'à une résolution séparément autorisée.
5. **Bascule beta sous mandat distinct, après revue Work.** Une fois les
   prérequis précédents attestés, fixer le SHA de livraison et le périmètre de
   recette restreint ; ne pas ouvrir la beta au public. Déployer seulement beta
   après autorisation, attester son nouveau SHA et sa configuration effective.
   Contrôler d'abord santé et fermeture des anciennes capacités, puis, si
   explicitement autorisés, les parcours du compte technique minimal et le
   journal sans contenu. Les tests synthétiques existants restent la preuve
   disponible ; aucun test fournisseur réel n'est exécuté ni autorisé ici.
   Préserver les données locales légitimes/IDs/dates ; aucune migration par
   réattribution des objets hérités. Le comportement privé local ne vaut que
   pour les parcours utilisant le code M1, pas pour main resté à `f20d84f`.
6. **Échec et résidus.** En cas d'échec concret de configuration/autorité,
   suspendre l'accès de recette beta sous le même mandat ; aucun reset de la base
   partagée, aucune restauration globale, aucun rollback vers les capacités
   héritées réouvertes. Choisir un retour compatible avec les sessions/grants
   déjà durables avant de l'exécuter. Inventaire des anciens privés/logs,
   sauvegarde et purge éventuelle restent un mandat distinct portant sur tous
   les consommateurs de la cible commune ; aucun effacement implicite M1.

Livrables opérationnels attendus avant GO de livraison par Work : attestation
runtime et IAM/règles, inventaire des dépendances partagées, preuve de préparation
des secrets dédiés sans leurs valeurs, plan de rotation/révocation coordonné,
liste de provisioning et accès journal approuvés, fenêtre beta et retour sûr.
Cette documentation ne constitue aucun GO d'opération réelle ni de main.

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
