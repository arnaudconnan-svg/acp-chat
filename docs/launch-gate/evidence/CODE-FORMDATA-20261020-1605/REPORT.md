# CODE-FORMDATA-20261020-1605

Base fraîche et HEAD initial exact : `d8434f1f524f691549ace6367471687b1b096aea`.
Dépôt `arnaudconnan-svg/acp-chat`, arbre propre, consignes AGENTS/WORKFLOW/PROMPTING
relues sur la base. Branche isolée `code-formdata-20261020-1605` ; ancienne branche
Busboy conservée, aucun reset. Commit technique **avant validations finales** :
`285b66719cf1a872a4ad1b175e7b2ec640456e56`.

Correction : seule dépendance modifiée au lock, form-data **2.5.5 → 2.5.6**.
Avis npm actuel [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx),
CRLF via noms/champs/fichiers, high, plage officielle `<2.5.6` ; première version
corrigée 2.5.6, publiée et compatible `^2.5.5`. Aucun override ni changement parent.
`package.json` ajoute le harnais et son inclusion dans verify ; nouveau harnais
synthétique réel. Garde M0 inchangée, aucune exception nécessaire.

Chaîne physique vérifiée : Admin 13.10.0 → storage 7.19.0 (optionnelle) →
retry-request 7.0.2 → @types/request 2.48.13 → form-data 2.5.6.
Les quatre parents ont des métadonnées physiques identiques avant/après.
@types/request importe FormData dans `index.d.ts:10` : chaîne de dépendances de
types installée, **pas preuve d'un usage runtime form-data par Admin**.
Admin/Storage non chargés ni initialisés ; retry-request réellement chargé comme
fonction sans transport invoqué. Sérialisation directe du vrai form-data, non mocké.

[Sources exactes et diff npm](source-excerpts.json) : escapeHeaderParam,
_multiPartHeader, _getContentDisposition ; fichiers/lignes/SHA256. Encodage des
quotes/CR/LF en `%22`/`%0D`/`%0A`. Fixture bornée (<512 octets) pour champ et filename :
en 2.5.5 en-tête injecté observé dans les deux cas, assertion sécurité rouge code 1 ;
en 2.5.6 aucun en-tête injecté, paramètres encodés, code 0. Assertions conservées.
Cas normaux champ/fichier, type multipart, délimiteur final et longueur exacte : 0.
Premier rouge `baseline` : localisateur de métadonnées rencontrant package.json
intermédiaire sans version dans Storage ; corrigé en cherchant le paquet nommé,
sans retirer d'assertion. Rouge CRLF réel dans `baseline-crlf.*` conservé.

npm ci neuf `--ignore-scripts --no-audit --no-fund` : 0. Syntaxe JS modifié/server : 0.
Sous env-i et garde M0 : formdata:harness 0, isolation:harness 0, npm run verify 0.
Node v24.19.0 observé avant tests et directement dans le harnais baseline/final.
Avertissements router conservés dans stderr ; aucun statut CI distant inventé.
Aucun appel Firebase/SMTP/Mistral, secret/corpus ou données lus. Gardes HTTP/socket/
TLS/providers/secrets/data exercées et conservées. Acquis PR31–35 préservés ; toutes
les autres entrées du lock identiques, dont Busboy 3.2.3 et les chaînes protégées.

[Reçu du code testé](tested-code-receipt.json) : SHA technique, base, Node,
commandes UTC/codes et comparaison capturée git-show ↔ checkout sur **quatre fichiers
utiles seulement** (package, lock, garde inchangée, harnais). Contrôle `proof-check` : 0.
Le commit de preuves suivant ne change aucun fichier technique. Aucun manifeste
massif du dépôt/data. Chaque capture .json conserve argv/UTC/code/hashes des flux.

[Audit projeté](audit-projection.json) : 6 → 5, cible absente après ; cinq résiduels
distincts strictement identiques (@grpc/grpc-js, brace-expansion, fast-copy, js-yaml,
protobufjs). Codes 1 attendus pour JSON valides avec résiduels ; pas de faux CI PASS.
Bruts d'audit en scratch uniquement ; hashes originaux et projection utile dans Git.
Tarball SHA512/shasum conformes npm, source physique conforme au tarball.
Métadonnées npm gitHead/signature conservées ; pas d'attestation publiée dans dist,
aucune vérification indépendante de signature/Sigstore ni provenance déduite du gitHead.

PR exclusivement beta NON FUSIONNÉE pour revue Work, aucun déploiement/main/prod/public.
Aucun nouvel environnement/agent/setup/automation, achat ou coût API. Restrictions
natives maintenues ; aucune conclusion PASS ni attestation réseau UNKNOWN.
G13/G21, D2/D3 et externe OPEN. Rollback : nouvelle PR beta annulant seulement cette
unité, sans force-push ni revert global PR31–35.
