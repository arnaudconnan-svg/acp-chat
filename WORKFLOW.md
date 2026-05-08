# WORKFLOW.md — Facilitat.io

## 1. Objet

Ce fichier decrit le mode de travail reel du projet.

- l'utilisateur formule un objectif produit, un probleme visible, une contrainte metier ou soumet une conversation test avec des commentaires dev écrits par lui
- l'agent propose des axes d'amélioration, choisit l'implementation technique, structure le chantier, modifie le code, puis verifie
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
2. `npm run verify`

Verification complementaire selon le chantier :

- lecture des logs `[PIPELINE]` pour un diagnostic fin de `/chat`
- pour toute lenteur percue sur `/chat`, commencer par les `pipeline_summary` et lancer `npm run perf:chat:summary` sur un log reel avant de modifier le code
- des qu'un diagnostic production Render est necessaire, l'agent lit les logs live directement depuis VS Code via commande API Render quand `RENDER_API_KEY` et `RENDER_SERVICE_ID` sont disponibles (pas de copier-coller manuel requis)
- harness comportemental centre sur `debugMeta`
- test manuel cible quand le changement est visible
- `pipeline:harness`, `debugmeta:harness` ou `eval:chat` sur GO explicite seulement (LLM en direct)

## 5. Strategie de chantier

L'ordre prefere est :

1. observabilite
2. correction locale ou refactoring necessaire
3. validation et seulement ensuite elargissement

Pour les gros chantiers techniques, privilegier :

- extraction modulaire incrementale
- validation apres chaque extraction
- un seul type de risque a la fois

## 6. Zones sensibles

Les zones qui demandent le plus de rigueur sont :

- `server.js` et la route `/chat` (pipeline d'execution, early-returns, ordre des etapes)
- `lib/pipeline.js` et `lib/analyzers.js` (arbitrage posture, signaux)
- les fonctions de memoire (`lib/memory.js`)
- les transitions d'etat conversationnel (`lib/conversation-state.js`)
- le contrat frontend/backend entre `public/index.html`, `public/admin.html` et `/chat`
- `public/sw.js` (service worker, cache, offline)
- `lib/debugmeta.js` (toute modification doit etre synchronisee dans les deux interfaces)

La sensibilite d'une zone ne signifie pas qu'elle est intouchable.
Elle signifie qu'elle doit etre modifiee avec verification adaptee.

## 7. Phase actuelle — priorites operationnelles

Le produit est en phase de stabilisation comportementale.

Cela signifie :

- la priorite est de corriger, stabiliser et tester les comportements existants — pas d'en ajouter de nouveaux
- tout nouveau signal, analyseur, etat machine, token writer, champ debug ou champ memoire est traite comme exceptionnel : le signaler comme besoin avec justification comportementale et attendre un go explicite
- les bugs comportementaux visibles restent traites immediatement, sans attendre
- les ameliorations de l'outillage (harness, logs, tests deterministes) restent autorisees sans validation prealable
- les refactorings qui ameliorent la fiabilite sans ajouter de comportement nouveau sont autorises

Cette phase prend fin sur decision explicite de l'utilisateur.

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

## 9. Continuite PC <-> Mobile avec plan.md

Objectif :

- maintenir une continuite de travail entre sessions sur des terminaux differents (PC local, mobile en tunneling) sans devoir tout re-expliquer a chaque ouverture

### Role de plan.md

`plan.md` est le pont de reprise entre sessions. Il contient le contexte minimal pour qu'une nouvelle session puisse reprendre le chantier sans reconstitution.

Contenu obligatoire quand un chantier est actif :
- objectif produit courant
- decisions deja prises
- validation attendue
- questions ouvertes

Contenu exclu :
- historique de modifications deja consommees
- backlog ou todo-list

### Mise a jour

`plan.md` est mis a jour uniquement sur demande. Formulation naturelle du type `MAJ plan.md = ...` declenche une mise a jour en delta intelligent par Copilot. Le contenu apres `=` est interprete comme un delta a integrer, sauf indication contraire.

### Implémentation en cours dans une session tierce

Si un chantier est en cours d'implementation sur un autre terminal et que le repo n'est pas encore aligne avec `plan.md`, ajouter dans `plan.md` un bloc explicite :

> *Implmentation en cours dans une session tierce* : [description de ce qui est en transit] — [contexte ou terminal concerne]

Copilot ne traitera pas l'ecart repo / plan comme une incoherence sur ce sujet tant que ce bloc est present.