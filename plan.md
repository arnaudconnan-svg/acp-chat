1. [OK] Paralléliser tout ce qui ne décide pas la sécurité
- nalyzeClosureIntent intégré dans le Promise.all de la Phase 2 (commit c5f594c).
- Audit complet : c'était le seul analyseur encore séquentiel candidat. Architecture Phase 2 maintenant pleinement parallélisée.

2. Sortir davantage de post-traitements hors chemin critique
- Déjà fait pour le titre.
- Autres tâches purement administratives qui n'influencent pas le texte renvoyé au user.

3. Optimisations réseau/API «invisibles»
- Keep-alive/connexion persistante optimisée, timeouts propres, réduction des retries bloquants trop longs.
- N'améliore pas la «pensée» du modèle, mais réduit le temps perdu autour de l'appel.

4. UX anti-latence côté front
- Annulation agressive des requêtes obsolètes, debounce des envois, affichage immédiat «réponse en cours».
- N'améliore pas le backend brut, mais améliore fortement la sensation de vitesse.