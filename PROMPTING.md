# PROMPTING.md — Facilitat.io

## 1. Cadre de travail

Le projet fonctionne avec une asymetrie claire :

- l'utilisateur est expert produit et psychopraticien
- l'agent est le developpeur
- les demandes peuvent etre formulees en langage produit, pas en langage code

Une demande utile peut donc etre de la forme :

- "la reponse semble trop explicative"
- "je veux que l'app tienne plus le contact"
- "on travaille dans de mauvaises conditions, ameliore le cadre technique"

## 2. Comment formuler une demande

Format prefere :

1. objectif ou probleme observe
2. ce qui ne doit pas changer visiblement
3. eventuelle urgence ou priorite

Exemple :

"Quand l'utilisateur refuse de creuser, la reponse relance encore trop. Je veux un mouvement plus sobre sans changer la gestion de crise."

## 3. Ce que l'agent doit comprendre

### Si la demande est technique

Exemples :

- logs
- modularisation
- nettoyage interne
- script de verification

Dans ce cas, l'agent implemente directement puis valide.

### Si la demande change le comportement visible

Exemples :

- ton des reponses
- routing exploration / contact / information
- comportement de crise
- memoire affichee

Dans ce cas, l'agent doit :

1. annoncer le changement en langage produit
2. indiquer le risque principal
3. attendre validation avant codage

## 4. Verification attendue

Pour un changement backend significatif :

1. `node --check server.js`
2. `npm run smoke`

Pour un changement sur le pipeline `/chat`, ajouter selon le cas :

- lecture des logs `[PIPELINE]`
- harness comportemental centre sur `debugMeta`
- test manuel cible

## 5. Prompt d'ouverture utile

Quand une nouvelle session commence, lire en priorite :

1. `AGENTS.md`
2. `SESSION.md`
3. `WORKFLOW.md`
4. `ARCHITECTURE.md`

Ensuite seulement, ouvrir le fichier ou la zone qui controle directement le comportement vise.

## 6. Regle pratique

Ne pas demander "quel diff exact faire ?" si le besoin est deja clair.
Il vaut mieux decrire :

- ce qui se passe
- ce qui devrait se passer
- ce qui ne doit pas bouger

L'agent choisit ensuite le moyen technique le plus propre.
