# CODE-UX-ADMIN-20261021-1500 — STEP1

Base beta fraîche/checkout propre : `b745f01c49230b88c42adf8848e353c84c1d1b76`,
remote exact arnaudconnan-svg/acp-chat, consignes AGENTS/WORKFLOW/PROMPTING relues.
Branche isolée `code-ux-admin-20261021-1500`, anciennes branches préservées.
Code final commité AVANT contrôles qualified :
**`e7b03af936713ad8850ef087b09905cfcb99d811`** (après 4a9751c).

## Deux correctifs livrés dans la candidate

1. Levée d'identité : rafraîchissement explicite de la vue courante (liste, ou
branches/messages/mémoire pertinente), requêtes/lectures bornées à 12 secondes.
Remasquage synchrone : suppression des noeuds et handlers porteurs de données,
branches/méta/boutons et références de swipe ; nouvelle génération, annulation des
requêtes en vol, garde avant/après lecture JSON et avant rendu asynchrone.
Futurs headers de levée supprimés, y compris un header fourni par l'appelant.
Refus 401/403, 500, erreur réseau/parsing : pas de révélation, identité remasquée.
La levée ne persiste jamais dans le stockage et repart masquée au rechargement.

2. Motif : sélection courante toujours visible/modifiable ; réutilisation entre
liste/conversation/retour/rechargement, dans le même onglet et une session vérifiée,
pour dix minutes maximum. Motif transmis à CHAQUE requête protégée, indépendamment
de la levée. Reset/déconnexion/nouvelle connexion, autre session, refus d'accès et
expiration suppriment le motif enregistré. Une nouvelle sélection après reset est
réenregistrée seulement après revalidation de session.

`server.js` ajoute uniquement reviewContext à la réponse de session authentifiée :
HMAC lié au cookie de session, non réutilisable pour s'authentifier, sans identifiant
personnel ni cookie exposé. Nécessaire pour ne pas réutiliser un motif d'une autre
session entre pages. Aucun changement des permissions/rôles/grants/audit serveur.
Deux inclusions de professional-review.js dans pros.html/pros-login.html assurent
la purge lors des véritables parcours de déconnexion/connexion, hors page admin.
Autres fichiers : professional-review.js, admin.html, deux nouveaux harnais ciblés,
adaptation du double de session du harnais consent existant. Lock/garde M0 inchangés.

## Vérifications et rendus

Sur code exact ci-dessus : qualified-unit, qualified-browser, qualified-lint,
qualified-professional, qualified-consent, qualified-isolation, qualified-verify :
**codes 0**. Syntaxe serveur/review et trois scripts HTML inline : 0.
Lint ciblé : 0 erreur, onze warnings serveur hérités conservés ; baseline globale
337 erreurs/17 warnings déjà acquise, non rejouée et non présentée comme verte.

Unité sous env-i/M0 : vraies routes Express avec base en mémoire synthétique,
contexte stable pour une session/différent pour une autre, révocation ; motif par
requête, suppression du header injecté par l'appelant, JSON retardé refusé après
remasquage, modification et purge logout. Harnais rôles/grants/consentements/audit
professionnel et consent UI existants : 0. Aucune donnée/provider réel.

Browser Chromium, front réel servi par interception Playwright et APIs doubles
synthétiques, aucune origine externe autorisée : ordinateur 1365×900 ET mobile
390×844. Liste masquée→révélation→navigation conversation→motif conservé/modifié→
remasquage→retour ; réponse tardive ; DOM ET stockage sans marqueur d'identité ;
reload masqué ; 401/403/500/réseau ; reset puis reload avec nouveau motif ; autre
session ; vrai bouton logout de l'espace pro ; horloge avancée de dix minutes.
Les requêtes capturées prouvent le motif sur chaque API protégée.

Dix [captures synthétiques](renders/) : pour chaque format, list-masked,
list-revealed, conversation-reason, race-remasked, expired. Rendus mobile et desktop
inspectés visuellement (lisibilité, panneau replié sur plusieurs lignes sur mobile).

Rouges conservés : premier lancement Chromium refusé par sandbox locale IPC,
puis permission native ponctuelle accordée sans changer les restrictions d'hôtes ;
fixtures corrigées pour la redirection automatique de pros, la destination logout
synthétique et l'installation de l'horloge avant création des timers. Aucun contrôle
retiré pour verdir. Reruns finaux qualified réalisés après le second commit technique.

## Preuves et limites

[Reçu compact](tested-code-receipt.json) : huit fichiers techniques git-show ↔
hashes du checkout testé ; code/base, argv/UTC/codes/hashes stdout/stderr, Node
v24.19.0 et Chromium 154.0.8037.57 observés au reçu, hashes des dix rendus.
Pas de manifeste massif ni lecture corpus/data. proof-check : 0. Commit suivant
preuves seules ; artefacts bruts de contrôles rouges et verts conservés.

Le pilote navigateur s'exécute séparément de M0, dont la garde interdit de lancer
un processus enfant ; Chromium utilise son IPC local et des routes interceptées.
M0 n'est ni modifiée ni affaiblie ; unités/backend/verify tournent sous sa garde.
Aucun serveur applicatif déployé, handshake Firebase, SMTP, Mistral, identité
professionnelle personnelle ou conversation réelle. L'authentification déployée
reste à contrôler par Work avec un compte technique autorisé ; pas de faux E2E live.

PR exclusivement beta NON FUSIONNÉE pour revue indépendante Work. Aucun déploiement,
main/prod/public, nouveau task/env/agent/setup/automation, Drive/mail/notification,
achat/reset ou coût API. Restrictions natives/UNKNOWN conservés sans attestation.
Acquis PR31–38 préservés ; rollback éventuel nouvelle PR beta de cette seule unité,
sans reset/force-push ni revert global. STOP après publication pour revue Work.
