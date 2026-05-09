# ARCHITECTURE.md — Facilitat.io

## Vue d'ensemble

Application conversationnelle avec :

- backend : Node.js + Express + OpenAI + Firebase
- frontend : `public/index.html` comme client principal
- stockage : Firebase comme source principale, avec etat local cote client

## Cible architecturale

Le systeme converge vers cinq couches distinctes :

1. noyau deterministe
2. analyseurs paralleles
3. arbitrage explicite
4. writer pilote par contrat
5. critic garde-barriere

La regle centrale est : la politique conversationnelle doit etre decidee avant la generation, pas pendant ni apres.

## Etat actuel

Le coeur du backend reste dans `server.js`, avec une route `/chat` qui orchestre :

- parsing et validation de la requete
- persistance des messages
- analyse suicide / crise
- recall conversationnel
- analyse contact
- vague d'analyse parallele pour les autres signaux
- arbitrage via `buildPostureDecision(...)`
- generation via `generateReply(...)`
- controle post-generation via `applySelectiveCritic(...)`
- mise a jour de la memoire
- persistence et reponse HTTP

## Invariants comportementaux

Les invariants protegent le comportement, pas la forme du code.

- securite et crise passent avant tout
- l'ordre de priorite reste : securite > crise > rupture relationnelle > decharge > exploration > information
- la memoire reste un resume recalcule a chaque tour
- le contrat frontend/backend doit rester coherent dans le meme patch
- `applySelectiveCritic(...)` est l'unique passe post-generation qui peut modifier la reponse

## Contrat prompting/memoire (source de verite)

Pour la memoire de session :

- `UPDATE_MEMORY` produit un texte au format 3 sections (`Contexte stable`, `Mouvements en cours`, `Anciens mouvements`), avec `Anciens mouvements` force a `-`
- le transfert vers `Anciens mouvements`, les identifiants, l'archivage et les timestamps sont calcules de facon deterministe cote code (`mergeMemoryStateWithFinalizedText`)
- les anciens prompts memoire non relies au runtime (finalize/rewrite/compress legacy) ne font pas partie de l'architecture active

Consequence d'architecture :
- aucune instruction prompt ne doit reintroduire une logique d'archivage LLM-driven
- un harnais `prompts:consistency` enforce cette contrainte dans la verification standard

## Observabilite

Le pipeline produit plusieurs traces utiles :

- `[CHAT][DECISION]` pour certains evenements locaux
- `[CHAT][TRACE]` pour les timings de fin de requete
- `[PIPELINE]` pour la vue consolidee d'un tour `/chat`
- `debugMeta` dans la reponse et dans les messages persistants

`debugMeta` est le contrat d'observabilite principal pour comprendre :

- le mode retenu
- l'etat conversationnel
- les signaux d'ajustement relationnel
- les decisions du critic
- les niveaux de calibration et de directivite

## Frontend

Le frontend :

- affiche les messages
- garde un etat local de session
- transmet `memory`, `flags`, `recentHistory` et le contexte necessaire a `/chat`

Le frontend ne doit pas redecider la politique conversationnelle.
Il doit seulement transmettre un etat coherent et afficher le resultat.

## Direction technique — priorite court terme

Le produit est en phase de stabilisation comportementale.

La priorite immédiate est de consolider le comportement sur l'architecture existante — pas d'ajouter de couches, de signaux ou de politiques nouvelles.

Les extractions modulaires et refactorings qui ameliorent la fiabilite et la testabilite restent bienvenus, a condition de ne pas introduire de nouveau comportement visible.

La liste des extractions structurelles prevues (prompts, normalisateurs, analyzers, memoire, arbitrage/writer/critic) reste l'objectif moyen terme. Elle sera reprise apres la phase de stabilisation.