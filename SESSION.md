# SESSION.md

## Contexte actuel

### MAJ 2026-04-25

- la branche de travail est `beta`
- les evals `/chat` lourdes ont ete retirees du repo
- le backend a ete recentre autour d'un pipeline ou `applySelectiveCritic(...)` est l'unique passe post-generation
- `detectMode(...)` a ete remis dans la vague d'analyse parallele
- `AGENTS.md` a ete reecrit : l'utilisateur est l'expert produit/mier, l'agent est le developpeur autonome
- le prochain chantier est purement technique : meilleures conditions de travail pour l'agent

### Ce qui a deja ete fait recemment

- suppression complete de l'ancien systeme override/comparison
- suppression complete de `comparisonResults`
- retrait des evals chat historiques du repo
- migration de la politique rejet d'interpretation vers la pre-ecriture
- critic unique en post-pass

## Etat de reference

- verifier la syntaxe avec `node --check server.js`
- verifier les routes de base avec `npm run smoke`
- ne pas supposer qu'un changement backend est pris en compte tant que le serveur local n'a pas ete redemarre

## Prochaine etape recommandee

- remettre a niveau `SESSION.md`, `WORKFLOW.md`, `ARCHITECTURE.md`, `PROMPTING.md`
- ajouter un log structure `[PIPELINE]` en fin de `/chat`
- decouper `server.js` en modules incrementaux (`prompts`, `flags`, `analyzers`, `memory`, `pipeline`)
- ajouter un mini-harness comportemental centre sur `debugMeta`

## Points de vigilance

- ne pas changer le comportement visible sans annonce et validation produit
- conserver la priorite : securite > crise > rupture relationnelle > contact > exploration > information
- garder le contrat frontend/backend coherent dans le meme patch
- garder la memoire comme resume recalcule a chaque tour

## Notes de passation

- lire en premier `AGENTS.md`, puis `SESSION.md`, `WORKFLOW.md`, `ARCHITECTURE.md`
- pour un chantier technique, l'agent peut agir directement puis expliquer apres validation locale
- pour un changement visible, annoncer d'abord l'effet utilisateur, le risque, puis attendre le go