25/05/2026 - Reprise chantier latence reponse (focus Writer)

Contexte
- Les tours simples (bavardage leger, trivial quotidien) sont percus comme trop lents (~14-16s sur certains exemples).
- Le ressenti produit est "machine qui surtraite" quand la latence est elevee sur des messages tres simples.

Constat technique principal sur la latence
- Le levier majeur de gain est cote Writer (generation finale), pas seulement les analyseurs.
- Les pistes d'optimisation doivent preserver le comportement percu (stabilisation prioritaire).

Options a arbitrer (produit)
- Option A: Routing modele Writer par etat
	- Etats sensibles (crise/forte charge): modele actuel.
	- Etats simples (info app, echanges triviaux, social leger): modele plus rapide.
	- Benefice attendu: baisse nette du temps median sur tours simples.
	- Risque: heterogeneite de style si calibration insuffisante.

- Option B: Compression du prompt Writer
	- Garder uniquement la formulation (politique deja decidee en amont), enlever redondances.
	- Benefice attendu: moins de tokens entree, meilleure reactivite.
	- Risque: perte de garde-fous si compression trop agressive.

- Option C: Injection memoire Writer ciblee
	- Sur tours triviaux: injecter strict minimum utile au tour.
	- Benefice attendu: moins de surcharge, ton plus direct.
	- Risque: perte de continuite locale si filtrage trop dur.

- Option D: Politique de longueur pour tours triviaux
	- Reponses plus courtes decidees par contrat (pas via max_tokens).
	- Benefice attendu: baisse generation + baisse ressenti surtraitement.
	- Risque: secheresse relationnelle si appliquee hors contexte.