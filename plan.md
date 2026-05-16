Notes de stabilisation - 16/05/2026

1) Memoire intersession - incoherence et redondance front: dans index.html, presence de "Mem. compacte runtime" avec "Memoire inter-session compacte (runtime): - La mere de l'utilisateur s'appelle Martine"; dans admin.html, suivi different; libelle redondant (titre + contenu repetent la meme chose). Decision: ne plus afficher ce bloc runtime a chaque reponse dans index.html/admin.html (info deja affichee ailleurs sur la page). Note scope: l'incoherence d'affichage entre vues est couverte ici + point 5 (pas d'axe separe).

2) account.html - mauvais format de memoire longue terme: memoire servie au format compact ("Memoire inter-session: - La mere de l'utilisateur s'appelle Martine") au lieu du format naturel attendu. Decision: rendre la memoire longue terme en format naturel humain, pas en format compact technique.

3) Cloture detectee a tort sur propos rapportes: premier tour arbitre en "cloture" alors que la formule de fermeture vient d'un texte cite/reporte ("Merci et bonne soiree a vous"), writer rattrape partiellement mais arbitrage faux. Decision: l'analyse de cloture doit ignorer les propos rapportes/cites et ne retenir que l'intention de cloture du locuteur utilisateur; implementation retenue par prompting LLM, sans garde deterministe pre/post. Note scope: le desalignement arbitre/writer (symptome) est exclu de ce patch tant que la conversation reste sauvee en sortie.

4) Lecture interne - ligne redondante: retirer "Une intention de cloture de session a ete detectee." car redondant dans le debug actuel.

5) Suppression du bloc runtime memoire dans le debug reponse: retirer de index.html et admin.html la section "Memoire inter-session (runtime)" + contenu compact associe; motif: bruit + duplication (info deja prevue a un seul endroit par page).

6) Qualite des onGoingMovements (memoire session) - derive produit: exemples mauvais ("Vous ne repondez plus aux demandes de l'eleveuse.", "L'eleveuse demande des nouvelles d'Auri..."); problemes: "vous" inapproprie, items factuels externes non centres sur les mouvements internes, risque de mauvaise reinterpretation ulterieure, confusion entre propos utilisateur et propos rapportes. Decision explicite pour le LLM onGoingMovements: mouvements internes en cours uniquement, items courts, pas de contextualisation narrative, pas de pronoms ambigus (ex: "lui"), pas de "je" ou "vous" non cites explicitement, pas de reprise brute de citations non attribuees, distinction stricte entre ce que l'utilisateur vit/ressent et ce qu'il rapporte que d'autres ont dit. Exemples encore insuffisants: "Colere et instinct de protection a vif, envie de lui dire ses quatre verites." ("lui" ambigu); "Je me rassure un peu aujourd'hui." / "Ca contrebalance un peu." (valeur memoire trop faible). Note scope: niveau d'inference / tonalite interpretative hors scope de ce patch (ne pas toucher).

7) Section "Signaux du tour precedent": a verifier (coherence de remplissage souvent vide + valeur ajoutee reelle pour le bot). Decision attendue apres verification: conserver si utile, sinon retirer pour reduire le bruit debug.

