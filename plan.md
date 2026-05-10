Plusieurs points à travailler :

## Mémoires :
- stabiliser la mémoire inter-session en la rendant plus fine, à savoir lui permettre de combiner des éléments et d'en séparer d'autres. Typiquement, ici " L'utilisateur a été en couple avec son ex, avec qui il partage la garde de sa grande fille" et "L'utilisateur a une histoire relationnelle marquée par un décalage avec son ex, notamment sur la recherche de légèreté versus profondeur" pourrait être traité différemment, du style "L'utilisateur a eu une relation de couple marquée par un décalage sur la recherche de légèreté vs profondeur" et " L'utilisateur partage la garde de sa grande" voire "L'utilisateur semble avoir plusieurs enfants dont une grande fille dont il partage la garde alternée" si le LLM est capable de l'inférer. Je me rends compte qu'au tour 3 le Contexte stable (session) réussit bien l'exercice d'ailleurs en rassemblant différents éléments (psychothérapie, formation, cabinet) en une phrase cohérente. Je me demande pourquoi la mémoire intersession ne le fait pas. Et aussi, je me pose la question de l'intérêt des sections Patterns récurrents et Liens... (Réf code : lib/memory.js -> updateIntersessionMemory + normalizeIntersessionMemory ; lib/prompts.js -> UPDATE_MEMORY).
- "Mémoire utilisée : tour N-1" dans la section Etat mémoire du débug est redondant. Je veux requestionner l'intérêt même de cette section. Savoir si la mémoire est gardée ou non et pourquoi sachant que désormais elle est toujours gardée, même vide ne fait plus sens pour moi... si on l'enlève, il faudra modifier la logique serveur et le prompting associé, pas uniquement le debug. Par ailleurs, si on décide de garder ce fonctionnement, il n'est pas logique de voir apparaître "Décision mémoire : hold" au tour N alors que le tour N+1 renvoit une mémoire modifiée. Soit le 1er tour ne renvoit pas cette info, soit il le fait en parlant de la mémoire du tour N qui va être affichée au prochain tour. (Réf code : server.js -> postureDecision.memoryUpdateDecision + const memoryAge = newMemory ? 1 : 0 + commentaire N-1/background ; public/js/debug-shared.js -> buildMemoryRewriteIntentLines).
- Il faut renommer la section suivante "Mémoire [session] utilisée pour ce tour" pour que j'ai en tête dans plusieurs mois que d'autres mémoires sont à l'oeuvre également. Pas ailleurs, au démarrage, la mémoire affichée est un reliquat d'une très ancienne version de la mémoire qui doit disparaître du code :
```
Themes deja evoques :
- 

Points de vigilance relationnels :
- 

Questions encore ouvertes :
-
```
au profit de la nouvelle structure :
```
Contexte stable (session)
- 

Mouvements en cours
- 

Mouvements anciens
- 

Signaux du tour précédent (déterministes)
{}
```
- (Réf code : public/index.html + public/admin.html -> titre "Mémoire utilisée pour ce tour" ; public/js/conversation-data.js -> defaultMemory() legacy "Themes deja evoques..." ; public/index.html + public/admin.html -> bloc "Mémoire structurée (4 blocs)").
- il faut mettre une laisse au LLM d'onGoingMovements qui est **BEAUCOUP** trop bavard !!! Les coûts en tokens vont exploser là sinon sachant qu'on garde tout en ancientMovements ensuite... Il faut retirer la structure avec Manifestations, trajectoire, points d'appui. Il faut aussi revoir le prompt UPDATE-MEMORY pour le rendre moins "intelligent" et plus factuel, plus à réfléchir depuis le modèle théorique (garder les termes interdits et la non agentivité par contre, ajouter "latent" au termes formellement interdits trop connoté psychanialyse), peut-être même passer sur un modèle LLM plus basique. A la fin, il faut des items très courts, une seule phrase, une ligne dans l'idéal, jamais plus de 2. Règle : moins intelligent dans la verbosité, plus efficace dans le choix et l'écriture des items. (Réf code : lib/prompts.js -> UPDATE_MEMORY ; lib/debugmeta.js -> normalizeMemoryState (onGoingMovements/ancientMovements) ; server.js -> mergeMemoryStateWithFinalizedText).
- les signaux du tour précédents doivent apparaître en langage naturel en français. Mettre "updatedAt": "2026-05-10T06:35:12.362Z" n'a aucun intérêt ni faire apparaître des signaux false ou low. (Réf code : public/index.html + public/admin.html -> rendu "Signaux du tour précédent (déterministes)" via JSON.stringify ; public/js/debug-shared.js -> traduction/normalisation debug).
- il me faut un bouton dans admin.html qui déplie tous les chips "Afficher 10 de plus" pour que je puisse copier coller l'intégralité d'une conversation en une seule fois et surveiller les suppression d'anciens items avec toi. (Réf code : public/admin.html -> showMoreBtn "Afficher 10 de plus" ; même logique aussi dans public/index.html).

Décisions patch 1 (affichage/debug mémoire) :
- supprimer complètement la section "État mémoire" dans index + admin, et supprimer les champs debugMeta associés non utilisés ailleurs.
- ne pas traiter "Raison arbitrage" dans ce patch (patch séparé).
- renommer "Mémoire utilisée pour ce tour" en "Mémoire session utilisée pour ce tour".
- remplacer le fallback mémoire legacy (Themes/Points de vigilance/Questions) par la structure 4 blocs.
- simplifier "Signaux du tour précédent (déterministes)" en "Signaux du tour précédent".
- rendre les signaux passés en français naturel, actifs uniquement :
	- "Décharge agressive sur le bot" (true)
	- "Décentrage émotionnel actif" (true)
	- "Stagnation détectée (n tour(s))" (si > 0)
	- "Risque de dépendance (modéré/élevé)" (si medium/high)
	- sinon "(vide)"
