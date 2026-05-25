Audit pre-alpha pose dans le plan pour reprise inter-session.

Contexte de lecture: audit oriente produit, centré sur l UX percue et sur le backend qui impacte directement cette UX.

Findings prioritaires

- Critique
	- Encodage corrompu des numeros d urgence dans le texte de crise: impact direct en situation sensible.
	- Absence de rate limiting sur l authentification: risque de brute force et de creation abusive de comptes.
	- Memoire des conversations privees perdue au restart serveur: rupture de continuite invisible pour l utilisateur.
- Eleve
	- `isSessionExpired()` retourne toujours faux: l expiration cote UI est neutralisee.
	- `OPENAI_MODEL_MEMORY_UPDATE` par defaut sur `gpt-5` sans verification de disponibilite: risque de memoire qui stagne silencieusement.
	- Cookies de session sans `Secure`: exposition evitable si le transport n est pas strictement HTTPS.
	- Timeout client et serveur desynchronises: attente inutile, consommation de tokens et retour percu comme instable.
- Moyen
	- Messages de fallback techniquement degradés et pas toujours bien accentues.
	- Pas de signal preventif visible avant la limite de quota mensuel.
	- Cache de memoire inter-session cote front fragile au rechargement.
	- Force mot de passe minimale trop faible pour des comptes reels.
	- Pipeline de traitement potentiellement long sur certains tours; a monitorer par timings.
- Faible
	- Titres de conversation et caches locaux: dette acceptable tant que l usage reste pilote.

Plan d action avant alpha

- Must-fix avant alpha
	- Corriger l affichage des numeros d urgence.
	- Ajouter un rate limiting sur `/api/auth/login` et `/api/auth/register`.
	- Rendre l expiration de session front effective.
	- Verifier et stabiliser le modele de mise a jour memoire en production.
	- Ajouter `Secure` aux cookies de session.
- Should-fix rapidement
	- Aligner les timeouts client/serveur.
	- Nettoyer les messages d erreur visibles.
	- Prevenir l utilisateur avant la coupure de quota.
	- Clarifier la promesse de continuite sur les conversations privees.
- Acceptable en dette temporaire
	- Cache inter-session front plus robuste.
	- Renforcement du mot de passe.
	- Bornage du cache local de conversations.
	- Surveillance de la latence du pipeline avant optimisation.

Questions ouvertes bloquantes a reevaluer en nouvelle session

- Promesse produit sur les conversations privees: continuite garantie ou non apres restart.
- Disponibilite reellement exploitee du modele de mise a jour memoire.
- Niveau de quota mensuel acceptable pour l alpha.

Prochaine etape attendue

- Tu me dis quels points on implemente tout de suite.
- Je laisse les sujets necessitant arbitrage produit pour la prochaine session.
