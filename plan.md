# Plan UX avant alpha — Facilitat.io

Objectif : corriger les points UX qui peuvent brouiller la perception de sérieux, de contrôle utilisateur ou de confidentialité avant mise entre les mains des alpha testeurs.

Périmètre strict :
- UX uniquement.
- Ne pas modifier le comportement du bot.
- Ne pas modifier les prompts.
- Ne pas refactorer globalement.
- Patches courts, ciblés, testables.
- Priorité à la stabilité TWA Android.
- Ne pas réouvrir les arbitrages déjà verrouillés.

## 6. Actions conversation : améliorer la découvrabilité

Fichier probable :
`public/index.html`

Problème :
Renommer / supprimer une conversation via swipe ou clic droit est peu découvrable, surtout sur mobile Android.

Objectif UX :
Rendre les actions disponibles sans alourdir l’écran conversations.

Actions :
Hint temporaire après première conversation
Afficher une seule fois un indice sobre :
- Balaye une conversation pour la renommer ou la supprimer.

Critères d’acceptation :
Un alpha testeur peut comprendre comment renommer/supprimer sans explication externe.
Pas de surcharge visuelle majeure.
Les actions destructrices restent confirmées.

---

## Point spécifique — Bouton développeur sur l’accueil

Fichier probable :
`public/index.html`

Problème :
L’accès développeur/admin visible sur l’accueil peut donner une impression d’app en chantier auprès des alpha testeurs.

Objectif UX :
Conserver l’accès dev si nécessaire, sans le laisser polluer l’expérience utilisateur standard.

Options possibles :

**Option A — Masquer hors mode dev explicite**

Principe :
Le bouton dev n’apparaît que si un flag local est actif.

Exemples de flag :
`localStorage.devMode === "1"`
`query param initial : ?dev=1`
combinaison des deux : le query param active le flag local.

Avantages :
Propre pour alpha.
Aucun signe dev visible pour utilisateur standard.
Simple à maintenir.

Inconvénient :
Il faut connaître l’URL ou activer le flag.

Recommandation :
Option la plus propre.

**Option B — Accès dev via geste caché**

Principe :
Accès par long press sur le logo, triple tap sur le titre, ou séquence discrète.

Avantages :
Aucun bouton visible.
Pratique sur mobile.

Inconvénients :
Moins explicite.
Peut devenir fragile ou agaçant si oublié.
Risque de déclenchement accidentel si geste mal choisi.

Usage recommandé :
Uniquement si besoin d’accès dev rapide sur téléphone sans manipuler l’URL.

**Option C — Bouton visible seulement en environnement non-production**

Principe :
Afficher le bouton si l’environnement indique dev/staging.

Exemples :
- hostname local ;
- variable injectée ;
- domaine de staging ;
- flag backend.

Avantages :
Très propre conceptuellement.
Évite les oublis en production.

Inconvénient :
Peut demander une adaptation serveur/déploiement.
Plus lourd qu’un flag local.

Usage recommandé :
Bon choix à moyen terme, pas forcément nécessaire pour alpha immédiate.

**Option D — Déplacer l’accès dev dans le menu ⋮**

Principe :
Ne pas afficher le bouton sur l’accueil, mais ajouter une entrée dans le menu secondaire si mode dev actif.

Avantages :
Moins visible.
Plus cohérent UI.

Inconvénient :
Reste accessible si le menu est visible aux testeurs.
Ne règle pas totalement la pollution UX si l’entrée apparaît par défaut.

Usage recommandé :
Seulement combiné avec Option A ou C.

Recommandation dev button

Implémentation la plus tenable avant alpha :
- Ajouter un flag local devMode.
- Le bouton dev/admin n’est visible que si devMode === "1".
- Prévoir une activation simple via URL :
    - ouvrir l’app avec ?dev=1
    - stocker localStorage.setItem("devMode", "1")
- Prévoir une désactivation :
    - ?dev=0
    - ou bouton interne dev “désactiver mode dev”
- Ne jamais afficher l’accès dev aux alpha testeurs standards.

Critères d’acceptation :
- Sans flag, aucun bouton dev visible sur l’accueil.
- Avec flag, l’accès dev reste disponible.
- Le flag persiste localement.
- Il existe une manière simple de désactiver le mode dev.
- Aucun impact sur les utilisateurs standards.

---

# Règles pour GitHub Copilot

Avant chaque patch :
- Lire le fichier concerné.
- Identifier les fonctions/classes existantes.
- Proposer un diff minimal.
- Ne pas réorganiser le fichier.
- Ne pas renommer les fonctions existantes sauf nécessité.
- Ne pas modifier les prompts.
- Ne pas modifier la logique de génération du bot.
- Ne pas toucher aux routes backend sauf si nécessaire pour un message UX visible.
- Tester mentalement le parcours Android/TWA.

Après chaque patch :
- Vérifier qu’aucun comportement bot n’a changé.
- Vérifier l’écran mobile.
- Vérifier qu’aucune chaîne technique n’apparaît à l’utilisateur.
- Vérifier que l’expérience reste sobre.

Le cœur critique avant alpha, ce n’est pas d’ajouter de l’UX. C’est de retirer les signaux involontaires : paiement ambigu, dev visible, consentement implicite, feedback de confidentialité trop silencieux.