- admin uniquement : ajouter un bouton global sous le bouton debug, libellé toggle
	"Déplier toute la mémoire" <-> "Replier toute la mémoire", appliqué à toute la conversation.
- admin : laisser "Mémoire réécrite" déplié par défaut.

## Affiliation = lien établi et conséquences :
- je pense qu'on ne peut pas passer l'affiliation à "lien établi" avec une simple occurence > 0.50. Je pense qu'il en faut 3 et qu'il faut assouplir les conditions qui permettent d'abtenir un score > à 0,50. (Réf code : lib/pipeline.js -> computeAffiliationEstablished = Math.max(...window) >= 0.5 ; computeAffiliationTurnDetails).
- me balancer un décentrage émotionnel de but en blanc ne m'a pas aidé à me sentir rejoint et donc à me rejoindre moi-même. Je voudrais donc que l'expression de ce décentrage émotionnel soit conditionné par une affiliation présente. Le décentrage émotionnel serait toujours montré au debug mais marquée non actif car lien n'est pas encore établi. (Réf code : lib/analyzers.js -> analyzeEmotionalDecentering ; lib/pipeline.js -> injection writerIntentHints hold_emotional_thread sans garde affiliation).

## Autres signaux :
- il faut aussi faire en sorte que la fenêtre de stagnation ne puisse pas être nourie pas un 1 lors du premier tour. Ça n'a pas de sens. Par ailleurs, "stagnation détectée depuis n tour(s)" ne se met pas à jour et est redondant avec la fenêtre visible dans le debug = à dégager. (Réf code : server.js -> règle forcée "si onGoingMovements est vide" ; public/js/debug-shared.js -> ligne "Stagnation detectee depuis ..." + section Stagnation dans index/admin).
- dans la réponse "10/05/2026 08:58:59 • assistant", il aurait du y avoir un réajustement sobre lié à "quand tu dis" et expressions apparentées. Là, je ne me suis pas senti suffisamment rejoint dans mon sentiment d'être jugé, même si dans le fond c'est moi qui me jugeais. les utilisateurs ne feront pas forcéement la différence en fonction de leur niveau de conscience de soi. (Réf code : lib/analyzers.js -> hasExplicitRelationalFriction patterns ; lib/pipeline.js -> needsSoberReadjustment selon relationalFrictionSignal).
- idem dans la réponse "10/05/2026 09:03:39 • assistant" où il y a un "!" qui devrait lancer une analyse en lien avec un risque de mauvaise interprétation ou de rupture relationnelle. (Réf code : lib/analyzers.js -> pré-gate regex dans hasExplicitRelationalFriction et analyzeInterpretationRejection).
- idem dans "10/05/2026 09:13:29 • assistant" avec mon "mais" qui aurait dû déclenché un rejet d'interprétation clair. (Réf code : lib/analyzers.js -> REJECTION_CANDIDATE_PATTERNS n'inclut pas ce marqueur seul).
- idem avec "Mais on s'est largement écarté de ce qui m'amenait ici avec mon rêve et je sens que la tension n'a pas bougé" qui est vraiment le genre de formulation qui devrait forcer une remise en question du bot et qui la ne produit absolument rien. **C'est inacceptable pour mon produit.** (Réf code : lib/analyzers.js -> pré-gate avant LLM pour friction/rejet).
- en fait si, ça produit une politique somatique parfaitement inadaptée puisque la tension décrite est avant tout psychique, pas physique. (Réf code : lib/analyzers.js -> SOMATIC_SIGNAL_PATTERNS contient "tension" ; lib/pipeline.js -> somaticFocusPolicy = prioritize_somatic_proximity ; public/js/debug-shared.js -> traduction "priorite proximite somatique").
- S'il n'existe pas déjà, il faut un analyzer pour infirmer de fausses politiques somatiques. Référence utile : point d'entrée actuel analyzeSomaticSignal dans lib/analyzers.js ; décision en C3 dans lib/pipeline.js (somaticFocusPolicy).
- Il ne faut plus que les analyseurs friction/rejet soient pré-gatés par un regex. Tant pis pour les économies. Mainentant qu'on n'a plus de Critic pour corriger, c'est le levier central d'auto-correction du bot. Référence utile : hasExplicitRelationalFriction + analyzeInterpretationRejection dans lib/analyzers.js.
- Raison arbitrage ne me sert à rien. Tu peux carrément le virer. Référence utile : tieBreakReason produit par electActiveStateFromCandidates dans lib/pipeline.js ; affichage dans public/js/debug-shared.js (translateTieBreakReason) + public/index.html + public/admin.html.

## Autres :
- la formulation "Tu es particulièrement dur avec toi là" est maladroite. En communication non violente, on apprend qu'il ne faut pas utiliser le "tu qui tue". Dans ce genre de situations (ici en lien avec le signal Auto-critique : high mais ça doit s'adapter à d'autres situations), il faut absolument que le bot parte de ce qu'il perçoit/ "ressent" pour que ça sonne empathique, pas en faire une assertion brutale et froide. (Réf code : contactSelfCriticismLevel issu de lib/analyzers.js ; hints writer dans lib/pipeline.js ; génération finale dans lib/writer.js).