### Plan de Renforcement 4 Couches (sans Critic) — Anti-régression

## Decisions deja prises :
- Retrait total du Critic apres securisation en amont (pas de mode hybride progressif).
- Main doit etre fast-forwardee sur le dernier commit stable avec Critic present avant le refacto V4.
- Le refacto pipeline V4 (4 couches strictes) se fait sur beta.

## Couche 1 (Noyau déterministe) — Invariants de sortie non négociables :
- Implémenter un validateur déterministe post-génération (sans LLM) pour:
- Respect des interdits du tour (relance, open_question, etc.).
- Respect longueur max par état.
- Respect strict tu/vous.
- Détection/strip des fuites de signaux internes.
- En cas d’échec: rejeter et demander une régénération Writer (pas de réécriture externe).

## Couche 2 (Analyseurs) — Réduire les faux positifs amont :
- Nettoyer les patterns trop larges pour les signaux “théoriques”.
- Conserver les détecteurs déjà utiles et précis (friction explicite + correction subtile déjà renforcée).
- Sortie C2 orientée “contrat actionnable” plutôt que “risque flou”.

## Couche 3 (Arbitrage explicite) — Contrat exécutable et testable :
- Faire porter au contrat tous les invariants de forme et d’interdits.
- Unifier les règles de clôture et de non-réouverture dans le contrat (déjà amorcé côté Writer).
- Ajouter un champ explicite “policyViolationsAreBlocking” pour les états sensibles.
- Couche 4 (Writer piloté) — Qualité native + régénération bornée
Writer produit directement conforme au contrat.
- Si validation C1 échoue: 1 régénération bornée avec rappel contractuel ciblé.
Si second échec: fallback déterministe minimal par état (plutôt qu’un Critic LLM).

## Tests à ajouter avant retrait effectif du Critic :
- Harness “sortie contractuelle” par état: exploration, discharge, info, closure.
- Cas transcript de clôture explicite: interdiction stricte de réouverture non demandée.
- Cas tu/vous: conformité en présence de citations utilisateur.
- Cas “forbidden_relance”: zéro question ouverte si interdite.
- Cas anti-fuite signal: strip garanti sans amputation excessive.
- Dashboard perf: comparaison latence avant/après avec segmentation tours “anciennement critic on/off” via chat-perf-summary.js:1.

## Go/No-Go pour suppression Critic :
- No-Go tant que le validateur déterministe C1 post-génération et la boucle de régénération bornée C4 ne sont pas en place.

## Validation attendue :
- `node --check server.js` passe.
- `npm run verify` passe en entier.
- Les nouveaux tests de sortie contractuelle (interdits, longueur, tu/vous, anti-fuite signal) passent.
- Les cas de cloture explicite ne reouvrent pas la suite sans demande utilisateur.

## Questions ouvertes :
- Format exact du fallback deterministe minimal par etat (1 phrase vs 2-3 phrases selon etat).
- Perimetre initial des interdits bloques en C1 (strict complet vs priorite aux interdits a risque eleve).