# M1 en cours — corrections Work et continuité privée

5 octobre 2026. Ce checkpoint conserve l'avancement depuis `91d6e4e` ; ce n'est
pas une clôture. Destination : `work/m0-m1-launch-gate`, sans fusion.

## État du code

- `lib/professional-access.js`, `server.js` : schéma durable strict des sessions
  (dates finies, durée bornée, version, révocation), clé canonique des
  conversations, refus d'objet absent/étranger même sous grant large, rôle
  praticien exercé explicitement pour un cumul administrator+practitioner.
- Journal admin : références HMAC, codes et motifs prédéfinis, sans chemins ni
  paramètres bruts. `identity_unmask` reste un événement distinct. La page admin
  peut servir son shell ; les API exigent toujours leur motif.
- `lib/log-projection.js` et `lib/logger.js` : une factory partagée par la
  production et les tests projette avant le vrai pino et la console.
- Chat : vérification d'autorité avant effets différés, mises à jour
  conversationnelles conditionnelles, nettoyage des opérations même en sortie
  anticipée et finalisation protégée par un lease.
- Navigateur : stockage par identité, données héritées inconnues conservées
  mais non réattribuées, invalidation entre onglets et refus des retours tardifs.
  Destinations locales strictes, dont refus des traversées normalisées.
- UI en cours : motifs admin distincts, contrôle utilisateur des grants,
  projection et gardes copie/sélection/impression praticien. Ces gardes ne
  prétendent pas empêcher toute capture.
- Modules et harnesses nouveaux formatés pour la revue. Les gardes M0 et leurs
  preuves originales restent conservés.

## Preuves réellement exécutées

Sous `NODE_OPTIONS=--require=./scripts/synthetic/guard.cjs` :

- `professional-harness.cjs` PASS : refus chaud/froid des sessions malformées,
  expiration absente/NaN/infinie, clé/id contradictoires, grant large et objet
  absent/étranger, cumul positif, révocation, supports, motif admin et identifiant
  adversarial absent du journal.
- `object-private-harness.cjs` PASS : pipeline Express réel sans listener,
  privé multi-tour, stockage local/rechargement, redémarrage, conservation des
  IDs/dates, debug N-1, aucun effet durable privé, identifiant privé réutilisé
  par B sans reprise de A ; refus intercomptes avant effet, owner-cancel,
  progress autorisé/refusé, finalisation inverse, partage feedback borné et
  absence d'écriture assistant/mémoire après perte d'autorité.
- `browser-harness.cjs` PASS : namespaces A/B, logout, héritage en quarantaine,
  onglets, offline, réponse tardive et destinations locales positives/négatives.
- `log-projection-harness.cjs` PASS : sorties du mécanisme réel pino/console et
  bindings sans marqueurs factices de secret/transcript/mémoire/debug.
- Harnesses historiques password-reset frontend et server PASS après adaptation
  des dépendances partagées et de la borne d'extraction de route.
- `node --check server.js` PASS.

## Validations restantes et prochaine action

La suite globale n'est pas encore verte : ses premiers essais ont identifié les
deux dépendances historiques ci-dessus, corrigées puis retestées individuellement.
Reste à brancher tous les contrôles M1 dans le runner versionné, exécuter
`npm run verify` intégralement sous ce garde, compléter les tests grants/UI/import
et concurrence, puis refaire la commande depuis un checkout propre. Vérifier
également la syntaxe des scripts inline et le diff final.

Produire ensuite le rapport par gate, les prérequis de configuration/migration et
la PR vers beta pour Work, sans fusion. Aucun service réel, déploiement ou purge
n'a été effectué. Le verrou `--apply` reste une mesure conservatoire totale ; il
ne constitue pas une preuve d'opération réelle.
