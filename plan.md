# Plan courant

## Objectif produit courant
Stabiliser et enrichir l'experience Android TWA pour un usage mobile fluide, fiable et discret, avec priorite a l'acces rapide au chat et a la securite d'usage.

## Decisions deja prises
- Mettre en place un verrouillage biométrique optionnel.
- Ajouter un raccourci Android base sur deep link pour demarrer une nouvelle session directement dans le chat, en evitant les ecrans d'accueil et conversations.
- Verifier les messages actuels "verifie ta connexion" avec une gestion reseau native legere, pour n'afficher ce message que si la cause est bien reseau.
- Evaluer le remplacement des numeros d'urgence locaux par un bouton d'urgence natif.
- Masquage multitache toujours actif sur les ecrans de conversation.
- Verrouillage rapide configurable par l'utilisateur (OFF / 1 min / 5 min).
- Protection captures d'ecran desactivee par defaut, mais reactivable par l'utilisateur.

## Validation attendue
- Validation produit du comportement visible pour chaque axe avant generalisation.
- Verification Android locale: build release, lancement, parcours "nouvelle session directe", portrait lock, comportement offline.
- Verification UX: aucune friction supplementaire sur entree dans le chat, et mode discret coherent.

## Questions ouvertes
- Bouton d'urgence natif: remplace totalement les numeros locaux ou coexiste avec une option de fallback?
- Verrouillage biometrque: demande a chaque ouverture ou seulement apres inactivite?
- Deep link "nouvelle session": faut-il forcer une session vierge ou reprendre si session active recente?
- Gestion reseau: quels messages existants doivent etre conserves tels quels pour des cas serveur non reseau?
