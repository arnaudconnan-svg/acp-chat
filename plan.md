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

## 1. Confidentialité : feedback clair sur les toggles

Fichier probable :
- `public/account.html`

Problème :
Les réglages de confidentialité se sauvegardent trop silencieusement. En cas d’échec, le retour utilisateur est insuffisant.

Objectif UX :
L’utilisateur doit savoir si son réglage est :
- en cours d’enregistrement ;
- enregistré ;
- non enregistré.

Actions :
- Ajouter un micro-état près des réglages sensibles :
  - `Enregistrement…`
  - `Enregistré`
  - `Non enregistré — réessaie`
- Appliquer ce feedback notamment à :
  - conversations privées par défaut ;
  - mémoire / stockage si concerné ;
  - réglages liés au partage ou à la confidentialité.
- En cas d’échec, restaurer l’état précédent seulement avec feedback visible.

Critères d’acceptation :
- Après modification d’un toggle sensible, l’utilisateur voit un retour clair.
- En cas d’échec, le toggle ne donne pas une fausse impression de succès.
- Le feedback reste sobre, non intrusif.

---

## 2. Bouton “descendre en bas” : le rendre moins fugitif

Fichier probable :
- `public/index.html`

Problème :
Le bouton de retour en bas disparaît trop vite dans les conversations longues.

Objectif UX :
Permettre à l’utilisateur de revenir facilement au dernier message sans devoir lutter contre le timing de l’interface.

Actions :
- Identifier la logique d’affichage/disparition du bouton “descendre en bas”.
- Éviter une disparition automatique trop rapide.
- Préférer :
  - bouton visible tant que l’utilisateur n’est pas proche du bas ;
  - disparition uniquement quand l’utilisateur revient effectivement en bas ;
  - ou durée fortement augmentée si la logique actuelle est conservée.

Critères d’acceptation :
- Quand l’utilisateur scrolle vers le haut, le bouton reste disponible.
- Quand l’utilisateur revient en bas, le bouton disparaît.
- Pas d’effet intrusif dans les conversations courtes.

---

## 3. Modales : robustesse petit écran Android

Fichiers probables :
- `public/index.html`
- `public/account.html`
- `public/auth.html` si modales présentes

Problème :
Certaines modales peuvent dépasser l’écran sur mobile, surtout avec clavier ouvert ou viewport court.

Objectif UX :
Toutes les modales doivent rester lisibles et fermables sur téléphone Android.

Action CSS générique à adapter :

```css
.modalBox {
  max-height: calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
}
```

À adapter selon les classes réellement utilisées :
```css
.modalBox
.modal
.dialog
.sheet
```
ou équivalent existant.

Critères d’acceptation :

Une modale longue reste scrollable.
Le bouton de fermeture ou d’action reste accessible.
Aucun contenu critique n’est coupé.
Pas de scroll double excessivement pénible.

---

## 4. Remplacer les alert() / confirm() visibles

Fichiers probables :
`public/index.html`
`public/account.html`
`public/auth.html`

Problème :
Les alertes natives cassent l’expérience visuelle et donnent une impression de prototype technique.

Objectif UX :
Remplacer les alertes natives par des composants existants de l’app : modales, notices, toast sobre, confirmation intégrée.

