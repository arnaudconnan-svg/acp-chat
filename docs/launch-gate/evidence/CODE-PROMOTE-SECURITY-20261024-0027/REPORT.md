# CODE-PROMOTE-SECURITY-20261024-0027

**Aucune promotion, aucun push main, aucun déploiement.** La beta existante n'est pas qualifiée : l'audit actuel ajoute deux HIGH depuis les preuves PR31–40. Une correction nécessaire est proposée en PR beta non fusionnée.

- Beta initiale fraîche / HEAD initial : `c6650835eec849655c9e92754a446a14c5928927`.
- Main fraîche / SHA de retour : `11a41e9ea6765418737ad7f8e2b8a31fe404b9b1`.
- Code corrigé testé : `7dd3ce6f003a0cbe441fa68e367ce458abe9fedc`.
- Branche : `fix/promote-security-20261024-0027`. Le dernier commit ajoute seulement ces preuves.
- Remote exact `https://github.com/arnaudconnan-svg/acp-chat.git`, checkout initial propre, AGENTS/WORKFLOW/PROMPTING actifs relus avant édition. PR31–40 conservées.

## Delta et ascendance

Main est ancêtre de beta : divergence **0 main-only / 38 beta-only**, fast-forward possible (`ancestry`, `preff-check`). Les 915 fichiers du delta incluent massivement les preuves déjà acquises ; le delta hors docs/data contient 34 fichiers (`delta-code.stdout`). Il couvre GOV-001, ressources/crise PR31, dépendances PR32–38/40 et UX admin PR39. Aucune réouverture des audits clos. Les changements de données versionnées sont seulement signalés par nom/stat, sans lecture du contenu.

`preff:git:guard` est un contrôle Git préalable réussi, **pas une autorisation de promouvoir**. Avant toute future promotion : fetch frais, candidate exacte intégrée/testée/déployée, preuve graphique Work Chat sur ce SHA, restauration revue, protections et autorisation conditionnelle satisfaites. Promotion en fast-forward exclusivement ; immédiatement après succès, exécuter obligatoirement `npm run preff:git:sync-beta-after-promotion`, puis vérifier l'égalité complète des SHA main/beta. Aucun merge/rebase/reset/force-push de contournement. La beta actuelle reste l'ancienne candidate et ne doit pas être promue.

## Audits actuels, pas les anciens compteurs

| SHA / portée | Packages vulnérables | Critique/HIGH/modéré | Avis uniques |
|---|---:|---|---:|
| Main 11a41e9, tout | 13 | 2 / 8 / 3 | 41 |
| Main 11a41e9, omit=dev | 10 | 2 / 6 / 2 | 30 |
| Beta c665083, tout | 4 | 0 / 2 / 2 | 5 |
| Beta c665083, omit=dev | 3 | 0 / 2 / 1 | 4 |
| Code corrigé, tout | 2 | 0 / 0 / 2 | 3 |
| Code corrigé, omit=dev | 1 | 0 / 0 / 1 | 2 |

Les compteurs npm désignent des **packages**, y compris les effets propagés ; les avis uniques sont dédupliqués par URL GHSA. Répartition par sévérité des avis uniques et versions physiques : `audit-summary.json`. Les stdout/stderr volumineux secondaires sont parfois conservés sans perte en `.gz` ; leur SHA décompressé reste celui de la capture `.json`. Les sorties finales utiles restent en clair. Les six JSON audit sont valides ; leurs codes **1** sont conservés, aucun PASS audit/CI global prétendu.

## Corrections nécessaires et minimales

1. **GHSA-27r3-jxmh-p828**, `>=2.0.0 <2.4.0` : body-parser **2.3.0 → 2.4.0**, via Express **5.2.1 inchangé**, plage parent `^2.2.1`. Atteignable avant les routes/auth : `server.js:1021 app.use(express.json())`, inflation activée par défaut. `iconv-lite 0.7.2 → 0.7.3` est imposé par la nouvelle plage du paquet ; `content-type` imbriqué était déjà 2.1.0. Aucun autre parent changé.
2. **GHSA-mrhx-c7xc-m3w5**, `<4.6.6` : Zod **3.25.76 → 4.6.6**. La liste npm officielle confirme que 3.25.76 est la dernière version3 ; aucune résolution lock-only 3.x ne peut sortir de cette plage. Upgrade majeur nécessaire et explicite du seul parent direct Zod (`^4.6.6`, sans override). Deux `z.record` passent à la signature clé/valeur v4 ; `validateShape` demande `abortEarly` pour les erreurs structurelles fatales. Aucun nouveau plafond applicatif ni changement de politique conversationnelle.

