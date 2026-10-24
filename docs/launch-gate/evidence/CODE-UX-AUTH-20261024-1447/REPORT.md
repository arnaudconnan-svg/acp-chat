# CODE-UX-AUTH-20261024-1447 — qualification synthétique

Base fraîche : `285f55f7558a9372f62a32e78bafb2852a363337` (PR41).
SHA technique testé : `682a474b0fec2a1a8420d72e88d34c9ac51bde3a`.
Branche : `code-ux-auth-20261024-1447`, destination exclusivement `beta`.
Fenêtre inchangée : deadline 2026-10-24 13:47:40 UTC ; arrêt pour revue Work après PR non fusionnée.

## Résultat et corrections

Deux bugs reproduits ; aucune correction serveur ou dépendance déclarée.

1. **Expiration visible périmée.** Une autorisation arrivée à échéance conservait le libellé « Autorisation active » tant que la page restait ouverte. Assertion rouge : `expiry-red.json` et `expiry-red-render.json`, code 1 ; capture `consent-red-renders/desktop-expiry-observed.png`. Le libellé est désormais recalculé à l'échéance, sans recharger les champs ni effacer les choix non enregistrés. Le timer est borné à la durée maximale supportée par le navigateur et réarmé pour les échéances plus longues ; une carte retirée du DOM n'est pas réarmée. Il ne change aucun grant ni permission.
2. **Débordement mobile de la portée.** Sur viewport 390 px, sélecteur x=37, largeur=343, bord droit=380 ; carte x=16, largeur=358, bord droit=374 : dépassement de 6 px. Rouge `scope-layout-probe.json`, code 1, capture `consent-layout-red-renders/mobile-selected.png`. `max-width:100%` borne ce seul contrôle à sa carte ; assertion géométrique verte desktop/mobile.

Diff applicatif : `public/js/content-grants.js`, 17 ajouts/3 retraits. Deux fichiers d'outillage : extension du Playwright admin existant et nouveau parcours navigateur du vrai compte avec broker API M0 gardé. Diff complet dans `technical.diff`.

## Qualification et limites

**Admin desktop/mobile :** motif visible, modifiable, réutilisé liste→conversation→retour/reload ; levée→rafraîchissement applicatif→remasquage ; motifs contrôlés sur chaque requête interceptée ; DOM et stockages sans nom/email/ID après remasquage ; futures requêtes sans header de levée ; réponse retardée, 401/403/500/erreur réseau, reset, changement de session, déconnexion depuis pros, expiration à 10 minutes. Le rendu utilise les vrais fichiers HTML/JS ; les réponses admin sont des fixtures interceptées. Le refresh est déclenché par l'événement applicatif existant, pas par un bouton inventé. Les contrôles serveur de raisons/audit/rôles et révocation sont également exécutés dans les harnesses M0 existants (`candidate-targeted.stdout`).

**Praticien desktop/mobile :** vraie `account.html`, vrais fichiers JS et vraies routes Express via `scripts/synthetic/runtime.cjs`. Zéro praticien : accès fermé/boutons désactivés. Un éligible : choix public uniquement ; aucune conversation privée/étrangère. Date invalide et sélection vide refusées ; sélection explicite et consentement synthèse transmis ; autorisation persistée dans le double puis relue après navigation. Portée période restaurée avec synthèse désactivée et choix de conversations désactivés. Refus 403 injecté : pas de mutation ni incrément de version ; révocation persistée ; expiration sans reload et après reload ; perte d'affectation : autoriser désactivé, révocation encore accessible. Le timer d'expiration préserve les saisies non enregistrées. Les protections réelles de rôles/grants/identité/audit sont exercées en complément par `professional-harness.cjs`, `object-private-harness.cjs`, `log-projection-harness.cjs` et `consent-ui-harness.cjs`.

**Isolation :** parent navigateur sous `env -i`, contexte Chromium neuf, toutes requêtes de page interceptées, origine synthétique unique, service workers bloqués pour le nouveau parcours. Broker séparé avec `guard.cjs` préchargé, environnement minimal, base en mémoire, transport Express sans socket en écoute. Aucun Firebase partagé, SMTP/Mistral réel, session personnelle ou compte/grant réel. L'expiration serveur du scénario est injectée uniquement dans le double ; le temps du navigateur est avancé avec Playwright Clock.

