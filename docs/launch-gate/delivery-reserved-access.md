# Livraison — accès navigateur ordinaire, 6 octobre 2026

Correctif autorisé depuis `0c65ec1be38451b2e0c66edda43edea42f877843` :
« Accès réservé » ouvre `/auth.html?next=%2F`. Hors Android/pro, la racine
vérifie une session utilisateur fraîche via `/api/auth/session` ; son résultat
serveur valide permet de rester dans l’application. Un cache local authentifié
ne suffit pas. Sans session valide, retour Télécharger, puis connexion existante.
Le démarrage s’arrête après cette redirection. Parcours Android conservé.

Aucun changement backend, rôle, grant ou création de compte. L’ancien login TWA
reste révoqué. Authentification ordinaire sans capacités admin/praticien. Pas de
nouveau verrou global : maintien de l’accès actuel accepté pour les amis informés ;
conditions juridiques déjà identifiées conservées avant ouverture publique future.

Preuves synthétiques : **35 cas navigateur PASS**, dont 7 nouveaux (lien vers auth,
anonyme, valide, invalide, révoquée par authVersion, service indisponible, Android).
Vraies fonctions frontend de login/session/filtre, handlers Express réels sans
listener, cookie signé et base factice ; frontières admin/praticien refusées.
Contrôles M1 identité/professionnels et `npm run verify` PASS, syntaxe et diffcheck
PASS. Garde hermétique versionné ; aucun appel LLM/SDK/service réel. Les suites M2
lifecycle/chat/copies/stream acquises ne sont pas relancées.

Log : `evidence/delivery-reserved-access.log`, SHA256
`0be03d866597fcdbea39c3bba14abd3f8347604fabdabc653e55d3dff6804aea`.
Commandes et empreintes sources : `evidence/delivery-reserved-access.json`.
Les preuves historiques M2 restent attachées à leurs SHA, sans réécriture.
QA graphique et coordination d’arrêt des writers Render restent à Work ; aucune
fusion, bascule ou livraison effectuée par ce correctif. PR28 reste draft.
