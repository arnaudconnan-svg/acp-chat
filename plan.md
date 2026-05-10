# Plan courant

## Objectif produit courant
Stabiliser et enrichir l'experience Android TWA pour un usage mobile fluide, fiable et discret, avec priorite a l'acces rapide au chat et a la securite d'usage.

## Decisions deja prises
- **Biometric lock V1 + V2**: Implementation complete
  - V1: Verouillage biometrique optionnel, configurable dans "Confidentialite" (sous-ecran account.html)
  - V2: Validation de session serveur avec tokens court-terme, invalidation au masquage de l'app, FLAG_SECURE applique par defaut (desactiv captures d'ecran + apercu multitache)
  - Preferences stockees: biometricLockEnabled, biometricRelockSeconds (0, 30, 120, 300s), screenCaptureEnabled (defaut false)
  - Endpoints: POST /api/biometric/unlock-token (TTL 10min), POST /api/biometric/lock (invalidation)
  - Android: FLAG_SECURE applique dans LauncherActivity.onCreate(), persist via apply-android-customizations.js
- Ajouter un raccourci Android base sur deep link pour demarrer une nouvelle session directement dans le chat, en evitant les ecrans d'accueil et conversations.
- Verifier les messages actuels "verifie ta connexion" avec une gestion reseau native legere, pour n'afficher ce message que si la cause est bien reseau.
- Evaluer le remplacement des numeros d'urgence locaux par un bouton d'urgence natif.

## Validation attendue
- Validation produit du comportement visible pour chaque axe avant generalisation.
- Verification Android locale: build release, lancement, parcours "nouvelle session directe", portrait lock, verouillage biometrique + screenshot prevention, comportement offline.
- Verification UX: aucune friction supplementaire sur entree dans le chat, et mode discret coherent (FLAG_SECURE empoche captures).
- Test réseau biometric lock: token invalidation sur app hide (visibilitychange), /chat rejects sans token valide si biometric enabled.

## Questions ouvertes
- Bouton d'urgence natif: remplace totalement les numeros locaux ou coexiste avec une option de fallback?
- Verrouillage biometrque: demande a chaque ouverture ou seulement apres inactivite? [RESOLU: timer configurable 0/30/120/300s]
- Deep link "nouvelle session": faut-il forcer une session vierge ou reprendre si session active recente?
- Gestion reseau: quels messages existants doivent etre conserves tels quels pour des cas serveur non reseau?
- FLAG_SECURE dynamique: faire evoluer depuis reboot-required vers toggle runtime WindowManager.LayoutParams (native code evolution)
