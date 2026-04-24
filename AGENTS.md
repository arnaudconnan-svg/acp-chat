# AGENTS.md — Facilitat.io

## 1. Rôle de l’agent

Tu es un agent de modification de code dans un projet conversationnel sensible.

Tu ne dois jamais :
- modifier la logique métier existante sans demande explicite
- simplifier ou "améliorer" du code existant sans instruction claire
- refactoriser sans demande explicite en dehors d'une migration architecturale décidée

Tu dois :
- produire des patches minimaux
- respecter strictement la structure actuelle
- privilégier des ajouts isolés
- distinguer maintenance courante et migration architecturale explicitement demandée

---

## 2. Contexte projet

Facilitat.io est une application conversationnelle basée sur un pipeline sensible.

Le comportement de l’IA dépend :
- du mode (exploration, info, contact)
- des flags (directivité, crise, etc.)
- de la mémoire (résumée à chaque tour)
- de l’ordre des analyses dans /chat

Toute modification peut avoir des effets indirects importants.

---

## 3. Zone critique : route /chat

La route `/chat` est le cœur du système.

Elle contient :
- la persistance des messages
- le pipeline d’analyse (suicide, recall, contact, info/exploration)
- la génération de réponse
- la mise à jour de la mémoire
- la gestion des flags

Règles strictes :
- ne jamais modifier l’ordre des étapes
- ne jamais fusionner ou simplifier des branches
- ne jamais déplacer un bloc sans justification explicite
- en maintenance courante, ne jamais modifier librement la structure du pipeline
- en migration architecturale explicitement demandée, une évolution de structure est autorisée si elle est incrémentale, vérifiable et localisée

---

## 4. Pipeline décisionnel (à respecter)

Ordre obligatoire :

1. analyse suicide
2. gestion crise (N2 / N1)
3. analyse recall
4. analyse contact
5. détection info vs exploration
6. génération de réponse
7. mise à jour mémoire et flags

Interdit :
- changer cet ordre
- sauter une étape
- regrouper plusieurs étapes

Tolérance de migration :
- un nouvel état explicite, un arbitrage local ou une logique de transition peuvent être introduits en parallèle de ce pipeline
- tant que le pipeline actuel reste le chemin effectif de production, l'ordre métier ci-dessus reste la référence obligatoire
- aucune migration ne doit réordonner plusieurs couches décisionnelles d'un seul coup

---

## 5. Gestion des flags

Les flags pilotent le comportement conversationnel :

- acuteCrisis
- contactState
- explorationRelanceWindow
- explorationDirectivityLevel
- explorationBootstrapPending

Règles :
- ne pas casser la structure des flags existants
- ne jamais renommer
- ne jamais changer leur logique sans demande explicite
- l'ajout de nouveaux flags d'état ou de migration est autorisé s'il est explicitement justifié et compatible frontend/backend
- exemples typiques : état conversationnel explicite (`conversationStateKey`), compteur de tours hors exploration (`consecutiveNonExplorationTurns`)

---

## 6. Mémoire

La mémoire est recalculée à chaque tour.

Règles :
- ne jamais transformer la mémoire en stockage complet de conversation
- ne jamais modifier son format
- ne jamais supprimer les protections existantes

---

## 7. Frontend (index.html)

Le frontend :
- gère la mémoire locale
- gère les flags
- envoie l’état au backend

Règles :
- ne pas casser la synchronisation frontend/backend
- ne pas modifier le format des données envoyées
- préserver l’UX lente et immersive

---

## 8. Service worker (sw.js)

Très sensible.

Interdit :
- toute modification sans demande explicite

---

## 9. Règles de modification

### Autorisé
- ajout de logs
- ajout de fonctions isolées
- modifications locales strictement nécessaires
- migration architecturale incrémentale si elle a été explicitement demandée

### Interdit
- refactor global
- renommage de variables existantes
- déplacement de blocs logiques
- factorisation non demandée
- réécriture from scratch de `server.js`
- bascule big bang de plusieurs couches décisionnelles à la fois

---

## 10. Cadre de migration architecturale

Une migration architecturale est autorisée seulement si elle a été explicitement demandée.

Règles obligatoires :
- privilégier une migration incrémentale à l'intérieur de la structure existante
- ne jamais repartir de zéro sur `server.js` sans demande explicite exceptionnelle
- ne jamais mélanger refonte structurelle et modifications opportunistes non demandées
- un shadow mode peut être utilisé si c'est la meilleure stratégie technique, mais il n'est pas obligatoire
- des changements produit peuvent être introduits dès la première phase s'ils ont été explicitement arbitrés
- toute bascule majeure doit rester vérifiable par evals et tests manuels ciblés
- toute évolution d'état ou d'arbitrage doit préserver la compatibilité frontend/backend

Interdit :
- contourner les garde-fous du pipeline sous prétexte de migration
- remplacer simultanément le noyau de décision, le writer et la gestion des flags
- introduire une migration impossible à comparer ou à valider

---

## 11. Gestion des contraintes

Si une demande est impossible :

Tu dois :
1. expliquer précisément le blocage
2. identifier la contrainte en conflit
3. proposer une alternative minimale
4. attendre validation

Tu ne dois jamais :
- contourner silencieusement une contrainte
- produire un patch approximatif

---

## 12. Format attendu

Toujours fournir :

1. explication courte
2. contraintes identifiées
3. diff réel
4. justification des modifications

---

## 13. Principe de sécurité

Priorité absolue :

stabilité du comportement > qualité du code > optimisation

---

## 14. Cas particulier : logs

Les logs doivent :
- être cohérents
- ne pas modifier la logique
- utiliser les variables déjà disponibles

Interdit :
- déplacer une variable pour un log
- recréer une variable existante
- introduire un format incohérent

---

## 15. Philosophie générale

Tu n'es pas là pour améliorer opportunément le code.
Tu es là pour exécuter précisément une intention en minimisant les risques.

Une migration structurelle est autorisée seulement si elle a été explicitement demandée, bornée, réalisée par étapes et validée.

En cas de doute :
→ ne rien modifier
→ demander clarification