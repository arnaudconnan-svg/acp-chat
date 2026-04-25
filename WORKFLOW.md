# WORKFLOW.md — Facilitat.io

## 1. Objet

Ce fichier decrit le mode de travail reel du projet.

- l'utilisateur formule un objectif produit, un probleme visible, ou une contrainte metier
- l'agent choisit l'implementation technique, structure le chantier, modifie le code, puis verifie
- GitHub reste la source de verite
- la branche `beta` reste la base de travail principale sauf besoin explicite contraire

## 2. Regle generale

Le controle porte sur le comportement visible, pas sur chaque decision de code.

Toujours :
1. formuler l'objectif en langage produit ou comportemental
2. laisser l'agent choisir le moyen technique
3. tester ce qui est modifie
4. conserver un historique git lisible

Ne jamais :
- valider un changement visible non compris
- melanger un vrai changement produit et un refactoring large sans l'annoncer
- supposer qu'un diff court est automatiquement plus sur qu'un diff structurel propre

## 3. Changement purement technique vs changement visible

### Changement purement technique

Exemples :
- logs
- renommage interne
- extraction en modules
- refactoring local
- factorisation

Dans ces cas :
- l'agent agit directement
- il explique apres coup ce qu'il a fait
- il valide localement avec les commandes adaptees

### Changement visible pour l'utilisateur final

Exemples :
- ton de reponse
- routing de mode
- reponse de crise
- forme de la memoire affichee
- comportement frontend perceptible

Dans ces cas :
1. l'agent annonce ce qui va changer
2. l'agent indique le risque principal
3. il attend un go avant de coder

## 4. Verification attendue

Verification minimale apres changement backend significatif :

1. `node --check server.js`
2. `npm run smoke`

Verification complementaire selon le chantier :

- lecture des logs `[PIPELINE]` pour un diagnostic fin de `/chat`
- harness comportemental centre sur `debugMeta`
- test manuel cible quand le changement est visible

## 5. Strategie de chantier

L'ordre prefere est :

1. observabilite
2. correction locale ou refactoring necessaire
3. validation et seulement ensuite elargissement

Pour les gros chantiers techniques, privilegier :

- extraction modulaire incrementale
- validation apres chaque extraction
- un seul type de risque a la fois

Exemple recommande pour `server.js` :

1. `prompts`
2. `flags`
3. `analyzers`
4. `memory`
5. `pipeline`

## 6. Zones sensibles

Les zones qui demandent le plus de rigueur sont :

- `server.js` et la route `/chat`
- les fonctions de memoire
- les transitions d'etat conversationnel
- le contrat frontend/backend entre `public/index.html` et `/chat`
- `public/sw.js`

La sensibilite d'une zone ne signifie pas qu'elle est intouchable.
Elle signifie qu'elle doit etre modifiee avec verification adaptee.

## 7. Git

Regles pratiques :

- preferer des commits lisibles et thematiques
- ne pas melanger plusieurs chantiers sans lien dans un meme commit
- ne jamais utiliser de reset destructif sans demande explicite
- si le working tree est sale, ne pas revert les changements utilisateur sans accord

## 8. Philosophie

Sur ce projet :

- stabilite du comportement > qualite du code > optimisation
- mais stabilite du comportement ne signifie pas immobilite du code
- si une structure interne freine la fiabilite, l'agent doit la faire evoluer
- l'architecture doit progressivement converger vers : noyau deterministe, analyseurs paralleles, arbitrage explicite, writer pilote, critic garde-barriere

---

## 12. Routine test conversationnel en direct (assistée)

Objectif :

- tester le comportement du bot en boucle courte avec pilotage humain

Protocole :

1. Codex propose 3 messages utilisateur fictifs, style casual
2. l'utilisateur choisit un message via son numero, ou envoie `send: ...`
3. Codex envoie ce message au serveur local (`/chat`)
4. Codex renvoie :
	- la reponse brute du bot
	- 3 nouvelles propositions de message utilisateur
5. on repete jusqu'a demande explicite d'arret

Contraintes de generation des 3 propositions :

- profils humains plausibles, parfois peu a l'aise emotionnellement
- longueurs variees (court, moyen, long)
- ajout possible de bruit naturel (hesitations, auto-corrections, ellipses)
- ton casual, non force

Usage de la balise `<notes>` :

- l'utilisateur peut fournir des informations hors flux via `<notes>...</notes>`
- ces notes servent a orienter les essais et l'analyse
- elles ne sont pas envoyees telles quelles au serveur sauf demande explicite

Commandes operatoires :

- `send: <texte>` : envoyer exactement le texte indique
- `stop` : arreter la boucle de test
- apres `stop` : lancer un debrief synthese (patterns observes, points de risque, idees d'ajustement)

Verification minimale a chaque tour :

- confirmer le message effectivement envoye
- afficher la reponse du bot recue
- proposer immediatement 3 nouvelles options