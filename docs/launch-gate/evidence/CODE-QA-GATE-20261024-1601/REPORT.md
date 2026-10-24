# CODE-QA-GATE-20261024-1601 — harnais Chat hermétique

Base fraîche : `47b049c9bb54dfe462a1e03c87c701e29ce94f64`.
SHA technique réellement testé : `7b27a6796331675af51f993d02030fb5545a4f85`.
Branche : `code-qa-gate-20261024-1601`, PR exclusivement vers `beta`, non fusionnée.
Deadline inchangée : 2026-10-24 15:01:26 UTC ; premier retour visé avant 14:35 UTC.

## Résultat exécutable

Depuis la racine du dépôt, avec les dépendances du lockfile déjà installées et Chromium `/usr/bin/chromium` :

```sh
bash scripts/synthetic/qa-chat-browser.sh
```

Node 22 recommandé. Dans l'environnement utilisé pour cette preuve :

```sh
PATH=/workspace/work/CODE-UX-AUTH-20261024-1447/ux-auth/package/bin:/usr/bin:/bin \
QA_CHAT_OUTPUT=/tmp/qa-chat-renders \
bash scripts/synthetic/qa-chat-browser.sh
```

Le lanceur nettoie l'environnement avec `env -i` et borne le processus à 120 secondes. Il conserve uniquement PATH et la destination des captures synthétiques. Une permission Shell native ponctuelle est nécessaire aux sockets internes de Chromium dans cet environnement ; elle ne change aucune politique, proxy ou destination autorisée.

Trois nouveaux fichiers QA, aucun changement produit :

- `scripts/synthetic/qa-chat-browser.sh` : lanceur borné et environnement nettoyé.
- `scripts/synthetic/qa-chat-browser.cjs` : vrai Chromium, vrais HTML/JS/assets, interception de toutes les requêtes de page et assertions desktop/mobile.
- `scripts/synthetic/qa-chat-worker.cjs` : broker stdio avec la garde M0 existante obligatoirement préchargée, vraies routes Express dans `runtime.cjs`, base en mémoire. Aucun serveur en écoute.

Les fichiers `public/**`, `server.js`, `lib/**`, package.json et package-lock.json sont identiques à la base. Aucun compte Firebase réel, appel SMTP/LLM réel, secret, droit ou configuration de service modifié. Aucun patch produit artificiel.

## Voie réelle recherchée, non établie

Recherche limitée aux références techniques non secrètes déjà autorisées : consignes actives, M1-runbook, M0-M1-operational-checkpoint, configuration et transport Mistral, définitions des routes et du compteur de simulation. Aucun contenu de base, corpus personnel, compte patient ou fichier secret consulté.

`docs/launch-gate/M1-runbook.md` lignes 62–96 décrit une RTDB commune et précise qu'un namespace « beta » n'isole pas un principal Admin partagé. Aucun identifiant QA avec séparation de toutes les données réelles n'a été établi à partir de ces références. Le contexte de runtime de ce fil ne déclare aucune liaison de secret/identité sortante ; cela ne prouve pas l'absence universelle d'un compte externe.

`server.js:96` fige la simulation sur `gpt-4.1`, alors que les modèles Mistral sont configurés séparément (`server.js:393` et suivantes). Aucun plafond réel modèle/appels/tokens/coût avec ledger vérifiable n'est établi. `totalSimulatedEur` ne sert donc pas de budget API. Aucune inscription sur la base commune, ni appel fournisseur réel lancé. **Coût fournisseur réel de ce harnais : 0 ; budget API réel disponible : non établi.** Le quota Codex n'est pas un plafond Mistral.

## Ce qui est vérifié

Desktop 1365×900 et mobile 390×844, contextes neufs :

1. `/chat` sans authentification refuse 401. Le vrai pont de lancement envoie vers le vrai `auth.html`. Identifiants synthétiques invalides refusés ; identifiants du seul utilisateur préensemencé en mémoire acceptés par le vrai hash/login. Aucune route register utilisée. Le cookie synthétique reste dans le worker ; aucun stockage de cookie navigateur ou credential applicatif déployé.
2. Le vrai Chat privé est ouvert par le parcours de lancement existant, sans changer l'auth ni ajouter de bypass. Les headers `x-client-identity`, `x-request-id`, content-type et accept sont relayés aux vraies routes. Un header d'identité étrangère synthétique est refusé 409 par l'API réelle.
3. Le vrai `/chat/stream` produit ready/token/result ; les octets SSE sont décodés du transport HTTP local en mémoire puis relus par le vrai parser navigateur. Réponse synthétique visible, compositeur revenu à Envoyer. Les captures `*-stream-response.png` et `*-stream.sse` en sont les preuves.
4. La vraie entrée « Plus d'options » ouvre le formulaire de relais. Soumission désactivée sans case ; l'API réelle refuse aussi consent=false avec 400. Après consentement explicite, le relais sans SMTP configuré refuse réellement 503 ; l'UI indique que la transmission n'est pas confirmée, sans faux succès. Captures `*-consent-required.png` et `*-relay-unavailable.png`.
5. Refus 503 et erreur réseau injectés : textes français réellement visibles ; aucun renvoi ambigu sur `/chat` JSON. Captures `*-failure-503.png`, `*-failure-network.png`.
6. Le drapeau de streaming est désactivé uniquement dans la configuration du runtime en mémoire du fixture. La vraie route refuse `405 streaming_disabled`, puis le front appelle le vrai `/chat` JSON et affiche la réponse. Capture `*-json-fallback.png`.
7. Vrai logout du worker, puis nouvel envoi : vrai refus 401, identité navigateur invalidée, corps masqué pour ne plus exposer le contenu et futures requêtes utilisateur rejetées avant transport. Capture volontairement masquée `*-auth-invalidated.png`, puis nouvelle entrée redirigée vers le login `*-auth-required-again.png`.
8. Requête de sonde vers une origine `.test` interceptée et bloquée avant toute sortie réseau ; garde M0 HTTP/socket et chargements Firebase/SMTP refusés ; compteur de tentatives du transport fournisseur doublé égal à zéro. Aucun message/conversation privé persisté, même dans le double. Chaque contexte est fermé ; un contexte neuf n'a aucun origin storage ; la base et le cookie du worker sont jetés entre viewports puis le worker est arrêté.

