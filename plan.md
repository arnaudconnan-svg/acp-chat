# Stabilisation memoire - cadrage Ask

## Objectif produit courant
- Stabiliser le comportement de la memoire conversationnelle (court terme et articulation inter-session) sans changer son intention produit ni son format visible.
- Isoler le chantier sur la fiabilite/determinisme de mise a jour, sans tentative d'amelioration clinique ou stylistique du contenu.
- Avancer d'abord par clarification precise en Ask, puis implementation seulement apres arbitrages explicites.

## Decisions validees (Ask)
- Separation structurelle memoire en 4 objets independants :
	- `sessionStableContext`
	- `onGoingMovements`
	- `ancientMovements`
	- `pastSignals`
- `sessionStableContext` accumule un savoir selectif pendant la session en cours, avec utilite tour + session + preparation inter-session.
- `sessionStableContext` est revisable pendant la session (modification/suppression autorisees).
- Aucun contenu de memoire inter-session n'est injecte dans le debug session.
- Le Writer recoit la memoire inter-session separement.
- `onGoingMovements` est ecrit par LLM avec contrainte de concision forte et anti-redondance.
- `onGoingMovements` doit etre ecrit en tenant compte de `ancientMovements` pour eviter la redite.
- Archivage `onGoingMovements` -> `ancientMovements` : deterministe, systematique, ordre chronologique.
- L'ordre de pipeline memoire est : archivage vers `ancientMovements` puis ecriture du nouveau `onGoingMovements`.
- Si un mouvement parait redondant, le writer peut quand meme ecrire `onGoingMovements` et proposer des suppressions d'items dans `ancientMovements`.
- Suppressions proposees par le writer : max 2 items par tour (coherent avec `onGoingMovements` max 2 items).
- Si le JSON de suppressions est mal forme : tentative de reparation mineure deterministe ; en cas d'echec, ignorer uniquement les suppressions (conserver l'ecriture `onGoingMovements`).
- Pas de fusion anti-redondance cote `ancientMovements`.
- Pas de compresseur.
- `onGoingMovements` max = 2 items.
- `ancientMovements` sans limite de taille.
- `pastSignals` est 100% deterministe (signaux structures uniquement, sans inference LLM).
- `pastSignals` conserve la logique actuelle : tour precedent uniquement.
- En cas d'echec de MAJ memoire : conserver N-1 (pas de fallback local).
- Pas de migration d'ancien format memoire (wipe Firebase + reset localStorage prevus).
- `ancientMovements` : duree de conservation = 3h (ajustable plus tard), calculee depuis le dernier message de la conversation.
- Si inactivite > 3h : purge totale de `ancientMovements` et `onGoingMovements` au premier nouveau tour.
- `sessionStableContext` et `pastSignals` ne sont pas purges par cette regle d'inactivite.
- IDs : creation dans `onGoingMovements`, transmission telle quelle vers `ancientMovements`.
- Format d'ID lisible date/heure + suffixe court ; nouvel ID a chaque reformulation.
- Debug `ancientMovements` :
	- affichage 10 items par defaut
	- bouton `Afficher 10 de plus`
	- bouton `Replier 10`
	- entrees vides affichees aussi
- Debug `sessionStableContext` : affichage complet direct.
- Debug `pastSignals` : affichage complet direct.

### Axe 1 — Stabilite de structure memoire
- Verrouiller les invariants de structure des 4 objets.
- Rendre `sessionStableContext` nettement plus selectif qu'aujourd'hui.
- Garantir l'absence totale d'injection inter-session dans le debug session.
- Stabiliser le contrat JSON d'ecriture `onGoingMovements` + suppressions `ancientMovements`.

### Axe 2 — Sanitation memoire
- Determiniser la sanitation (suppression de lignes) pour eviter les variations de sortie.
- Garantir un resultat stable a entree equivalente.
- Maintenir la concision et la non-redondance de `onGoingMovements` (max 2 items).

### Axe 3 — Vieillissement et archivage
- Archiver systematiquement `onGoingMovements` dans `ancientMovements` a chaque tour.
- Conserver l'ordre chronologique sans fusion ni compression.
- Appliquer la purge >3h selon l'arbitrage (ancien+ongoing seulement).

## Questions ouvertes (Ask)
- Aucune.


