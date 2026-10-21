# CODE-JSYAML-20261021-0931

Base fraîche/HEAD initial exact : `e23bc20e06c14438a02034c6feb49bf0dcec41d8`.
Remote `arnaudconnan-svg/acp-chat`, checkout initial propre. Consignes AGENTS,
WORKFLOW et PROMPTING relues sur la base avant édition. Checkout restauré sur
l'ancien `work` 11a41e9, préservé ; nouvelle branche `code-jsyaml-20261021-0931`
depuis vraie beta, aucun reset/force-push.

Correction technique : **js-yaml 4.1.1 → 4.3.2**, seule entrée de dépendance modifiée
au lock. Parent physique **@eslint/eslintrc 3.3.5**, plage **^4.1.1**, inchangé.
Aucun parent/override/autre famille modifié. package.json ajoute le harnais et son
inclusion dans verify. Garde M0 inchangée, aucune exception.
Code technique réellement testé : **`2c87a1db8dac795594ea95d1f3e952356fabfd06`**,
commité AVANT contrôles finaux, après 9c29b43 (patch initial + harnais).

## Résolution npm officielle actuelle

| Avis | Plage observée | Première version publiée hors plage |
| --- | --- | --- |
| GHSA-h67p-54hq-rp68, aliases/merges répétés, moderate | >=4.0.0 <=4.1.1 | 4.2.0 |
| GHSA-52cp-r559-cp3m, chaînes merge, high | >=4.0.0 <4.3.0 | 4.3.0 |
| GHSA-5p4m-2wfm-xmqj, !!omap quadratique, high | >=4.0.0 <4.3.1 | 4.3.1 |
| GHSA-2883-xcg3-v3hh, sources merge vides, high | >=4.0.0 <4.3.2 | 4.3.2 |

**4.3.0 n'est donc pas entièrement corrigée.** 4.3.2 est le minimum compatible
hors des quatre plages actuelles ; registre npm versions/dist-tags (`v4-legacy`),
métadonnées exactes, [audit projeté](audit-projection.json) joints. Aucun passage v5.
Tarball SHA512/shasum conformes npm ; sources loader/omap conformes au tarball.
Signatures npm présentes, pas de champ attestation dans dist. Signatures/Sigstore
non vérifiés indépendamment ; gitHead n'est pas présenté comme attestation.

## Validation et limites

Vrai js-yaml résolu depuis le parent et physiquement chargé. YAML normal,
dump/load, merges/override usuels, !!omap normal et rejet de doublon, YAML invalide.
Chemin ESLint réel : fichier YAML synthétique temporaire créé puis supprimé,
Legacy.loadConfigFile → ConfigArrayFactory.loadFile/extractConfig, sans mock YAML.
Application utilisant eslint.config.js flat : ce test couvre volontairement la
compatibilité du chargeur legacy du parent ; aucune config YAML production ajoutée.
js-yaml reste une dépendance **dev**, pas un nouveau parseur du runtime serveur.

Fixtures déterministes bornées : aliases répétés (164 octets) et chaîne croissante
(330), refusées avec maxTotalMergeKeys=16 mais valides avec budget fini 128 ; sources
vides (214) comptées aussi ; séquence par défaut 101 sources (943) refusée au seuil
structurel 100. Pas de mesure de temps ni preuve asymptotique prétendue.
Baseline 4.1.1 : ignore ces budgets et accepte les fixtures, rouge capturé.
4.3.2 : refus explicites YAMLException attendus, vert. Sources utiles/fonctions/
lignes/hashes dans [source-excerpts.json](source-excerpts.json).

Premier contrôle candidat rouge : le grand cas était bien refusé, mais par
« abnormal merge sequence size » avant maxTotalMergeKeys. Attente corrigée sur le
refus exact du source, fixture réduite au seuil 100+1 ; assertions de refus et type
d'erreur conservées. Captures rouges `final-jsyaml`/`final-verify` conservées ;
contrôles définitifs préfixés `qualified` exécutés après le second commit technique.

npm ci --ignore-scripts --no-audit --no-fund : 0. Syntaxe harnais/server : 0.
Sous env-i/M0 : harnais ciblé 0, lint du nouveau harnais 0, isolation 0, verify 0.
**npm run lint global reste code 1**, exactement comme sur la base : **337 erreurs,
17 warnings**, stdout ET stderr identiques octet pour octet. Aucun finding masqué,
règle désactivée ou autre patch pour verdir ; [comparaison](lint-comparison.json).
Node v24.19.0 observé dans harnais baseline/final ; avertissements router conservés.
Gardes HTTP/sockets/TLS/secrets/data/providers conservées et exercées. Aucun appel
Firebase/SMTP/Mistral, secret/corpus/donnée personnel lu ni coût API.

[Reçu du code testé](tested-code-receipt.json) : code SHA/base/deux commits techniques,
Node, commandes/UTC/codes et comparaison capturée git-show ↔ checkout sur quatre
fichiers utiles (package/lock/garde inchangée/harnais). proof-check : 0.
Le commit suivant contient uniquement les preuves ; pas de manifeste massif repo/data.
Chaque capture .json conserve argv/début/fin/code/hashes stdout/stderr. Bruts d'audit
en scratch ; projection et hashes originaux dans Git. Audit **4→3**, cible absente,
brace-expansion high, fast-copy/protobufjs moderate strictement identiques.
Audit code 1 attendu pour JSON valide avec résiduels, **pas PASS global/CI**.

Branche/PR exclusivement beta NON FUSIONNÉE pour revue Work. Aucun déploiement,
main/prod/public, autre task/env/agent/setup/automation, Drive/mail/notification,
achat/reset. Restrictions natives et UNKNOWN conservés sans veto/PASS/attestation.
PR31–37 préservées ; G13/G21,D2/D3/externe OPEN. Rollback éventuel par nouvelle PR
beta de cette seule unité, sans force-push ni revert global.
