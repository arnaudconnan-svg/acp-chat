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

L'architecture cible est à cinq couches :

1. **Noyau déterministe** — machine d'état explicite, transitions, sécurité, contraintes absolues
2. **Analyseurs parallèles** — chaque analyseur remonte un signal structuré sur un aspect du tour (sécurité, intention, mode, rappel, friction, rejet d'interprétation, etc.)
3. **Arbitrage explicite** — `buildPostureDecision` résout les conflits entre signaux et produit une décision de posture unique : état cible, permissions, interdits, style
4. **Writer piloté** — `generateReply` reçoit un contrat déjà arbitré et ne découvre plus la politique, il la formule
5. **Critic garde-barrière** — `applySelectiveCritic` vérifie uniquement les violations de contrat graves ; il ne réécrit pas, il corrige au minimum

La règle centrale : **la politique conversationnelle est décidée avant la génération, jamais pendant ou après.**

---

## 3. Invariants produit (non-négociables)

Ces invariants protègent le comportement visible, pas la structure du code.

### Sécurité
- La détection de crise suicidaire et la gestion de crise aiguë passent avant toute autre décision
- Ces chemins ne peuvent pas être conditionnés, court-circuités, ou dégradés

### Ordre de priorité décisionnel
Sécurité > Crise > Rupture relationnelle > Décharge > Exploration > Information

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
- migrations architecturales incrémentales vers la cible à cinq couches
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

**Contenu obligatoire** de `plan.md` quand un chantier est actif :
- objectif produit courant
- décisions déjà prises
- validation attendue
- questions ouvertes

`plan.md` est libre dans sa forme mais ces rubriques sont minimales. Il ne contient pas d'historique de modifications ni de backlog.

---

## 6. Gestion des blocages

Si un objectif produit est formulé mais l'implémentation correcte est bloquée par une contrainte technique réelle :

1. expliquer le blocage en termes comportementaux (pas de jargon)
2. proposer une alternative qui satisfait l'objectif autrement
3. ne jamais produire un patch approximatif qui contourne silencieusement l'objectif

---

## 7. Qualité et vérification

Après chaque modification significative :
- `node --check server.js` pour valider la syntaxe
- `npm run verify` pour enchaîner tous les harnesses déterministes locaux (sans serveur ni LLM)
- signaler tout écart

`npm run verify` est le filet principal. Il couvre : state machine, posture, contract-validator, flags, conversation-state, debugmeta-unit, critic, chat-routing, crisis-routing, llm-messages, conversation-data.

Les commandes `pipeline:harness`, `debugmeta:harness` et `eval:chat` dépendent d'un LLM en direct — elles requièrent un GO explicite avant lancement.

Les tests de comportement fins (tests manuels, live test) restent de la responsabilité conjointe.

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
| Vérifier une violation grave du contrat | Couche 5 — critic | non-respect d'une interdiction explicite |

**Mnémonique : le writer ne découvre pas la politique, il la formule.**

Si une instruction dans un prompt de writer contient un `si` conditionnel sur un signal runtime (registre de l'utilisateur, présence d'un affect, niveau d'un paramètre détecté), c'est un signal fort qu'elle appartient en couche 2 ou 3, pas 4.

Cette règle s'applique aussi aux refactorings incrémentaux : si une instruction ne peut pas encore migrer (le champ du contrat n'existe pas), signaler explicitement la dette plutôt que la laisser silencieuse dans le prompt.

---

## 9. Exigence produit

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

Mais "stabilité du comportement" ne signifie pas "stabilité du code". Le code peut et doit évoluer pour rendre le comportement plus fiable, plus prévisible, plus testable — c'est la définition de la migration architecturale vers la cible à cinq couches.