Quatre fichiers techniques : package.json, package-lock.json, lib/runtime-schemas.js, nouveau promotion-security-harness.cjs. Le lock change uniquement sa déclaration racine Zod et trois paquets (body-parser/iconv-lite/zod). Tous les autres objets du lock, serveur, configuration, garde M0 et front admin sont inchangés par rapport à beta.

## Validation effective Node22

**v22.23.4** à `/workspace/work/promote/node/package/bin/node`, exécuté réellement, pas Node24. Binaire obtenu par tarball `node-linux-x64@22.23.4` du registre npm autorisé ; SHA512 vérifié. Aucune installation globale, configuration projet ou variable Render modifiée. Intégrités et égalité sources physiques/tarballs body-parser/Zod vérifiées ; signatures/Sigstore non vérifiés indépendamment.

- Baseline beta : `baseline-verify` et `baseline-admin` code0 sous Node22/M0.
- `npm ci --ignore-scripts` baseline et correction : code0 ; aucun script d'installation exécuté.
- Code corrigé exact : `exact-verify` et `exact-lint` code0. `verify` inclut syntaxe server.js, dépendances PR32–40, crise/ressources PR31, routage, schémas, contrats et tests synthétiques existants.
- Admin, professionnels/grants/révocation et isolation : code0 (`qualified-*`). Leurs sources applicatives sont inchangées par le dernier ajout de test.
- **Zod rouge→vert** : tableau contraint max4 de 64 éléments invalides, 65 erreurs/64 éléments parcourus sur3.25.76 → une erreur/**zéro** élément parcouru sur4.6.6. Tableau structurel invalide : 64 erreurs → une ; cas normaux, records non vides et config production synthétique acceptés. Les erreurs sémantiques continuables peuvent toujours être collectées (64 rôles vides →64 diagnostics), comportement documenté sans prétendre à un arrêt universel. Express conserve sa limite JSON par défaut100KiB.
- **body-parser rouge→vert** : décompresseur gzip réel après lecture, zéro écouteur erreur/destroyed=false → écouteur présent/destroyed=true. Gzip, deflate et Brotli normaux passent ; injection explicite d'une erreur tardive sur le vrai décodeur traitée sans second callback. C'est une preuve de cycle de vie, **pas la reproduction d'un exploit sur un socket HTTP** ; les essais bornés de bytes ajoutés sont conservés et n'ont pas reproduit le crash.
- SDK Mistral réel : schémas requête/réponse compatibles avec Zod4, HTTP entièrement doublé, une requête locale synthétique et **zéro appel fournisseur/coût LLM** (`real-sdk-compatibility`). Pas de secret réel.
- Chromium desktop/mobile : parcours PR39 rendus avec vrai front, API locale doublée et toutes les origines externes refusées. Code0 `qualified-admin-browser`, deux rendus synthétiques joints. Premier lancement rouge EPERM setsockopt conservé ; permission native de lancement ensuite accordée. Le pilote browser nécessite le spawn hors preload M0, sans modifier la garde ; les tests applicatifs Node restent sous env-i/M0. Ce contrôle hermétique ne remplace pas Chat beta graphique Work.
- Un rouge lint `__dirname` du nouveau harnais est conservé puis corrigé, sans suppression d'assertion. Le lint global hérité n'est pas repris. Dépréciations npm/router conservées.

## Portée des modérés résiduels

`fast-copy4.0.3` : dev-only par pino-pretty13.1.3, absent de l'audit omit=dev. Le filtre réel est testé. `lib/logger.js:61` ne crée le transport pretty que si logPretty ; `lib/config.js:81` le désactive par défaut en production. Cela ne prouve pas les variables du service déployé, non consultées.

`protobufjs7.6.1` : prod/optionnel via Admin13.10.0 → Firestore7.11.6 → google-gax4.6.1 (et proto-loader). Le paquet réel réalise un parse/encode/decode synthétique borné. Les chemins concernés par les deux avis prennent des schémas/noms ; aucun chemin fourni par un utilisateur vers un `.proto` arbitraire n'a été trouvé dans le code applicatif ciblé, qui utilise Admin RTDB. Les schémas du SDK sont des assets installés. **Pas de preuve d'inatteignabilité universelle ni d'absence de risque du SDK**. Les deux objets audit résiduels sont intégralement identiques avant/après et ne sont pas corrigés artificiellement.

## Restauration et limites de promotion

Un checkout détaché isolé du même environnement est lié à main11a41e9 ; seuls les fichiers de code nécessaires sont matérialisés, aucun corpus/data/docs ni secret copié. Installation main `ci --ignore-scripts` code0 ; métadonnées physiques vulnérables comparées au lock exact.

`restoration-check` remplace temporairement six artifacts ciblés par ceux de la candidate technique64efa30 puis rétablit leurs octets exacts de main11a41e9 ; hashes vérifiés, HEAD main conservé. Le dernier commit7dd3ce6 ne modifie ensuite que le harnais nouveau, pas ces artifacts. Syntaxe et schémas restaurés code0. `restoration-final-verify` revalide le checkout restauré sous Node22/M0. Le premier `restore-verify` rouge sur capture du vieux harnais pré-FF est conservé ; la permission native permet ses captures sans changer le code main ni ses assertions.

**Procédure de retour après une future promotion** : sélectionner/redéployer le commit de retour complet `11a41e9ea6765418737ad7f8e2b8a31fe404b9b1` sur le service existant, conserver **NODE_VERSION=22.23.4**, groupes/valeurs de secrets, stockage et configuration existants ; aucun script de migration/purge. Contrôler SHA réellement exécuté, démarrage, santé et parcours synthétique isolé. Ne pas réécrire l'historique Git. Un retour applicatif n'abaisse pas main par force ; toute correction Git suit une nouvelle PR autorisée.

**Ce qui n'est pas prouvé** : rollback Render exécuté, image historique encore déployable, configuration NODE_VERSION/secrets actuellement sur Render, secrets réellement présents, auth déployée, santé ou Chat déployés. Aucun accès Render ni changement de configuration. La restauration locale est vérifiée, la restauration opérationnelle reste à qualifier/revoir Work. Retour main réintroduirait aussi les vulnérabilités mesurées ci-dessus : il s'agit d'un point de retour de continuité, pas d'une cible sécurité saine.

## Raccord Work Chat et suite

Chemin connu : `https://beta.facilitat.io/index.html`, transport `/chat` ou `/chat/stream` sous `requireUserAuth` (server.js:11018). Les consignes/code consultés n'identifient aucun compte de recette **déployé et autorisé** ; `synthetic_admin`/example.test sont uniquement des fixtures. Ne pas utiliser une identité personnelle, un grant ou une mémoire réels. Préconditions : compte technique dédié explicitement automatisé, droits minimaux, consentement/conversation isolée, IDs de recette traçables, aucune mémoire/corpus personnel. L'absence de compte admin technique laisse une limite authadmin, pas un faux E2E.

Aucun budget fournisseur disponible ni suivi de coût de session réel n'a été vérifié ; aucun montant ne peut être déduit du quota Codex ou de la capacité produit. Work doit établir un nombre d'appels/plafond/suivi dans les coûts existants avant le Chat graphique. Cette mission : zéro appel payant.

Après revue de la PR corrective : intégration beta et déploiement, puis **preuve graphique Work sur cette nouvelle beta exacte** et revue tests/restauration. Une preuve sur c665083 ne suffit pas pour la candidate corrigée. Promotion toujours en attente. G13/G21, D2/D3 et externe restent OPEN ; réseau UNKNOWN, sans attestation PASS. STOP terminal8/8 pour revue/rotation native Work si reprise nécessaire, sans renouveler l'échéance absolue23:27:23UTC du23octobre.
