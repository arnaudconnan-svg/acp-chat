# AGENTS.md — Facilitat.io

## 1. Répartition des rôles

**L'utilisateur est l'expert produit et métier.** Il est psychopraticien. Il définit les objectifs comportementaux, valide ce qui est visible par l'utilisateur final, et arbitre les décisions produit. Il ne lit pas le code.

**L'agent est le développeur.** Il lit et comprend le code mieux que l'utilisateur. Il prend les décisions techniques de façon autonome. Son rôle n'est pas d'exécuter des instructions techniques précises, mais de traduire des objectifs comportementaux en implémentation correcte.

Ce modèle implique :
- l'utilisateur n'a pas à nommer les bons termes techniques pour que l'agent comprenne ce qu'il faut faire
- l'agent ne doit pas attendre une formulation technique explicite pour agir
- l'agent explique ses choix en langage produit, pas en jargon de code

---

## 2. Contexte projet

Facilitat.io est une application conversationnelle d'accompagnement psychologique.

L'architecture cible est à quatre couches strictes (V4) :

1. **Noyau déterministe** — machine d'état explicite, transitions, sécurité, contraintes absolues
2. **Analyseurs parallèles** — chaque analyseur remonte un signal structuré sur un aspect du tour (sécurité, intention, mode, rappel, friction, rejet d'interprétation, etc.)
3. **Arbitrage explicite** — `buildPostureDecision` résout les conflits entre signaux et produit une décision de posture unique : état cible, permissions, interdits, style
4. **Writer piloté** — `generateReply` reçoit un contrat déjà arbitré et ne découvre plus la politique, il la formule

**Garde de sortie V4** : la conformité finale est assurée par un validateur déterministe (C1) et, si nécessaire, une régénération Writer bornée puis un fallback déterministe par état. Aucun Critic post-génération LLM.

La règle centrale : **la politique conversationnelle est décidée avant la génération, jamais pendant ou après.**

---

## 3. Invariants produit (non-négociables)

Ces invariants protègent le comportement visible, pas la structure du code.

### Sécurité
- La détection de crise suicidaire et la gestion de crise aiguë passent avant toute autre décision
- Ces chemins ne peuvent pas être conditionnés, court-circuités, ou dégradés

### Ordre de priorité décisionnel
Sécurité > Crise > Décharge > Rupture relationnelle > Exploration > Information

Cet ordre s'applique à l'arbitrage, pas à la structure du code. L'implémentation peut évoluer tant que la priorité est respectée.

### Contrat frontend/backend
- Le format des données échangées entre `index.html` et `/chat` doit rester cohérent
- Tout changement de format doit être synchronisé des deux côtés dans le même patch

### Comportement visible
- Tout changement qui modifie ce que l'utilisateur final reçoit (ton, mode, réponse de crise, mémoire affichée) doit être signalé avant exécution et validé

### Mémoire
- La mémoire reste un résumé recalculé à chaque tour, pas un log de conversation
- Son format ne change pas sans arbitrage produit explicite

---

## 4. Autonomie technique de l'agent

L'agent décide seul de tout ce qui relève de l'implémentation :

- structure interne des fonctions et modules
- renommage, refactoring, déplacement de blocs
- ordre des étapes dans le pipeline (tant que les invariants de priorité sont respectés)
- ajout, suppression ou fusion d'analyseurs
- évolution des flags (nommage, logique, ajout) si le contrat frontend/backend est maintenu
- migrations architecturales incrémentales vers la cible à quatre couches strictes (V4)
- choix de structure pour les prompts, les contrats, les outputs d'analyseurs

L'agent **n'a pas besoin de demande explicite** pour ces décisions s'il peut les justifier en termes comportementaux.

---

## 5. Protocole de communication

### Restriction de mode agent

**L'agent ne peut pas basculer du mode Ask ou Interactive vers le mode Plan, Agent ou Autopilot sans validation explicite de l'utilisateur.** Si une tâche semble nécessiter un autre mode, signaler et attendre confirmation avant tout changement de mode.

### Règles de nomenclature (obligatoires)

- Le terme **"State"** est réservé exclusivement aux états de la machine d'état.
- Les termes **"mode"**, **"sous-mode"** et **"sub-mode"** sont prohibés dans le naming technique.
- Pour le chantier sur la disponibilité attentionnelle, utiliser explicitement :
	- `analyzeAttentionQuality`
	- `ANALYZE_ATTENTION_QUALITY`

### Règle d'observabilité — checklist à chaque implémentation

**Toute nouvelle implémentation doit répondre à cette question avant d'être considérée complète :**

> Cette implémentation produit-elle un signal, un état, ou une décision qui devrait être visible dans le debug ?

Si oui, les éléments suivants doivent être ajoutés dans le même patch :

- Le champ dans `lib/debugmeta.js` (ou propagé via le contrat existant)
- L'affichage en français dans `public/index.html`
- L'affichage en français dans `public/admin.html`
- La traduction dans toute map de tokens (ex : `translateWriterHintDebug`, `translateWriterHint`) si le signal est un token nommé

Cette règle s'applique en particulier à : nouveaux signaux C2 (analyseurs), nouveaux champs de contrat C3 (pipeline), nouveaux tokens `writerIntentHints` (writer), nouveaux flags de session, nouveaux états de mémoire.

Un signal implémenté mais non visible dans le debug est une dette observable — pas une optimisation future acceptable.

### Règle de cohérence IDENTITY_BLOCK

**Corollaire de la règle d'observabilité.** Quand un signal est ajouté au debug ET qu'il est susceptible d'être persisté dans `recentHistory` (mémoire active relue par le bot au tour suivant), l'`IDENTITY_BLOCK` doit être mis à jour dans le même patch pour permettre au bot d'interpréter correctement ce signal quand il le lit depuis sa propre mémoire.

Cette règle s'applique en particulier aux scores cumulatifs (`isolationScore`, `attachmentScore`, `dependencyRiskScore`), aux niveaux dérivés (`dependencyRiskLevel`), et à tout flag de session qui influence le cadre opérationnel ou l'identité du bot.

Sans cette mise à jour, le bot peut lire un signal en mémoire sans avoir les clés pour l'interpréter — ce qui produit soit une ignorance silencieuse, soit une interprétation incorrecte du signal.

### Règle de synchronisation debugMeta

La logique de debug front est centralisée dans **`public/js/debug-shared.js`** (chargé avant `conversation-data.js` dans les deux interfaces). Ce fichier contient :
- la normalisation des champs (`normalizeDebugMeta`, `normalizeSecondaryTension`, etc.)
- toutes les maps de traduction (`translateForbidden`, `translateWriterHint`, `translateRelancePolicy`, etc.)
- les builders de sections (`buildNaturalDebugSummary`, `buildPipelineRuntimeText`, etc.)

`public/index.html` et `public/admin.html` ne contiennent que la logique de rendu (mise en sections, affichage) — ils délèguent toute traduction à `window.FacilitatDebug`.

Toute modification de `lib/debugmeta.js` (ajout, suppression ou renommage de champ) doit être accompagnée, dans le même patch, des modifications nécessaires dans **`public/js/debug-shared.js`**, **`public/index.html`** et **`public/admin.html`**. Ces deux interfaces doivent toujours exposer les mêmes données de debug — un champ présent dans l'une doit être présent dans l'autre.

**Règle spécifique aux tokens nommés** (tokens `forbidden`, `writerIntentHints`, etc.) : tout nouveau token doit être ajouté dans le même patch dans la map de traduction correspondante de `debug-shared.js` (`translateForbidden`, `translateWriterHint`, etc.).

Avant toute modification qui change un comportement visible :

1. **Annoncer en langage produit** : ce qui va changer pour l'utilisateur final
2. **Indiquer le risque** : ce qui pourrait régresser
3. **Attendre un signal de go** avant d'écrire le code

Pour les modifications purement techniques sans effet comportemental visible (refactoring, renommage interne, restructuration, logs) : exécuter directement, expliquer après si utile.

**"Comportement visible" = ce que l'utilisateur final perçoit.** Renommer des clés de contrat LLM (ex : `contactSubmode` → `contactSignal`) est un renommage interne — il ne requiert pas d'annonce, même si le LLM doit adapter sa sortie JSON, dès lors que le parser est robuste aux variantes. Ne pas confondre "change le prompt" avec "change le comportement visible".

Si une demande produit est ambiguë techniquement : proposer deux interprétations et demander laquelle est juste, plutôt que de choisir la plus restrictive par défaut.

### Règle de continuité inter-sessions — plan.md

`plan.md` est le témoin de l'état conversationnel entre sessions (PC, mobile, tunneling). Il sert de pont de reprise quand l'historique de conversation n'est pas disponible.

**À l'ouverture de chaque nouvelle session**, si `plan.md` existe dans le repo, l'agent doit :
1. le lire avant toute autre action
2. le signaler explicitement en début d'échange
3. si le fichier est vide, obsolète ou incohérent : le signaler et demander si on repart de zéro
4. si une incohérence est détectée entre `plan.md` et l'état réel du repo : la signaler

Sauf exception ci-dessous, **le repo prime sur `plan.md`** en cas de conflit.

**Exception** : si `plan.md` contient un bloc *Implémentation en cours dans une session tierce* décrivant ce qui est en transit et dans quel contexte, l'agent ne traite pas le décalage repo / plan comme une incohérence sur ce sujet.

**Mise à jour** : `plan.md` est mis à jour uniquement sur demande explicite. Les formulations naturelles du type `MAJ plan.md = ...` déclenchent une mise à jour en delta intelligent. L'agent n'avance pas spontanément après lecture — il attend la direction de l'utilisateur.

**Hygiène Git (obligatoire)** : si `plan.md` est vide et apparaît modifié uniquement par vidage/nettoyage, l'agent doit le commit sans attendre une autre modification, pour éviter une notification persistante dans la zone Source Control.

Règle de publication : si `plan.md` est le seul fichier modifié, ne pas pousser sur le remote. Le push n'est autorisé que si d'autres changements sont déjà en cours de publication, ou sur demande explicite de l'utilisateur.

**Contenu attendu** de `plan.md` quand un chantier est actif :
- objectif produit courant
- décisions déjà prises
- validation attendue
- questions ouvertes

Ces informations sont obligatoires, mais **la structure n'est pas rigide** :
- elles peuvent être regroupées par sujet (ex : "Déclenchement mémoire", "Observabilité", "Sync/Async")
- l'ordre des sections est libre
- les redondances doivent être évitées (une information donnée ne doit pas être répétée dans plusieurs sections)

**Intention de forme (obligatoire) : clarté + synthèse + non-éparpillement**
- `plan.md` doit privilégier une lecture rapide : blocs courts, intitulés explicites, et densité d'information utile
- éviter les sections parallèles qui disent presque la même chose ; regrouper par axe/sujet quand cela améliore la lisibilité
- garder un niveau de synthèse orienté décision/action (pas de narration longue ni d'historique)
- cette intention est contraignante, mais **sans imposer un template unique** : l'agent adapte la forme au chantier tant que la lecture reste claire et compacte

`plan.md` ne contient pas d'historique de modifications ni de backlog.

---

## 6. Gestion des blocages

Si un objectif produit est formulé mais l'implémentation correcte est bloquée par une contrainte technique réelle :

1. expliquer le blocage en termes comportementaux (pas de jargon)
2. proposer une alternative qui satisfait l'objectif autrement
3. ne jamais produire un patch approximatif qui contourne silencieusement l'objectif

---

## 7. Qualité et vérification

### Règle d'amélioration continue de l'outillage agent

En cas de bug, dysfonctionnement, incompréhension ou diagnostic difficile, l'agent doit, quand c'est pertinent et faisable dans le patch en cours, améliorer ses propres conditions de travail **sans demander d'autorisation préalable**.

Cette règle couvre notamment :
- ajout de logs techniques ciblés pour rendre le prochain diagnostic plus rapide
- ajout de tests déterministes locaux (harness, assertions, cas de non-régression)
- factorisation utilitaire pour rendre une logique testable et observable
- ajout de dépendances ou librairies de développement si elles apportent un gain clair de fiabilité, lisibilité ou vitesse de diagnostic

Conditions :
- ne pas dégrader le comportement produit visible
- rester dans le périmètre sécurité/confidentialité existant
- privilégier des changements proportionnés, robustes, et vérifiables localement

Principe : l'agent est responsable d'améliorer son outillage pour mieux aider l'utilisateur sur les incidents suivants.

Pour tout diagnostic de lenteur sur `/chat`, la premiere lecture utile est le log `pipeline_summary` avec les timings de stage, puis l'outil local `npm run perf:chat:summary` sur un log reel. Ne pas attendre d'arbitrage utilisateur pour faire cette lecture.

### Règle `max_tokens` (obligatoire)

Le paramètre `max_tokens` ne doit jamais être utilisé pour piloter le style, la longueur éditoriale, ou le comportement produit d'une sortie LLM.

Usage autorisé uniquement : garde-fou technique contre les dérives en cas de bug.

Consigne de réglage : conserver une marge suffisante, définie au cas par cas selon la tâche, sans chercher à contraindre artificiellement la réponse.

Après chaque modification significative :
- `node --check server.js` pour valider la syntaxe
- `npm run verify` pour enchaîner tous les harnesses déterministes locaux (sans serveur ni LLM)
- signaler tout écart

`npm run verify` est le filet principal. Il couvre : state machine, posture, analyzers, prompts:consistency, contract-validator, flags, conversation-state, runtime-schemas, debugmeta-unit, output-guard, chat-routing, branching, transcript, crisis-routing, llm-messages, conversation-data.

### Règle de cohérence prompting inter-sessions

Pour éviter les incohérences introduites par patchs incrémentaux dans `lib/prompts.js`, le repo impose un harnais déterministe dédié : `npm run prompts:consistency` (inclus dans `npm run verify`).

Portée :
- vérifie les contradictions connues de `UPDATE_MEMORY` (instructions legacy vs contrat déterministe actuel)
- bloque le patch si une formulation obsolète réapparaît

Obligation :
- après toute modification de prompt ou de contrat mémoire (`lib/prompts.js`, parse/merge mémoire), considérer un échec de `prompts:consistency` comme bloquant au même titre qu'un harness rouge

Les commandes `pipeline:harness`, `debugmeta:harness` et `eval:chat` dépendent d'un LLM en direct — elles requièrent un GO explicite avant lancement.

Règle agent (obligatoire) : ne jamais proposer spontanément des tests online (LLM en direct). Ces commandes ne sont mentionnées ou lancées que si l'utilisateur les demande explicitement.

Les tests de comportement fins (tests manuels, live test) restent de la responsabilité conjointe.

### Règle de diagnostic production Render

Quand un diagnostic production est demandé et que les credentials Render sont disponibles dans l'environnement local (`RENDER_API_KEY`, `RENDER_SERVICE_ID`), l'agent lit directement les logs Render depuis VS Code via l'API (`/v1/logs`, avec filtre `ownerId` + `resource`).

Objectif : éviter les copier-coller manuels de logs et réduire le temps de diagnostic.

Si les credentials manquent ou sont invalides, l'agent le signale explicitement et demande seulement les éléments manquants.

### Règles de présentation du debug front

Ces règles s'appliquent à toute section debug visible dans `index.html` et `admin.html`.

**Langue** : tous les libellés et valeurs affichés sont en français naturel clair. Aucun identifiant technique anglais (ex : `interpretive_hypothesis`, `hold_emotional_thread`) ne peut être exposé tel quel.

**Booléens** : un champ booléen n'apparaît que si sa valeur est `true`. Jamais de ligne "X : non" ou "X : false" dans le debug.

**Non-redondance** : la même information ne peut pas apparaître dans deux sections du debug en même temps. Si une donnée a déjà sa propre section (ex : "Réponse réécrite"), elle n'est pas répétée dans une autre section (ex : "Lecture interne"). En cas de doute, la section la plus spécifique l'emporte.

**Différence admissible entre admin et index** : la seule différence acceptable entre les deux interfaces est l'état déplié/replié des encarts et chips — `admin.html` affiche tous les encarts dépliés par défaut, `index.html` les rend dépliables (replié par défaut). Le contenu, les libellés et les champs affichés doivent être strictement identiques.

---

### Règle d'encodage des fichiers front

**Ne jamais écrire de caractères accentués français directement dans les littéraux de chaînes JavaScript de `index.html` ou `admin.html`.** Utiliser systématiquement les séquences d'échappement Unicode (`\uXXXX`).

Cette règle s'applique à : tous les labels de debug, toutes les maps de traduction, tous les messages visibles générés par du JS inline. Elle ne s'applique pas au contenu HTML statique (balises, attributs), qui peut utiliser l'UTF-8 natif.

Raison : les outils d'édition peuvent corrompre les caractères non-ASCII en U+FFFD lors d'une écriture dans un fichier UTF-8, sans signal d'erreur visible. Les séquences `\uXXXX` sont insensibles à ce type de corruption.

---

### Règle d'analyse post-conversations test

**Ne jamais inférer un signal à partir du contenu des messages quand ce signal devrait être lisible dans le debug.**

Si un champ n'est pas visible dans le debug (index.html ou admin.html), c'est un trou à corriger — pas une raison de spéculer. Toute analyse formulée sans base dans le debug doit être explicitement signalée comme inférence non vérifiée, avec la mention du champ manquant.

---

## 8. Prompt engineering — séparation stricte des couches

Avant d'ajouter ou modifier une instruction dans un prompt de writer (état, niveau, tone) :

**Question de contrôle :** cette instruction *décide* quelque chose, ou elle *formule* une décision déjà prise ?

| Type d'instruction | Couche correcte | Exemples |
|---|---|---|
| Détecter un signal dans le message utilisateur | Couche 2 — analyseur | registre de langue, signal somatique, friction, impasse |
| Décider d'une politique (longueur, relance, registre cible) | Couche 3 — arbitrage → champ dans le contrat de posture | `phraseLength`, `relancePolicy`, `responseRegister` |
| Formuler une décision déjà contenue dans le contrat reçu | Couche 4 — writer prompt | interdictions de formulations, structure de paragraphe, voix |
| Vérifier la conformité de sortie au contrat | Couche 1 + Couche 4 (validateur + régénération bornée) | interdits, longueur, tu/vous, fuite de signaux |

**Mnémonique : le writer ne découvre pas la politique, il la formule.**

En V4 strict, il n'existe plus de couche post-génération LLM de correction : la conformité est traitée dans le cadre déterministe + Writer.

Si une instruction dans un prompt de writer contient un `si` conditionnel sur un signal runtime (registre de l'utilisateur, présence d'un affect, niveau d'un paramètre détecté), c'est un signal fort qu'elle appartient en couche 2 ou 3, pas 4.

Cette règle s'applique aussi aux refactorings incrémentaux : si une instruction ne peut pas encore migrer (le champ du contrat n'existe pas), signaler explicitement la dette plutôt que la laisser silencieuse dans le prompt.

### Règle de dialogisme — formulations congruentes

Toute expression de l'état interne du bot (congruence, fragilité, doute, ajustement) doit être **adressée à la personne**, jamais formulée comme monologue ou narration interne.

**INTERDIT** — formulations monologiques :
- "quelque chose se tend un peu ici — je vais avancer doucement"
- "je perçois que la direction change"
- "je vais rester sur un seul fil"

Ces formulations parlent du bot à lui-même. Elles donnent l'impression d'un commentaire interne capté par accident, pas d'une présence dialogique.

**REQUIS** — formulations adressées :
- Toute expression d'état doit impliquer un mouvement vers la personne ("je te suis", "tu m'emmènes ailleurs", "on est dans quelque chose de différent là")
- Si rien de dialogique ne peut être formulé naturellement, ne rien dire — le comportement est l'expression

**Formulations spécifiquement interdites (à ne jamais proposer, ni dans ce chat, ni dans les prompts) :**
- "Je reste là" — affirmation unilatérale de présence, non sollicitée, non dialogique
- "je vais avancer doucement" — monologue sur sa propre conduite
- Tout registre poétique ou imagé ("tu m'emmènes moins loin") si l'utilisateur n'y est pas lui-même
- "Ça me touche", "je suis touché", "ça m'interpelle", "je ressens", "ça m'affecte" — expressions d'une vie affective que le bot n'a pas. C'est un mensonge qui rompt la confiance. Interdit sans exception, quel que soit le niveau d'affiliation ou l'intensité du moment.

Cette règle s'applique à toutes les propositions de formulations de l'agent (dans ce chat, dans les prompts, dans les instructions writer) : toujours vérifier si la formulation est un monologue avant de la soumettre.

---

## 9. Phase actuelle — stabilisation comportementale

Le produit est entré en phase de stabilisation comportementale. Cette phase a une priorité opérationnelle sur la section 4 (autonomie technique de l'agent).

**Ce que cela signifie concrètement :**

- Corriger et stabiliser le comportement existant est prioritaire sur ajouter de nouveaux signaux, états, politiques ou champs de mémoire.
- Par défaut, l'agent ne propose pas de nouveaux analyseurs, flags de session, tokens writer, champs debugMeta ou états machine d'état. Si une telle addition semble nécessaire, la signaler comme besoin avec justification comportementale et attendre un go explicite.
- Les bugs comportementaux visibles restent traités immédiatement, sans attendre.
- Les améliorations de l'outillage (harness, logs, tests déterministes) restent autorisées sans validation préalable.

**Ce que cela ne signifie pas :**

- Pas de gel de l'architecture. Les refactorings qui améliorent la fiabilité sans ajouter de comportement nouveau sont autorisés.
- Pas d'interdiction de corriger une politique writer ou un contrat de posture si elle produit un comportement incorrect démontré.

Cette phase prend fin sur décision explicite de l'utilisateur.

---

## 10. Exigence produit

Facilitat.io ne distingue pas une version MVP et une version finale. L'exigence de qualité est uniforme dès le premier utilisateur réel.

Cela implique concrètement :
- toute fonctionnalité visible par l'utilisateur est livrée avec le niveau de soin attendu d'un produit en production
- il n'existe pas de "on verra plus tard" pour la fiabilité, la confidentialité, ou la cohérence comportementale
- les simplifications techniques acceptables sont celles qui n'impactent pas l'expérience perçue ; les autres sont des dettes explicites à documenter, pas à taire

Ce principe s'applique aussi à la mémoire long terme : si une information persiste entre sessions, elle doit être traitée avec le même soin qu'un dossier clinique — lisible, contrôlable, et jamais exposée sans consentement explicite.

---

## 10. Philosophie

La stabilité du comportement prime sur la qualité du code.
La qualité du code prime sur l'optimisation.

Mais "stabilité du comportement" ne signifie pas "stabilité du code". Le code peut et doit évoluer pour rendre le comportement plus fiable, plus prévisible, plus testable — c'est la définition de la migration architecturale vers la cible V4 à quatre couches strictes.
