1. Sortir davantage de post-traitements hors chemin critique
- Déjà fait pour le titre.
- Autres tâches purement administratives qui n'influencent pas le texte renvoyé au user.

2. Optimisations réseau/API invisibles
- Keep-alive/connexion persistante optimisée, timeouts propres, réduction des retries bloquants trop longs.
- N'améliore pas la pensée du modèle, mais réduit le temps perdu autour de l'appel.

3. UX anti-latence côté front
- Annulation agressive des requêtes obsolètes, debounce des envois, affichage immédiat réponse en cours.
- N'améliore pas le backend brut, mais améliore fortement la sensation de vitesse.