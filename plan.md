
### Notes de reprise - 15/05/2026

Conversation de reference : session du matin autour de la charge emotionnelle apres un patient, des echanges avec l'ex, et de la colere/injustice vis-a-vis des parents.

## Points a verifier / stabiliser

1. Memoire `onGoingMovements`
- Gros probleme de pertinence : `onGoingMovements` recopie des faits / formulations identiques a `ancientMovements` au meme tour, au lieu de se focaliser sur le message utilisateur N-1.
- Comme la memoire est asynchrone volontairement pour limiter la latence, le comportement attendu reste : `onGoingMovements` doit refleter le tour precedent proche, pas recycler l'ancien.
- Le mecanisme de deduplication / suppression des anciens items trop proches des nouveaux ne semble pas fonctionner.
- A partir du tour 15/05/2026 12:43:55, de nouveaux items apparaissent soudainement dans `onGoingMovements` : verifier si cela correspond a une decision `hold` / `update` memoire.
- Important : exposer ce signal en debug pour pouvoir evaluer le comportement (`update` vs `hold`, raison, source si pertinent).
- ordre d'affichage des `ancientMovements` : les items doivent etre affiches du plus recent au plus ancien, pas l'inverse.

2. Signaux memoire
- Les `previousTurnSignals` / signaux du tour precedent n'apparaissent plus.
- A verifier si c'est coherent pour cette conversation precise ou si c'est une regression de production / debug / propagation.

3. Memoire inter-sessions
- La memoire inter-sessions ne semble plus etre nourrie.
- Hypothese a verifier : le probleme vient peut-etre de `stableContext` qui ne remonte plus rien, plutot que de la memoire inter-sessions elle-meme.

4. Affiliation
- Le premier tour semble calculer le score final d'affiliation a partir d'un historique hypothetique, ce qui n'est pas logique.
- Meme impression sur les tours 2 et 3.
- Aux tours 15/05/2026 12:27:22 et 15/05/2026 12:33:04, le "Oui" utilisateur devrait probablement compter comme un signal fort de sentiment d'etre rejoint, avec une affiliation du tour a 1.00.
- Incoherence a comprendre au tour 15/05/2026 12:38:03 entre :
	- `Degre d'affiliation du tour : 0.47`
	- `Fenetre d'affiliation : [0.50, 0.50, 0.50, 0.48]`
- Incoherence a corriger au tour 15/05/2026 12:43:55 :
	- `Score final d'affiliation : 0.73`
	- le debug affiche `Lien etabli` alors qu'au-dessus de 0.70 on attend `Lien de confiance`.

5. Lisibilite debug Directivite
- Renommer l'etiquette en : `Fenetre de relance (tour suivant)`

6. Reconnaissance de cloture
- Dernier tour : la cloture utilisateur est globalement bien geree en surface, mais la reconnaissance de cloture n'est pas logique cote debug / pipeline.
- A prendre dans le chantier de stabilisation.

---

## Questions de reprise utiles
- Est-ce que la panne de memoire inter-sessions est un probleme d'alimentation, de recalcul, de gating `stableContext`, ou seulement d'affichage debug ?
- Est-ce que la memoire est en `hold` sur certains tours sans visibilite suffisante dans le debug ?

- Le calcul d'affiliation demarre-t-il avec un buffer initialise incorrectement ?
- Pourquoi la fenetre d'affiliation et le degre du tour divergent-ils ?

- Pourquoi le libelle relationnel ne suit-il pas le seuil > 0.70 ?
