# Plan courant

## Objectif produit courant
Stabiliser la validation biometrie native uniquement a l'ouverture froide de l'app.

## Decisions deja prises
- Le parcours d'ouverture passe par `LauncherActivity` puis `GateActivity` une seule fois au lancement initial.
- Toute logique de relance via `onUserLeaveHint`, `Application.onStart`, ou fallback Recents/Launcher a ete retiree.
- `BiometricActivity` reste reservee aux flux web ou autres usages hors ouverture froide.

## Validation attendue
- Au lancement a froid, la biometrie native s'affiche une seule fois.
- Un retour sur l'app deja ouverte ne doit plus redemander d'authentification native.
- Les harnesses deterministes du repo restent verts.

## Etat de validation
- `node --check server.js` : OK
- `npm run verify` : OK

## Questions ouvertes
- Aucune sur le chemin biometrie native d'ouverture froide.
