# CODE-BUSBOY-20261020-1526

Base initiale de la branche isolée `code-busboy-20261020-1526` :
`ae54db75761b90bc58786672c84f272798d93e33`, beta fraîche, dépôt exact
`arnaudconnan-svg/acp-chat`. Checkout restauré initialement propre sur `work`
`11a41e9ea6765418737ad7f8e2b8a31fe404b9b1` : conservé, aucun reset.
AGENTS.md, WORKFLOW.md, PROMPTING.md relus sur la base avant édition.

Correction exécutable : seule entrée de dépendance modifiée dans le lock,
Busboy 3.2.0 → 3.2.3, sans override ajouté ni changement parent. Admin reste
13.10.0 et sa plage officielle `^3.0.0` est respectée. Les autres entrées de lock
sont identiques, notamment les chaînes protégées des PR32–34.
`package.json` ajoute uniquement le harnais et son inclusion dans verify.
M0 autorise uniquement ce fichier de harnais exact à charger l'entrée publique
Admin ; les refus réseau, credentials, données et providers restent actifs.

## Avis npm actuels

Source : audit npm réellement exécuté le 20 octobre 2026, projection jointe.

| Advisory | Plage vulnérable officielle | Première version hors plage |
| --- | --- | --- |
| GHSA-xjh9-v7x6-24jw (boundary DoS, high) | >=3.1.0 <3.2.1 | 3.2.1 |
| GHSA-x8mw-p69m-v3mx (prototype header DoS, high) | >=1.0.0 <3.2.1 | 3.2.1 |
| GHSA-gxm5-99cw-xjw9 (CRLF, moderate) | <3.2.2 | 3.2.2 |

3.2.2 corrige les avis mais échoue au scénario synthétique borné en morceaux
après délimiteur final : ERR_STREAM_WRITE_AFTER_END. 3.2.3, publiée officiellement
et compatible, corrige exactement ce défaut (garde parser.writable dans
Multipart.write). `chunk-regression.cjs` identique : code 1 sur le paquet 3.2.2,
code 0 sur 3.2.3 physiquement installé. Les rouges initiaux sont conservés :
le premier corrige l'attente du `part.end` dans le harnais ; le suivant révèle
le défaut réel 3.2.2. Le succès temporaire en un seul bloc n'est pas la validation
finale : le harnais livré conserve les morceaux de sept octets.

## Validation et limites

`npm ci --ignore-scripts --no-audit --no-fund` : 0. Installation physique neuve.
Syntaxe server et fichiers JS modifiés : 0. Sous `env -i` et garde préchargée :
harnais Busboy 0, isolation 0, verify complet 0. Avertissements de dépréciation
router conservés dans stderr ; aucun faux statut CI déduit des tests locaux.

Chargement réel Admin sans initialiser d'app ni découvrir de credentials.
Résolution depuis son entrée réelle vers Busboy 3.2.3. Source exacte Admin :
`lib/utils/api-request.js:401`, `AsyncRequestCall.handleMultipartResponse`,
`require('@fastify/busboy')` puis `new busboy.Dicer({ boundary })`.
Classe privée non exportée : pas d'extraction VM ni simulation E2E Firebase.
Source et hashes vérifiés ; vrai Dicer public testé sur multipart normal,
headers prototype, frontière excessive ; API Busboy réelle testée sur champ
normal et CR/LF dans nom/filename, en morceaux avec trailer. Aucun Busboy mocké.
Aucun appel Firebase, SMTP ou Mistral réel.

Audit avant/après : 7 → 6 paquets signalés, Busboy absent après ; six résiduels
strictement identiques. Codes audit 1 attendus (JSON valides), pas « CI PASS ».
Les JSON d'audit bruts et l'enveloppe de provenance brute restent en scratch ;
projections utiles et hashes des octets originaux conservés ici.
Tarball SHA512 conforme au dist.integrity npm et au sujet de provenance récupéré.
Signatures npm/Sigstore non vérifiées indépendamment ; aucune attestation inventée.

Chaque capture .json donne argv, UTC début/fin, code, hashes stdout/stderr.
Manifestes SHA256 : sources effectivement testées et paquets physiques Admin/Busboy.
Réseau natif restreint conservé, statut UNKNOWN sans veto ; autorisation ponctuelle
réseau utilisée après échecs initiaux de sandbox/proxy. Aucun bypass ni autre hôte.

Livraison uniquement PR vers beta, NON fusionnée pour revue Work. Aucun déploiement,
main/prod/public, achat, reset ou automation. G13/G21, D2/D3 et externe restent OPEN.
Rollback : nouvelle branche depuis beta, revert de cette seule unité, nouvelle PR
vers beta ; aucun force-push ni revert global des PR31–34.

Complément de revue Work : [reçu ciblé du code testé](tested-code-receipt.json)
lié explicitement à `cf1ff948b00c00bd633f14c3bde149e6fc7cd31c` : quatre
fichiers techniques du commit = hashes du manifeste testé = checkout, contrôle
code 0 capturé dans `receipt-check.*`. Node v24.19.0 observé avant tests et
résolu de nouveau avec leur PATH exact ; pas de capture version contemporaine
par commande prétendue. Commandes finales, codes et UTC repris des captures.
[Extraits physiques](source-excerpts.json) : Admin lignes 401–419 et diff npm
Busboy 3.2.2 → 3.2.3, fonctions/lignes/SHA256 explicites. Aucun code technique
modifié, aucun verify rejoué, aucune donnée ni aucun corpus lu.
