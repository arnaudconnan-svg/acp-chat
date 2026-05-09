### Pipeline V4 strict (4 couches) — État actuel

## Objectif produit courant :
- Stabiliser le pipeline V4 strict a 4 couches sans compat legacy et sans Critic post-generation LLM.

## Decisions deja prises :
- Le Critic est retire completement du runtime, des prompts, des harnesses et de la verification.
- La conformite finale est traitee par le couple garde deterministe (C1) + Writer borne (C4), sans couche LLM post-generation.
- Les chemins de compatibilite legacy runtime ont ete supprimes (etats legacy, conversationStateKey, aliases attention/processing, aliases debug).

## Validation attendue :
- `node --check server.js` passe.
- `npm run verify` passe en entier.
- Le debug front/back reste coherent apres suppression des aliases legacy.
- Les comportements de cloture ne reouvrent pas la suite sans demande utilisateur.

## Etat du chantier :
- V4 strict 4 couches en place sur beta.
- Compatibilite runtime legacy retiree sur les chemins critiques.
- Documentation alignee en cours (AGENTS, ARCHITECTURE, WORKFLOW).

## Questions ouvertes :
- Aucun point bloquant architecture en cours.
- Prochaine decision attendue: fenetre de stabilisation supplementaire avant fast-forward de `main` depuis `beta`.

