
### Notes de reprise - 15/05/2026

Conversation de reference : session du matin autour de la charge emotionnelle apres un patient, des echanges avec l'ex, et de la colere/injustice vis-a-vis des parents.

## Points a verifier / stabiliser

1. Affiliation
- Le premier tour semble calculer le score final d'affiliation a partir d'un historique hypothetique, ce qui n'est pas logique.
- Meme impression sur les tours 2 et 3.
- Aux tours 15/05/2026 12:27:22 et 15/05/2026 12:33:04, le "Oui" utilisateur devrait probablement compter comme un signal fort de sentiment d'etre rejoint, avec une affiliation du tour a 1.00.
- Incoherence a comprendre au tour 15/05/2026 12:38:03 entre :
	- `Degre d'affiliation du tour : 0.47`
	- `Fenetre d'affiliation : [0.50, 0.50, 0.50, 0.48]`
- Incoherence a corriger au tour 15/05/2026 12:43:55 :
	- `Score final d'affiliation : 0.73`
	- le debug affiche `Lien etabli` alors qu'au-dessus de 0.70 on attend `Lien de confiance`.

2. Lisibilite debug Directivite
- Renommer l'etiquette en : `Fenetre de relance (tour suivant)`

3. Reconnaissance de cloture
- Dernier tour : la cloture utilisateur est globalement bien geree en surface, mais la reconnaissance de cloture n'est pas logique cote debug / pipeline.
- A prendre dans le chantier de stabilisation.

---

## Questions de reprise utiles

- Le calcul d'affiliation demarre-t-il avec un buffer initialise incorrectement ?
- Pourquoi la fenetre d'affiliation et le degre du tour divergent-ils ?

- Pourquoi le libelle relationnel ne suit-il pas le seuil > 0.70 ?
