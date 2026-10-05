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
