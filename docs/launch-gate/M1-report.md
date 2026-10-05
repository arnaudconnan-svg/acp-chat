# Launch Gate M0 + M1 — rapport final de validation synthétique

5 octobre 2026. Les correctifs G02/G03 et le consentement publiés ont été acceptés
par Work. La vérification globale dans le clone indépendant est verte. La
livraison est proposée à la revue vers **beta**, sans fusion ni activation réelle.

## Références et état Git

- Base initiale et distante : `beta`,
  `f20d84f1962c552eaebb095d7a9e5ddb63719be7` ; inchangée au contrôle final.
- Branche distante existante : `work/m0-m1-launch-gate`, publications sans force.
- Dernier SHA de code/tests vérifié :
  `3db45bb8827ed14b9cd9399b61de8b8da8213dc1`.
- Arbre de ce SHA : `898ad8b3888ba38776ba333ef5f274bf20e1111b`.
- Clone indépendant : `/workspace/work/acp-clean-m0m1-031c063`, avancé uniquement
  par fast-forward au SHA ci-dessus. `git status --porcelain` vide avant et après
  les tests ; `git diff --check` code 0. Checkout de mission également propre
  avant l'ajout de ces preuves.
- Le commit de publication de ce rapport ajoute seulement des documents/preuves.
  Il ne modifie pas le code ni les tests du SHA vérifié. Les checkpoints « M1 en
  cours » restent des archives datées ; les validations restantes qu'ils
  annonçaient sont soldées par ce rapport.

## Commandes et résultats

Node `v24.19.0`, npm `11.9.0`. Depuis le clone indépendant :

```sh
npm ci --ignore-scripts --no-audit --no-fund
bash scripts/synthetic/verify.sh
git status --porcelain
git diff --check
```

Installation : **code 0**, 369 paquets. Elle précède le dernier fast-forward ;
`package.json` et `package-lock.json` sont identiques entre `031c063` et le SHA
vérifié. Vérification : **code 0**, huit harnesses M0/M1 puis tout `npm run verify`,
dont `node --check server.js`, cohérence des prompts et témoins de crise.
Aucun échec masqué. Les avertissements de dépréciation npm et de Promises
inter-realm du routeur Express dans la VM sont conservés dans les logs.

Le runner versionné assainit l'environnement, précharge le garde, refuse réseau
fournisseur/SDK réels et neutralise boot/listeners/intervalles avant chargement.
Le véritable pipeline Express utilise des flux mémoire ; RTDB, LLM et mail sont
simulés. Aucun secret ni `/workspace/acp-validation` n'est requis pour reproduire
les commandes. L'installation demande seulement le registre de dépendances.
L'exécution Cloud a levé la restriction de capture stdout des sous-processus Git
des tests historiques ; le garde hermétique versionné reste actif.

Preuves publiées : [installation](evidence/m1-clean-install.log),
[vérification du clone indépendant](evidence/m1-clean-verify.log),
[manifeste et SHA256](evidence/m1-final-manifest.json).
La preuve globale du checkout de mission [antérieur](evidence/m1-final-verify.log)
et les [preuves initiales](evidence/initial) sont conservées.

## Bilan par gate

Toutes les lignes « PASS » ci-dessous désignent des tests synthétiques au SHA
vérifié. Elles ne constituent pas une attestation des services déployés.

