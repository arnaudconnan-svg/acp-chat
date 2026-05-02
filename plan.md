1. Optimisations réseau/API invisibles
- Keep-alive/connexion persistante optimisée, timeouts propres, réduction des retries bloquants trop longs.
- N'améliore pas la pensée du modèle, mais réduit le temps perdu autour de l'appel.

2. UX anti-latence côté front
- Annulation agressive des requêtes obsolètes, debounce des envois, affichage immédiat réponse en cours.
- N'améliore pas le backend brut, mais améliore fortement la sensation de vitesse.