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
- **Pistes deja essayees sur la biometrie native**
  - GateActivity sert de point d'entree natif pour l'ouverture launcher et la relance depuis une entree deja ouverte.
  - La relance web Recents a ete neutralisee temporairement pour isoler le conflit launcher/Recents.
  - BiometricActivity couvre encore les retours foreground et les liens de relock web, avec fail-close en cas d'interruption.
  - Le sous-texte Confidentialite signale maintenant que certains appareils peuvent mal gerer le retour biometrie dans une app deja ouverte.
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

## Repere pour l'agent
- Cette trace sert de memoire de travail a l'agent, pas au cadrage produit pour l'utilisateur.
- Avant tout nouveau patch biometrie/Recents, verifier si l'hypothese a deja ete testee ou invalidee.
- Pour chaque nouvel essai utile, noter en une ligne: hypothese, fichier touche, resultat observe, et critere d'abandon.
- Essai Recents natif en cours: LauncherActivity.onUserLeaveHint() pousse GateActivity avec relock force via un extra dedie.
- Ne pas retenter deux fois la meme hypothese sans nouvelle observation terrain.
- Si un essai corrige Launcher mais degrade Recents ou l'inverse, l'indiquer explicitement avant d'aller plus loin.
