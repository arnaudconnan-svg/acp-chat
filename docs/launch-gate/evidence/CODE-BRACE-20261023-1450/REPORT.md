# CODE-BRACE-20261023-1450

Base beta : `737b94156f23eadca27c5366dcf6c82853079bd0` (remote exact vérifié, fetch frais, checkout initial propre).
Commit technique testé : `90673565e115939611926646cad56851d5bcd1d2` ; le commit suivant contient uniquement ces preuves.
AGENTS.md, WORKFLOW.md et PROMPTING.md actifs relus sur la base avant édition. Branche : `code-brace-20261023-1450`.

## Correction

Seule entrée de résolution changée : `brace-expansion` **1.1.14 → 1.1.21**, dev-only.
Chaîne physique chargée : `@eslint/eslintrc 3.3.5 → minimatch 3.1.5 → brace-expansion 1.1.21`.
Parents et plage `^1.1.7` inchangés ; toutes les autres entrées du lock sont comparées intégralement à la base.
`package.json` ajoute le harnais à `verify`. Nouveau `scripts/synthetic/brace-harness.cjs` ; aucune modification du serveur, du front admin ou de la garde M0.

L'audit npm du 23 octobre 2026 confirme :

| Avis | Plage vulnérable observée |
|---|---|
| GHSA-3jxr-9vmj-r5cp | <1.1.16 |
| GHSA-mh99-v99m-4gvg | <1.1.17 |
| GHSA-rgw5-rvv9-x895 | <1.1.18 |
| GHSA-q2hr-2g5m-vwhr | <1.1.21 |
| GHSA-qhr7-859c-m2p7 | <1.1.20 |
| GHSA-6j4f-fj2g-mc7p | <1.1.19 |

`resolution-proof.stdout` vérifie avec semver toutes les versions publiées compatibles : la première hors des six plages est **1.1.21**.
`audit-before/after.stdout` sont du JSON npm valide. La cible disparaît ; les objets complets `fast-copy` et `protobufjs` restent exactement identiques. Les deux audits sortent **1** : aucun PASS global/CI prétendu.

## Validation réellement exécutée

Node effectif **v24.19.0** observé dans le processus du harnais. Commandes, heures UTC, codes et SHA stdout/stderr : fichiers `.json` adjacents.

| Capture | Code | Résultat |
|---|---:|---|
| baseline-harness | 1 | Cinq assertions de sécurité rouges sur 1.1.14, cas normaux verts |
| npm-ci | 0 | `ci --ignore-scripts --no-audit --no-fund` |
| final-brace | 0 | Paquet physique réel + minimatch réel, six fixtures bornées |
| final-syntax | 0 | Syntaxe du nouveau harnais |
| final-lint | 0 | ESLint ciblé du nouveau harnais |
| final-isolation | 0 | Isolation M0 conservée |
| final-verify | 0 | Vérification complète, dont syntaxe server.js |
| resolution-proof | 0 | Plages, intégrités, sources physiques, résiduels |
| tested-code-check | 0 | `git show` du SHA technique ↔ quatre fichiers testés |

Les vérifications finales utilisent `env -i` et le preload M0 existant. Aucun HTTP/socket/TLS/provider réel n'est exécuté. Les avertissements de dépréciation npm/router sont conservés. Le lint global hérité (337 erreurs/17 avertissements acquis) n'est pas relancé ni déclaré corrigé.

La sortie du vrai paquet est comparée pour chaque fixture à une seconde exécution de sa source exacte, instrumentée uniquement pour compter les appels au vrai `balanced-match` et la profondeur de `parseCommaParts`. Il ne s'agit ni d'un mock de l'algorithme ni d'un benchmark de temps. Entrées ≤401 octets, budgets explicites minuscules ; aucun PoC OOM ni épuisement de pile.

Les cinq discriminants 1.1.14 → 1.1.21 : longueur totale 640→20 caractères avec budget32 ; alternatives intermédiaires 82→7 appels ; profondeur du parseur25→1 ; profondeur des groupes48→6 appels ; réécritures17→3 appels. La comparaison publique 1.1.17 → 1.1.21 (`intermediate-comparison.stdout`, script `intermediate-probe.cjs`) confirme 82→7 appels **même quand les deux sorties finales respectent déjà 16 caractères**, distinguant l'accumulation intermédiaire de la seule limitation de sortie.

**Limite explicite GHSA-3jxr** : la fixture de 24 groupes `{}` est verte sur les deux versions (un appel). L'explosion exponentielle n'est donc pas reproduite sur 1.1.14. Sa source npm diffère de l'extrait générique de l'avis : l'expansion de `post` est déjà placée après le retour des groupes non expansibles. La plage npm officielle reste `<1.1.16` ; elle n'est pas réinterprétée. Cette sixième fixture est une borne de non-régression, pas une preuve rouge→vert pour cet avis.

## Provenance et reçu

`metadata.stdout`, `baseline-metadata.stdout`, `comparison-metadata.stdout` : réponses npm officielles, tarballs/intégrités/gitHead/signatures publiées.
`resolution-proof.stdout` : SHA256 des sources 1.1.14/1.1.17/1.1.21, chemins physiques, fonctions et lignes. SHA512 et SHA1 des tarballs vérifiés contre npm ; source physique installée identique à celle du tarball1.1.21.
`source-diff.stdout` : diff exact des sources publiques 1.1.14→1.1.21 (code1 attendu de `diff` = différences).
`advisory-*.excerpt.txt` : passages utiles des pages GitHub ; stdout HTML original compressé sans perte en `.stdout.gz` (le SHA du fichier décompressé est celui de la capture `.json`).
Signatures npm et Sigstore **non vérifiés indépendamment** ; gitHead est une métadonnée déclarée, pas une attestation.
`tested-code-receipt.json` relie le commit technique aux hashes de package.json, package-lock.json, guard.cjs et brace-harness.cjs, et aux commandes finales horodatées. Aucun manifeste repo/data.

Développement uniquement ; aucune affirmation sur un chemin Firebase runtime, auth déployée ou déploiement. Réseau UNKNOWN conservé. Aucun autre finding traité. PR vers beta uniquement, non fusionnée : STOP pour revue Work.