Actions :
Rechercher :
- alert(
- confirm(
- éventuellement prompt(
Pour chaque occurrence visible utilisateur :
- remplacer par une modale ou notice existante ;
- garder le wording court ;
- conserver le comportement fonctionnel.

Ne pas toucher aux logs console dev.

Critères d’acceptation :

Aucun alert() / confirm() visible dans les parcours alpha principaux.
Les confirmations destructrices restent explicites.
L’esthétique reste cohérente avec l’app.

---

## 5. Feedback développeur : ne pas cocher l’envoi par défaut

Fichier probable :
`public/index.html`

Problème :
Dans le modal de feedback, la transmission au développeur est cochée par défaut. Pour une app d’exploration intime, ce default peut être perçu comme trop intrusif.

Objectif UX :
Rendre le partage avec le développeur explicitement choisi par l’utilisateur.

Actions :
Identifier le checkbox/toggle d’envoi au développeur.
Le décocher par défaut.

Ajouter une microcopy sobre si nécessaire :
Inclure cet échange dans le retour envoyé au développeur
ou Autoriser l’envoi du contenu utile au diagnostic
Conserver la confirmation renforcée si la conversation est privée.

Critères d’acceptation :
Par défaut, aucun contenu sensible n’est envoyé sans action explicite.
L’utilisateur comprend ce qu’il partage.
Le feedback reste possible sans friction excessive.

---

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

## 7. Bouton stop : synchroniser l’accessibilité

Fichier probable :
`public/index.html`

Problème :
Le bouton d’envoi se transforme visuellement en stop pendant la génération, mais son aria-label peut rester “Envoyer”.

Objectif UX :
Aligner état visuel, fonction réelle et accessibilité.

Action JS cible :
```JS
sendBtn.setAttribute(
  "aria-label",
  activeChatRequestId ? "Interrompre la réponse" : "Envoyer"
);
```

À adapter aux noms réels :
sendBtn
activeChatRequestId
ou équivalents existants.

Critères d’acceptation :
Quand le bouton envoie, label = Envoyer.
Quand le bouton interrompt, label = Interrompre la réponse.
Pas de régression sur le fonctionnement du stop.

---

## 8. Nettoyer les chaînes visibles sans accents / trop techniques

Fichiers probables :
`public/index.html`
`public/account.html`
`public/auth.html`
éventuellement `server.js` si messages frontend issus du backend

Problème :
Des messages visibles du type Delai depasse, reponse invalide, developpeur, etc. donnent une impression de prototype.

Objectif UX :
Améliorer la qualité typographique et la perception de finition.

Actions :
Rechercher les chaînes visibles contenant :
- Delai
- reponse
- developpeur
- echec
- connexion
- invalide
- erreur

Ne pas modifier les clés techniques internes si elles ne sont pas visibles.
Corriger uniquement le texte affiché utilisateur.

Utiliser des formulations sobres :
- Délai dépassé
- Réponse invalide
- Développeur
- Échec de connexion
- Une erreur est survenue

Critères d’acceptation :
Les messages visibles sont accentués et lisibles.
Pas de modification des constantes techniques si elles sont utilisées comme clés.
Pas de régression fonctionnelle.


---

## 9. Service worker / PWA : clarifier l’état réel

Fichiers probables :
`public/index.html`
`public/sw.js`
`public/manifest.json`

Problème :
Le service worker existe, mais il faut vérifier s’il est réellement enregistré. Pour une TWA Android, le comportement PWA/cache/update doit être explicite.

Objectif UX :
Éviter des comportements incohérents en alpha : cache périmé, offline bizarre, update non prise en compte, ou service worker présent mais inactif.

Actions :
Vérifier s’il existe un appel :
```JS
navigator.serviceWorker.register(...)
```
Si absent :
décider explicitement si le SW est désactivé pour alpha ;
ou l’enregistrer proprement.
Si présent :
vérifier la stratégie de cache ;
éviter que index.html reste bloqué sur une ancienne version ;
prévoir un mécanisme simple de refresh/update si nécessaire.

Tester :
- première ouverture ;
- reload ;
- mise à jour après déploiement ;
- comportement réseau faible.

Critères d’acceptation :
L’état du service worker est intentionnel.
Pas de version obsolète persistante après déploiement.
Pas d’écran offline inattendu.
Compatible TWA Android.

---

## 10. Suivi support, coûts et identite utilisateur

Objectif : donner à l'admin/SAV un point d'entree simple pour suivre l'etat d'un dossier, son historique de consommation et sa continuité dans le temps.

Contexte d'usage :
- le besoin principal n'est pas de "surveiller les gros utilisateurs", mais de pouvoir répondre vite quand une personne questionne le SAV.
- la liste Coûts doit être accessible depuis le menu 3 points de l'admin, avec un nouvel écran dédié.

Direction produit :
1. Vue admin/SAV orientée recherche d'une personne + fiche détaillée de dossier.
2. Présentation de type liste, cohérente avec la liste des conversations de l'écran principal admin.
3. Tri par défaut par activité la plus récente.
4. Le superId est pertinent dans ce contexte, car il sert de point d'ancrage stable pour le suivi longitudinal du dossier.
5. Cible retenue a terme : identifiant global utilisateur stable + sous-identifiant actif.
6. Le superId doit pouvoir survivre aux resets et aux changements d'identifiant actif.
7. Le reset de compte garde la continuité du dossier : l'etat courant des enveloppes et l'historique cumule de consommation suivent le dossier.

Perimetre :
- ne pas implementer ici une migration globale complexe vers le superId si elle n'est pas nécessaire au patch courant.
- garder cette evolution compatible avec l'ecran Coûts/SAV et les futures vues admin.
- documenter la piste comme chantier dedie ulterieur si la structure doit etre durcie plus tard.

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