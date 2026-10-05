# M2 — checkpoint en cours, non livré

Départ vérifié le 5 octobre 2026 : `5b3f83a5b9b6b2824c8bca578976bcca8eb4f390`,
checkout propre, descendant de `origin/beta` (`0/19`). Références distantes :
PR27 et `work/m0-m1-launch-gate` à ce SHA ; beta/main à
`f20d84f1962c552eaebb095d7a9e5ddb63719be7`. Branche M2 distante absente au départ,
branche locale renommée `work/m2-launch-gate` sans modification d'historique.
PR27 reste intacte. Le brief M2 joint, lu jusqu'à LIVRABLES, est le périmètre.

## Première tranche implémentée

- Frontière de commit commune aux collections RTDB historiques : refus durable
  des recréations de conversations/utilisateurs retirés, y compris messages
  top-level et updates imbriqués de métadonnées.
- Suppression physique parent/messages/copies et branches connues du même
  propriétaire, dont la provenance `adminReplaySourceConversationId`.
  Feedback volontaire séparé conservé lors du retrait de sa source ; reset et
  clôture retirent les objets actifs du compte. Aucun archivage intégral nouveau.
- Grants et affectations utilisateur retirés sans supprimer une identité
  professionnelle ; identité `launch-owner` et résultats M0/M1 inchangés.
- Primitives de versions mémoire/turn et CAS ; consolidation et édition manuelle
  intersession raccordées. Raccord complet du chat encore à finir.
- Rejets mémoire pris en charge dès création des deux enfants, formats invalides
  rejetés, nettoyage reset ciblant l'ancien espace, 409 métier distinct du
  changement d'identité. Retour close lié à sa destination initiale.
- Streaming désactivé refusé avant la réclamation d'un parent absent.

## Vérifications réellement exécutées

`node --check server.js` : PASS.

`env -i PATH="$PATH" NODE_ENV=test NODE_OPTIONS=--require="$PWD/scripts/synthetic/guard.cjs" node scripts/synthetic/m2-lifecycle-harness.cjs` :
18 PASS. Vrai pipeline Express sans listener, fixtures uniquement. Inclut null
initial de transaction, callback rejoué après conflit, acknowledgement perdu,
requête fraîche après restart simulé, query.ref/snapshot.ref/multi-update,
lecture finale rejetée sans contenu ni rejet non géré, maintien des données B.

Premier `bash scripts/synthetic/verify.sh` après modifications : arrêté sur
l'ancien oracle M1 `/chat/stream` qui attendait 400/403/404 ; le nouveau refus
précoce donne 405. Historique conservé. L'oracle a été adapté précisément
au refus `streaming_disabled`, et un témoin activé confirme le refus intercompte
sans effet. Le harnais associations lit désormais les namespaces configurés
plutôt que de supposer une écriture `set` hors transaction.

Runner complet ensuite PASS (code 0), exécuté avec le même garde hermétique
hors sandbox pour permettre la capture des sous-processus Git factices ; aucun
protocole pré-FF n'a été exécuté sur le dépôt de travail.
Sortie intégrale : `evidence/M2-checkpoint-1-verify.log`, SHA256
`6b4aff87646cbc7a1f408d0ce407c249fe4c06d4fdb75b645fc1e581cc1cc50a`.

## Prochaines actions nécessaires

1. Achever le raccord version/commit/restitution du chat, suivre ses enfants
   jusqu'à terminaison effective, distinguer réponse et sauvegarde/consolidation.
2. Rendre branches/snapshots/replay atomiques et récupérables, avec provenance,
   create/replace explicites, retry/ack perdu/échec partiel sans duplication.
3. Compléter les oracles navigateur et Express de courses et copies ; exécuter le
   runner hermétique après ces changements puis publier rapport et matrice G15.

Ce checkpoint n'est pas une clôture M2. Aucun service, donnée réelle, fournisseur,
merge, déploiement, pré-FF ou M3–M6. M0/M1 acquis conservés ; G22 préparé seulement,
acceptation CJ6 future, industrialisation G17 reportée.

## Deuxième checkpoint — chat/front/copies, M2 toujours en cours

