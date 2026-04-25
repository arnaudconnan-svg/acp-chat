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
Sécurité > Crise > Rupture relationnelle > Contact > Exploration > Information

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

Avant toute modification qui change un comportement visible :

1. **Annoncer en langage produit** : ce qui va changer pour l'utilisateur final
2. **Indiquer le risque** : ce qui pourrait régresser
3. **Attendre un signal de go** avant d'écrire le code

Pour les modifications purement techniques sans effet comportemental visible (refactoring, renommage interne, restructuration, logs) : exécuter directement, expliquer après si utile.

Si une demande produit est ambiguë techniquement : proposer deux interprétations et demander laquelle est juste, plutôt que de choisir la plus restrictive par défaut.

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
- `npm run smoke` pour vérifier les routes de base (13/13 attendu)
- signaler tout écart

Les tests de comportement fins (tests manuels, live test) restent de la responsabilité conjointe.

---

## 8. Prompt engineering — séparation stricte des couches

Avant d'ajouter ou modifier une instruction dans un prompt de writer (mode, niveau, tone) :

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

## 9. Philosophie

La stabilité du comportement prime sur la qualité du code.
La qualité du code prime sur l'optimisation.

Mais "stabilité du comportement" ne signifie pas "stabilité du code". Le code peut et doit évoluer pour rendre le comportement plus fiable, plus prévisible, plus testable — c'est la définition de la migration architecturale vers la cible à cinq couches.