Ce résultat est une qualification hermétique rendue, **pas un E2E authentifié de beta déployée**. Aucun compte technique déployé autorisé n'a été utilisé ; aucun PASS graphique Chat ni validation Work déduit. Les captures de carte sont des captures du vrai composant dans la vraie page compte, pas une reconstruction. La validation graphique finale appartient à Work sur la candidate exacte.

## Contrôles sur le SHA technique

| Preuve brute (argv, UTC, code, hashes adjacents) | Code |
| --- | --- |
| `candidate-admin-browser.json` : Chromium desktop/mobile, admin étendu | 0 |
| `candidate-consent-browser.json` : Chromium desktop/mobile, compte et API M0 | 0 |
| `candidate-targeted.json` : syntaxe serveur/front/harness ; admin-review, consent-ui, professional, isolation, object-private, log-projection | 0 |
| `candidate-lint.json` : ESLint des trois fichiers techniques modifiés | 0 |
| `candidate-verify.json` : `npm run verify`, env-i et garde M0 | 0 |

Node **22.23.4**, Chromium **154.0.8037.57** ; autres versions et empreintes dans `physical-receipt.stdout` et `receipt.json`. Les avertissements router Promise-like restent visibles dans stderr. Le succès local ne prétend pas établir un statut CI global.

Échecs conservés, non masqués : lancement Chromium initial refusé par `setsockopt EPERM` (`baseline-admin-browser`, code 1), puis même harness réussi avec permission native ponctuelle ; `baseline-verify` code 127 (PATH npm absent), puis `baseline-verify-node22` code 1 (node_modules du checkout froid, body-parser 2.2.2 installé au lieu de 2.4.0 verrouillé). `npm ci --ignore-scripts --no-audit --no-fund` a restauré le lockfile bêta existant, sans modifier package.json/package-lock.json ; ensuite verify passe. `consent-browser-red` est un défaut de format datetime du harness, pas un bug produit. `targeted-lint` expose les imports/globals manquants du nouveau harness, corrigés. `technical-consent-browser` conserve une assertion Playwright inadaptée à fieldset : remplacée par sa propriété DOM `disabled`, sans correction produit associée. Les deux vrais rouges produits sont identifiés séparément ci-dessus. Aucun rouge historique des PR31–41 n'a été supprimé ou requalifié.

## Précontrôle et livraison

Origine exacte vérifiée : `https://github.com/arnaudconnan-svg/acp-chat.git`. Checkout froid propre à `11a41e9…`, uniquement `origin/main` disponible ; aucune édition sur cette base. Deux fetchs ordinaires code 128 (proxy 8080 inaccessible). L'unique `git fetch origin beta` avec escalation native autorisée a réussi, code 0 : `From https://github.com/arnaudconnan-svg/acp-chat`, `* branch beta -> FETCH_HEAD`. Son SHA est exactement la base attendue. Le refspec existant ne suivant que main, `origin/beta` a été matérialisé localement sur ce résultat frais, puis la branche de tâche a été créée dessus : HEAD initial de travail = origin/beta = 285f55f… ; arbre propre avant édition. Aucun changement de refspec, proxy, domaine, politique réseau, environnement ou acteur. AGENTS/WORKFLOW/PROMPTING actifs et ARCHITECTURE lus ; aucun AGENTS imbriqué dans le dépôt.

Publication autorisée : branche et PR vers beta **non fusionnée**, puis STOP revue Work. Main/prod inchangées ; aucun déploiement. En cas de besoin après validation/fusion future, rollback par une nouvelle PR vers beta portant uniquement le retrait du changement applicatif de cette livraison ; aucun reset/force-push/purge. Ce rapport n'autorise pas de fusion.

Les fichiers `candidate-*.json` enregistrent les commandes réellement exécutées, UTC début/fin, codes et SHA256 des stdout/stderr. `record.py` est le collecteur utilisé ; `receipt.json` contient un reçu compact des fichiers utiles, pas un manifeste du dépôt. Les fichiers temporaires Node/cache restent hors livraison Git. Le commit suivant contient seulement ces preuves ; ses fichiers techniques sont identiques au SHA testé ci-dessus.