Le premier checkpoint publié est `e146518d199e8afdd3f7229b18c899b0d2235618`.
La présente tranche raccorde le chat aux versions de commit, conserve les enfants
jusqu'à leur terminaison effective et sépare disponibilité de réponse, sauvegarde
confirmée/incertaine et consolidation mémoire. Une réponse N disponible dont le
message attend encore son commit reste sauvegardable après le début de N+1 ;
seuls ses effets périmés sur l'état courant sont écartés. Le retrait reste refusé.

Les copies branches, snapshots volontaires, replay et import local sont atomiques
et récupérables après perte d'accusé. `copyReceipts` est retiré avec les objets
concernés ; les fences empêchent la recréation après retry/restart. La révision
`m2CopyVersion` progresse sur toute mutation d'une conversation ou de ses messages,
y compris un nouveau tour, une édition mémoire et un message tardif. Le replay
exige create/replace explicite et refuse replace si la révision préparée a changé.
Le client conserve la demande de copie exacte jusqu'à confirmation et hydrate
la branche depuis sa destination canonique, sans réinjecter un ancien seed.

Vérification réelle : `node --check server.js`, `git diff --check` et
`bash scripts/synthetic/verify.sh` PASS, code 0. Sortie complète
`evidence/M2-checkpoint-2-verify.log`, SHA256
`f8011d329de5fba2db2db53f01862a7f0676a455c5d24b4bf9f76a5762f67ef0`.
Le runner versionné inclut désormais 18 lifecycle + 9 chat + 10 navigateur +
16 copies, puis les suites de régression existantes. Aucun serveur écoutant,
SDK/fournisseur réel ni donnée réelle. Les contrôles Git du runner ne concernent
que leurs fixtures locales, sans pré-FF sur ce dépôt.

Oracles nouveaux : vrais handlers Express avec writer/mémoire retenus pendant
DELETE/reset/close ; véritable front close/reset/closure ; copie dont l'accusé
est perdu, corps retardé après retrait/changement d'identité ; import privé
volontaire qui reste privé tant que l'ack manque ; canonical IDs après reprise.
Le replay conserve les véritables `sessionStableContext`, `onGoingMovements`,
`ancientMovements`, IDs, `createdAt` et `archivedAt`, les contrôles de révision et
la barrière de retrait. Ceci ne prouve pas une fidélité historique automatique :
le replay reste une reconstruction admin explicite.

Restent avant clôture : streaming activable (y compris interruption/retry et
retour frontend), derniers oracles replay frontend/retours de sauvegarde,
revue des contrôles structurés des copies, matrice G15 et bilan G05/G10/G17/G22,
puis régression complète sur l'arbre final. PR28 reste draft base beta, dépendante
de PR27 intacte. Le coût racine/capacité M4 et la coordination des anciens writers
f20 sur Firebase partagé figurent dans `M2-operation-policy.md`. Aucun merge,
déploiement, pré-FF réel ou M3–M6 ; ce checkpoint ne clôt pas M2.

## Tranche finale — générations et streaming, avant clone indépendant

Après `6693f240ecf287ccd1fe6192e66ddad5898ac6e5`, distinction explicite entre tour
et génération de contenu : replay/import forcé/activation invalident l'ancienne
génération sans perdre N après N+1. Oracles réels writer, mémoire et commit de
message retenus contre chaque remplacement ; consolidation contre remplacement.
Stop/interruption sont arbitrés dans le commit, un partiel n'écrase pas une
réponse complète. Son frontend laisse alors le partiel non confirmé sans copier
l'ID du complet. Aucune nouvelle décision de posture ou de mémoire sémantique.

Le dernier runner complet avant le correctif completed-wins navigateur a passé :
18 lifecycle, 17 chat, 23 navigateur, 18 copies, 8 stream puis suites existantes.
Le correctif frontend ajoute le 24e cas navigateur, ciblé PASS. Le contrôle complet
de l'arbre exact depuis clone indépendant et les empreintes finales suivent dans
le manifeste. La correction TTL pro d'un instant unique est bornée à l'échec 401
intermittent observé et testée par horloge avançante ; aucune reprise M1/PR27.

Rapport : `M2-report.md`. Matrice : `M2-G15-matrix.md`. Réserves opérationnelles,
version mixte f20 et coût racine conservés. Toujours aucun merge/déploiement réel.
