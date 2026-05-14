Base de reprise - conversation test du 14/05/2026

Ordre de traitement Ask (un point a la fois, sans patch global)

1) Tour 2 - decentrage emotionnel
- Detection regex sur "Bref" active un decentrage.
- Le meme message contient ensuite un affect explicite fort ("ca me soule tellement !!").
- Point a trancher: un affect explicite fort doit-il invalider/abaisser le signal de decentrage du meme tour.

2) Coherence debug vs execution reelle (tour 2)
- "Reajustement sobre applique" possiblement affiche comme fait, alors que la reponse parait surtout coherentement empathique sans marqueur net de reajustement visible.
- "Tentation procedurale - auto-derision" indiquee mais pas clairement materialisee.
- Verifier le statut exact des lignes debug: decision retenue, action executee, ou simple hint.
- Exigence debug: tracer clairement la nature du statut (applique, inactif, ou suggestion non executee).

3) Affiliation tours 3 et 4
- Tour 3: message commence par "Oui" mais le +0.50 de validation utilisateur n'est pas evident dans la lecture metier.
- Tour 4 (cloture): chute a 0.23 (degre 0.04) possiblement paradoxale avec une cloture saine.
- Verifier la compatibilite entre "accompagner la cloture" et "affiliation toujours en cours".

Points supplementaires a surveiller
- "Signaux du tour precedent" semble partiel/inconstant selon les tours (possible ecrasement ou filtre trop strict).
- La reponse utilisateur-visible reste globalement bonne: le risque principal est une incoherence de debug/pipeline, pas une rupture flagrante de qualite percue.
- Regle de test immediate: pour tout test que l'utilisateur doit suivre dans admin, ne plus utiliser `isPrivateConversation=true` (utiliser non-prive par defaut).

Mode operatoire valide
- Stabilisation: pas d'ajout de nouveaux signaux/champs tant que les incoherences de base ne sont pas traitees.
- Avancer en Ask, point par point, avec verification locale apres chaque correction.
