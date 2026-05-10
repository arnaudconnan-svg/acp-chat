Plusieurs points à travailler :

## Affiliation = lien établi et conséquences :
- je pense qu'on ne peut pas passer l'affiliation à "lien établi" avec une simple occurence > 0.50. Je pense qu'il en faut 3 et qu'il faut assouplir les conditions qui permettent d'abtenir un score > à 0,50. (Réf code : lib/pipeline.js -> computeAffiliationEstablished = Math.max(...window) >= 0.5 ; computeAffiliationTurnDetails).
- me balancer un décentrage émotionnel de but en blanc ne m'a pas aidé à me sentir rejoint et donc à me rejoindre moi-même. Je voudrais donc que l'expression de ce décentrage émotionnel soit conditionné par une affiliation présente. Le décentrage émotionnel serait toujours montré au debug mais marquée non actif car lien n'est pas encore établi. (Réf code : lib/analyzers.js -> analyzeEmotionalDecentering ; lib/pipeline.js -> injection writerIntentHints hold_emotional_thread sans garde affiliation).

## Stagnation :
- il faut aussi faire en sorte que la fenêtre de stagnation ne puisse pas être nourie pas un 1 lors du premier tour. Ça n'a pas de sens. Par ailleurs, "stagnation détectée depuis n tour(s)" ne se met pas à jour et est redondant avec la fenêtre visible dans le debug = à dégager. (Réf code : server.js -> règle forcée "si onGoingMovements est vide" ; public/js/debug-shared.js -> ligne "Stagnation detectee depuis ..." + section Stagnation dans index/admin).

## Priorité somatique :
- "Mais on s'est largement écarté de ce qui m'amenait ici avec mon rêve et je sens que la tension n'a pas bougé" produit une politique somatique parfaitement inadaptée puisque la tension décrite est avant tout psychique, pas physique. (Réf code : lib/analyzers.js -> SOMATIC_SIGNAL_PATTERNS contient "tension" ; lib/pipeline.js -> somaticFocusPolicy = prioritize_somatic_proximity ; public/js/debug-shared.js -> traduction "priorite proximite somatique").
- S'il n'existe pas déjà, il faut un analyzer pour infirmer de fausses politiques somatiques. Référence utile : point d'entrée actuel analyzeSomaticSignal dans lib/analyzers.js ; décision en C3 dans lib/pipeline.js (somaticFocusPolicy).

## trans-signaux (= Writer ?):
- En lien avec le signal Auto-critique : high (mais ça doit s'adapter à d'autres situations) les formulations du style "Tu es particulièrement dur avec toi là" est maladroite. En communication non violente, on apprend qu'il ne faut pas utiliser le "tu qui tue". Dans ce genre de situations, il faut absolument que le bot parte de ce qu'il perçoit/ "ressent" pour que ça sonne empathique, pas en faire une assertion brutale et froide. (Réf code : contactSelfCriticismLevel issu de lib/analyzers.js ; hints writer dans lib/pipeline.js ; génération finale dans lib/writer.js).

