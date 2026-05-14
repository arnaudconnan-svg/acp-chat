Base de reprise - conversation test du 14/05/2026

Priorite absolue
- Memoire de session non branchee (hors signaux N-1): c'est la priorite numero 1.

Decisions produit actees (a ne plus requalifier en bug probable)
- Le debug memoire affiche l'etat disponible en debut de tour (N-1).
- La mise a jour memoire est asynchrone et non bloquante.

Ordre de traitement Ask (un point a la fois, sans patch global)

1) Memoire session
- Verifier pourquoi les 4 blocs restent vides sur plusieurs tours alors que du contenu existe.
- Separer clairement: probleme de calcul memoire vs probleme de propagation vs probleme d'affichage debug.
- Criteres de succes: au moins un mouvement/contexte utile remonte et reste coherent tour a tour.
- Ajouter une trace debug explicite de la decision memoire (`update` vs `hold`) + motif + source.

2) Stagnation (suspect principal)
- Fenetre de stagnation qui ne glisse pas: [0-1-0-1] semble rester figee.
- Stagnation visible trop tot: apparait deja au premier tour utile alors qu'il faut une reference precedente.
- Verifier la regle deja posee: stagnation impossible au premier tour evaluable.
- Criteres de succes: stagnation = 0 au premier tour; puis evolution reelle de la fenetre sur les tours suivants.
- Regle produit a appliquer: le premier tour doit forcer `false` sur Stagnation, meme avec la logique de securite actuelle.

3) Tour 2 - lecture relationnelle possiblement inversee
- Cas ambigu: utilisateur critique une autre IA qui critique le bot.
- Debug actuel: "Rupture d'alliance (modere)" + "Rejet d'interpretation".
- Hypothese: faux positif sur rupture/rejet dans un message en defense du cadre du bot.
- Important: eviter une correction qui degrade les cas ou la rupture est reelle.
- Exigence debug: la decision doit etre tracable (et pas seulement inferrable via la reponse).

4) Tour 2 - decentrage emotionnel
- Detection regex sur "Bref" active un decentrage.
- Le meme message contient ensuite un affect explicite fort ("ca me soule tellement !!").
- Point a trancher: un affect explicite fort doit-il invalider/abaisser le signal de decentrage du meme tour.

5) Coherence debug vs execution reelle (tour 2)
- "Reajustement sobre applique" possiblement affiche comme fait, alors que la reponse parait surtout coherentement empathique sans marqueur net de reajustement visible.
- "Tentation procedurale - auto-derision" indiquee mais pas clairement materialisee.
- Verifier le statut exact des lignes debug: decision retenue, action executee, ou simple hint.
- Exigence debug: tracer clairement la nature du statut (applique, inactif, ou suggestion non executee).

6) Affiliation tours 3 et 4
- Tour 3: message commence par "Oui" mais le +0.50 de validation utilisateur n'est pas evident dans la lecture metier.
- Tour 4 (cloture): chute a 0.23 (degre 0.04) possiblement paradoxale avec une cloture saine.
- Verifier la compatibilite entre "accompagner la cloture" et "affiliation toujours en cours".

Points supplementaires a surveiller
- "Signaux du tour precedent" semble partiel/inconstant selon les tours (possible ecrasement ou filtre trop strict).
- Changement de libelle memoire entre tours ("Memoire session utilisee..." vs "Memoire structuree (4 blocs)") peut brouiller la lecture produit.
- La reponse utilisateur-visible reste globalement bonne: le risque principal est une incoherence de debug/pipeline, pas une rupture flagrante de qualite percue.
- Le cockpit semble sous-instrumente sur la chaine memoire: ajouter des logs utiles est prioritaire si les logs existants ne suffisent pas.

Prochaine sequence validee
- D'abord lecture des logs Render sur le creneau de la conversation test pour chercher des traces aidantes.
- Si insuffisant: ajout de logs techniques cibles (points de cassure memoire/debug) avant correction comportementale.

Mode operatoire valide
- Stabilisation: pas d'ajout de nouveaux signaux/champs tant que les incoherences de base ne sont pas traitees.
- Avancer en Ask, point par point, avec verification locale apres chaque correction.