| Gate | Fichiers / commits principaux | Preuve exécutée et résultat | Limite et opération restante |
| --- | --- | --- | --- |
| M0 — isolation et opérateurs | `scripts/synthetic/{guard,runtime,verify}`, `lib/operator-target.js`, scripts reset/index ; `7c5263d`, `afe991f`, `f43b9b5` | `operator:harness`, `isolation:harness` **PASS** : cible/principal/périmètre obligatoires, simulation bornée, refus ; Express réel avec montages/ordre/erreurs, boot/timers/fournisseurs refusés avant chargement | Verrou total `--apply` **conservatoire** ; aucune opération réelle testée. Attestation service/base/principal/IAM par Work, puis mandat distinct pour toute opération. Carte [M0](M0.md). |
| G01 — secrets et sessions | `server.js`, `lib/professional-access.js` ; `91d6e4e`, `3cb24ac` | `professional:harness` **PASS** : aucun repli full/TWA large actif, sessions individuelles opaques, schéma strict, expiration absente/NaN/infinie refusée chaud/froid, redémarrage et révocation | Rotation des secrets antérieurement publiés et signatures, secrets dédiés distincts et provisioning individuel réels non exécutés. Serveur fermé sans configuration requise. |
| G19 / CJ4 — rôles, grants et audit | Module professionnel, routes et `public/js/{content-grants,professional-review}.js`, UI praticien ; `91d6e4e`, `3cb24ac`, `3c434b2`, `3db45bb` | `professional:harness`, `consent-ui:harness` **PASS** : affectation + grant, scope spécifique/période, synthèse explicite positive/refusée, révocation, cumul admin+praticien en rôle praticien, supports sans contenu ; journal admin à motif et unmask distinct. UI par titres/dates, portée/synthèse/échéance restaurées, instant persisté égal à l'affichage | Identités/affectations réelles à provisionner sous mandat, politique audit à attester. Lecture praticien minimale ; gardes copie/sélection/impression proportionnés, sans garantie contre toute capture. Aucun vrai grant modifié. |
| G02 — autorité objet et associations | `server.js`, module professionnel ; `3cb24ac`, `3c434b2` | `professional:harness`, `object-private:harness`, `associations:harness` **PASS** : témoins autorisés et refus avant effets, clé canonique, objets absents/étrangers/retirés ; requestId scoped, owner-cancel/progress, finalisation inverse ; branches/source/seed/destination contradictoires sans effet B, enfants étrangers/privés/non fiables exclus ; import nouveau explicite, collisions/orphelins/path/mixed batch refusés, overwrite légitime borné | Persistance en mémoire : aucune preuve d'IAM ou concurrence distribuée RTDB. Objets hérités ambigus conservés et refusés ; aucune réattribution. Cycle delete/reset/closure et refonte replay M2 non engagés. |
| G03 — séparation navigateur | `public/js/identity-storage.js`, `public/index.html`, autres pages et SW ; `91d6e4e`, `3cb24ac`, `3c434b2`, `3db45bb` | `browser-identity:harness`, `object-private:harness` **PASS** : namespaces A/B, logout, onglets, offline et héritage quarantiné ; sondes session retenues avant logout/login B, acteur initial inconnu ou A connu ; fetch résolu puis JSON/chunk tardif refusé ; stockage et retours applicatifs clôturés par génération | DOM/stockage/fetch simulés, pas de recette sur appareil réel. Données légitimes conservées, héritage inconnu non réattribué. Aucun cycle serveur M2 changé. |
| G04 / CJ2 — privé local et continuité | `server.js`, `public/index.html`, `public/js/conversation-data.js` ; `91d6e4e`, `3cb24ac`, `3c434b2` | `object-private:harness`, `associations:harness` **PASS** : privé multi-tour/rechargement/redémarrage avec memoryState complet IDs/dates, debug N-1, identifiant réutilisé par B isolé, aucun effet durable/cache privé serveur ; réponse normale et crise, tokens avant consolidation finale ; feedback volontaire borné et import privé→public explicite conservés | Transit fournisseur autorisé mais simulé. Consolidation privée attendue pour la réponse finale. Ancien nœud privé et sauvegardes non purgés ; inventaire/traitement après bascule sous mandat distinct. |
| G06 — minimisation des traces | `lib/{log-projection,logger}.js`, `server.js` ; `3cb24ac`, `031c063` | `log-projection:harness`, `object-private:harness`, `professional:harness` **PASS** : sorties du vrai mécanisme de projection avant pino/console/child bindings et serveur privé sans marqueurs factices de secret/transcript/mémoire/debug ; identifiant adversarial absent du journal admin ; diagnostic client sensible désactivé | Aucun dump de logs réels. Historique, rétention et destinations déployées non attestés ; inventaire et politique d'exploitation à traiter séparément. |
| G12 — destinations locales | `public/js/local-destination.js`, auth/pro/TWA, routes serveur ; `91d6e4e`, `3cb24ac`, `3c434b2` | `browser-identity:harness` et témoins auth historiques **PASS** : parcours locaux autorisés ; URLs externes, //, backslashes, encodages, fragments et traversées normalisées refusés, repli local sûr | Validation déterministe client/serveur, aucun parcours authentifié réel utilisé. |

## Statut opérationnel et suite Work

**Implémenté et testé synthétiquement : M0 puis M1. Déployé : non. Purgé : non.**
La PR cible beta pour revue et ne doit pas être fusionnée automatiquement.
Aucun service réel, compte, rôle/grant, configuration, déploiement ou donnée réel
n'a été modifié ; aucun appel réel Firebase/Mistral/SMTP ni listener applicatif.
Aucun M2 ni promotion main/production.

L'attestation Render reste bloquée par une connexion et est traitée par Work.
Les métadonnées du brief restent distinguées des configuration/principal/base/IAM
effectivement consommés, toujours non attestés ici. Avant livraison/activation,
Work doit vérifier ces attestations, rotation/provisioning et migration des
capacités anciennes décrits dans le [runbook M1](M1-runbook.md). Les résidus privés
et logs historiques restent présents jusqu'à un traitement opérationnel autorisé.
