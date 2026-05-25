Session du 25/05/2026 - Points a traiter ensemble

1) Auth - aligner la regle mot de passe a 10 caracteres partout
- Constat: incoherence entre interface (8) et serveur (10).
- Decision: aligner l'interface sur 10 caracteres.
- Scope: public/auth.html (minlength, placeholder, message d'erreur).
- Critere de validation: un mot de passe de 10 caracteres passe sans contradiction UI/API.

2) Raccourcis Android - respecter prive par defaut
- Constat: le raccourci Nouvelle conversation peut contourner le prive par defaut.
- Decision: ajuster le flux shortcut pour respecter la politique prive par defaut.
- Scope: public/manifest.json + logique shortcuts dans public/index.html.
- Critere de validation: un lancement depuis raccourci ne cree plus de conversation non privee involontaire.

3) Jauge d'usage - test perception economique explicite
- Constat: la simulation est presente mais peut etre interpretee comme paiement reel.
- Decision: conserver le test de perception economique, avec wording explicite simulation.
- Scope: public/account.html (label bouton, texte modal, clarte de l'intention), avec correction de microcopie en UI (forme accentuee attendue).
- Critere de validation: aucun doute sur le caractere simule, tout en conservant le test de perception.

5) Dependances CDN markdown/sanitization - fiabilite alpha/TWA
- Constat: index charge markdown-it et DOMPurify via jsDelivr (dependance reseau externe).
- Decision session: garder pour l'alpha immediate, mais tracer la securisation en local comme action a preparer.
- Scope: public/index.html (inventaire des scripts CDN) + preparation d'un passage en assets locaux sans changement de comportement.
- Critere de validation: decision explicite actee; plan de bascule locale pret pour execution.

Hors scope (arbitre):
- Point 4 (bouton prive/long press): comportement voulu, ne pas modifier dans cette session.

Suivi:
- Priorite immediate: points 1 et 2.
- Point 3: a traiter dans la meme session avec validation UX explicite.
