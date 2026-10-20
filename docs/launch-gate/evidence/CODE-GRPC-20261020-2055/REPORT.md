# CODE-GRPC-20261020-2055

Base fraîche/HEAD initial : `30e3e74fb7b47da6c4df72d19172e1ac4f99e6cc`,
remote exact `arnaudconnan-svg/acp-chat`, arbre propre. AGENTS/WORKFLOW/PROMPTING
relus sur la base avant édition. Branche isolée `code-grpc-20261020-2055` ; ancienne
branche form-data conservée, aucun reset/force-push.
Commit technique AVANT tests finaux : `dfc8ac925e4f5aa8c3f9e5ab25e608ff4d73b1d0`.

**Écart constaté : la beta exacte contient 1.14.3, pas 1.14.4.** Lock et version
physique après npm ci concordent. Correction minimale compatible : **1.14.3 → 1.14.5**,
seule entrée de dépendance modifiée dans le lock. Aucun parent/override ajouté.
package.json ajoute uniquement grpc:harness et son inclusion dans verify ; nouveau
harnais synthétique. Garde M0 inchangée, aucune exception nécessaire.

## Avis npm officiels actuels

| Advisory | Plage vulnérable | Première correction |
| --- | --- | --- |
| GHSA-5375-pq7m-f5r2, requête malformée/crash, high | >=1.14.0 <1.14.4 | 1.14.4 |
| GHSA-99f4-grh7-6pcq, compression malformée/crash, high | >=1.14.0 <1.14.4 | 1.14.4 |
| GHSA-m9gg-hp2v-232j, certificat non autorisé exposé, high | >=1.14.0 <1.14.5 | 1.14.5 |
| GHSA-f596-whhp-79r4, détails d'erreur divulgués, low | >=1.14.0 <1.14.5 | 1.14.5 |

npm publie 1.14.5, minimum hors des quatre plages, compatible avec google-gax
`^1.10.9`. [Audit projeté](audit-projection.json), métadonnées npm et intégrités joints.
Chaîne résolue physiquement : Admin 13.10.0 → Firestore optionnel 7.11.6 →
google-gax 4.6.1 → grpc-js 1.14.5 réellement chargé. Parents inchangés.
[Sources utiles](source-excerpts.json) : chargements Admin/Firestore/gax ; code
physique testé et SHA256 pour autorisation serveur/client, compression et dispatch.
Sources testées conformes au tarball npm téléchargé ; SHA512 et shasum vérifiés.
Signature npm présente, pas d'attestation dans dist ; signatures/Sigstore non
vérifiés indépendamment, aucune provenance déduite de gitHead.

## Validation et limites

Vrai paquet gRPC, Server exporté, BaseServerInterceptingCall exportée et StreamDecoder,
chargés normalement ; aucune classe privée extraite ou modifiée. Frontière I/O
synthétique en mémoire (HTTP2-shaped EventEmitter, objet TLS-shaped sans socket).
Aucun handshake ni vérification de chaîne de certificats réelle prétendu.

Baseline 1.14.3, quatre captures rouges séparées : auth expose le certificat malgré
`authorized=false` ; quatre types de handlers divulguent le marqueur synthétique ;
stream malformé laisse remonter l'erreur ; gzip corrompu provoque un événement error
non géré (processus code 1). Tous ces contrôles sont conservés et passent en 1.14.5.
Premiers rouges `baseline-security/errors` : attente 1.14.4 réfutée par la version
physique 1.14.3 ; correction de la baseline, pas retrait d'assertion sécurité.

Cas normaux : auth autorisée et plaintext, unary hello→world avec sérialisation
réelle, identity/gzip/deflate, décodage fragmenté. Cas bornés : dépassement 64 octets
avec expansion 128 octets, header de taille 65, gzip/deflate corrompus 3 octets.
Dispatch réel couvre unary/clientStream/serverStream/bidi ; UNKNOWN/« Unknown error »
est le statut gRPC attendu pour un handler qui lève, pas un échec du harnais.
Branche auth client inspectée en source seulement ; aucune simulation E2E Firebase.
Admin/Firestore/gax résolus par chemins et métadonnées sans initialisation provider.

npm ci --ignore-scripts --no-audit --no-fund : 0. Syntaxe JS modifié/server : 0.
Sous env-i/garde M0 : harnais gRPC 0, isolation 0, verify complet 0. Node v24.19.0
observé directement dans les harnais baseline/final. Avertissements router conservés.
Refus HTTP/sockets/TLS/secrets/data/providers conservés et exercés. Aucun appel
Firebase/SMTP/Mistral, secret/corpus/donnée lu, changement produit ou coût API.

[Reçu du code testé](tested-code-receipt.json) : SHA technique, base, Node,
commandes/UTC/codes, git-show ↔ checkout pour quatre fichiers utiles seulement
(package, lock, garde inchangée, harnais). Contrôle capturé proof-check : 0.
Le commit suivant contient uniquement les preuves ; pas de manifeste massif repo/data.
Captures .json : argv/début/fin/code/hashes stdout/stderr. Bruts d'audit en scratch,
projection utile et hashes des octets originaux dans Git. Audit 5→4 ; gRPC absent,
brace-expansion/js-yaml/fast-copy/protobufjs strictement identiques. Audit code 1
attendu sur JSON valide avec résiduels, **pas CI PASS**.

PR exclusivement beta NON FUSIONNÉE pour revue indépendante Work. Aucun déploiement,
main/prod/public, nouveau task/env/agent/setup/automation, mail/Drive/notification,
achat/reset. Restrictions natives conservées, UNKNOWN sans veto/PASS/attestation.
Acquis PR31–36 préservés ; G13/G21, D2/D3/externe OPEN. Rollback éventuel : nouvelle
PR beta annulant cette seule unité, jamais revert global ni force-push.