## Limites explicites des doubles

Les analyseurs de sécurité fournissent les signaux fixes H0/N2 afin de sélectionner un chemin applicatif existant et borné, suivant le pattern des harnesses M2. Le writer, ses deux tokens et les mises à jour mémoire sont synthétiques. Ce scénario ne qualifie ni la détection clinique, ni la qualité sémantique du pipeline ordinaire ou d'un modèle réel. Les fixtures sont annoncées dans stdout.

Le flux SSE est rejoué **tamponné**, après exécution de la route réelle ; il valide les événements et le parser/rendu final, pas la cadence réseau progressive, le time-to-first-token ou un Stop pendant des tokens fournisseur en direct. `/chat/progress` est un SSE vide explicitement doublé pour éviter une connexion longue. Les harnesses M2 stream/chat existants apportent des assertions complémentaires de cycle de vie sur doubles, pas un E2E déployé.

Le stockage du front existe pendant le contexte éphémère ; aucun storageState n'est exporté. Seuls les rendus et événements synthétiques nécessaires sont écrits comme preuves. Cette qualification **n'est pas le gate du vrai Chat bêta authentifié sur 47b049…**, ne prouve pas un budget Mistral réel, et n'autorise aucune promotion. La recette graphique Work et les conditions de promotion restent distinctes.

## Commandes, codes, versions et rouges conservés

Toutes les preuves `exact-*` ci-dessous ont été exécutées sur `7b27a6796331675af51f993d02030fb5545a4f85`. Chaque JSON adjacent enregistre argv exact, UTC début/fin, code et SHA256 des stdout/stderr.

| Preuve | Résultat |
| --- | --- |
| `exact-browser.json` : lanceur, deux viewports, vrais fronts/routes et doubles annoncés | 0 |
| `exact-targeted.json` : syntaxe JS/shell, isolation, M2 navigateur/stream/chat | 0 |
| `exact-lint.json` : ESLint des deux nouveaux scripts JS | 0 |
| `exact-verify.json` : npm run verify, env-i, garde M0 | 0 |
| `exact-negative-guard.json` : lancement direct du worker sans garde | 1 attendu, refus avant chargement du runtime |

Node **22.23.4**, Chromium **154.0.8037.57**, Playwright **1.59.1**. Node officiel déjà présent depuis la mission précédente, aucun nouveau téléchargement ou changement de dépendance. L'avertissement router Promise-like est conservé dans stderr. Aucun statut CI global déduit de ces résultats locaux.

Historique conservé : `initial-browser` passe mais ses assertions d'erreur étaient moins fortes ; `extended-browser` code 1 attendait à tort un message générique après 401, alors que la politique existante invalide et masque l'identité. L'assertion a été corrigée pour vérifier cette politique et les futures requêtes bloquées, sans changement produit. `targeted-lint` code 1 signale des globals/imports du harness, corrigés. `missing-guard-negative` et `exact-negative-guard` sont des refus négatifs attendus. Aucun rouge produit masqué ; aucun ancien rapport/rouge PR41/42 modifié.

Les deux captures `*-failure-401.png` sont celles du passage initial, conservées comme traces intermédiaires ; elles ne font pas partie du reçu de qualification du SHA final. Les captures finales pertinentes pour 401 sont `*-auth-invalidated.png` et `*-auth-required-again.png`. Les passages `candidate-*` précèdent la dernière extension de transmission des headers ; seules les commandes `exact-*` qualifient le SHA final cité ci-dessus.

## Précontrôle et remise

Origine exacte `https://github.com/arnaudconnan-svg/acp-chat.git`. Fetch frais natif `git fetch origin beta` code 0, résultat exact 47b049… ; le refspec existant suit seulement main, donc `origin/beta` est matérialisé sur ce résultat frais, sans modifier le refspec. Branche isolée créée sur cette référence ; HEAD initial = origin/beta et checkout propre avant édition. AGENTS/WORKFLOW/PROMPTING relus sur la bêta ; aucun AGENTS imbriqué trouvé. Pas de nouvelle tâche/environnement/identité, ni changement réseau/proxy/domaines. Main `11a41e9ea6765418737ad7f8e2b8a31fe404b9b1` inchangée.

Le commit suivant ajoute seulement ces preuves. `receipt.json` contient les empreintes des trois scripts QA et des sources utiles, ainsi que des captures clés ; aucun manifeste massif du dépôt. `technical.diff` permet la revue intégrale. Branche et PR vers beta non fusionnée, puis **STOP revue Work**. Aucun déploiement ou promotion effectué.
