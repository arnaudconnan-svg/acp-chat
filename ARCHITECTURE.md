# ARCHITECTURE.md — Facilitat.io

## Objet et perimetre

Ce document decrit les invariants architecturaux durables du runtime actif de
Facilitat.io. Il ne decrit ni un plan de migration, ni le detail des chantiers
passes, ni les regles de travail de l'agent.

L'application est un service conversationnel Node.js/Express. Firebase porte les
donnees persistantes et Mistral les analyses et la generation qui requierent un
LLM. `server.js` expose et orchestre `/chat` (ainsi que son transport streaming),
tandis que `public/index.html` et `public/admin.html` consomment le meme contrat de
conversation et d'observabilite.

## Architecture conversationnelle active

Le runtime applique quatre responsabilites distinctes. Leur separation est une
propriete active du chemin `/chat`, meme si `server.js` conserve l'orchestration
generale.

### 1. Noyau deterministe

Le noyau execute les gardes qui ne peuvent pas etre deleguees a la generation :

- validation et normalisation des entrees et des flags ;
- routage prioritaire de la securite et de la crise, avec sorties anticipees pour
  le risque majeur imminent, la crise suicidaire N2 et son suivi aigu ;
- resolution de l'etat conversationnel, controle des transitions et repli sur
  l'etat precedent lorsqu'une transition est invalide ;
- permissions, interdits et contraintes absolues associes a l'etat ;
- persistance, contrat HTTP et orchestration de la memoire.

Les etats canoniques et leurs transitions sont portes par
`lib/conversation-state.js`. Les variantes etendues (par exemple exploration
ouverte ou retenue, information pure ou fonctionnelle, decharge regulee ou
deregulee) donnent au contrat writer une politique directement applicable.

`lib/runtime-schemas.js` porte aussi des formes minimales partagees par le chemin
actif. La forme de la requete `/chat` est controlee a chaque appel et une requete
invalide est rejetee. Les controles de `stateProposal`, `postureDecision` et
`debugMeta` sont, eux, des diagnostics non bloquants : ils n'emettent des warnings
que lorsque les gardes runtime de developpement sont actives (toujours hors
production, ou explicitement en production). Ils ne constituent donc pas une
validation de production de ces contrats.

### 2. Analyseurs

Apres les analyses de securite, les analyses ordinaires independantes sont
lancees en parallele dans `server.js` au moyen des fonctions de
`lib/analyzers.js`. Elles produisent des signaux structures : candidats d'etat,
alliance, ajustement relationnel, qualite attentionnelle, cloture, dependance,
registre, contexte technique et autres informations necessaires au tour.

Les analyseurs observent et qualifient. Ils ne choisissent pas la reponse finale
et ne formulent pas la politique du writer. Certains analyseurs sont cadences par
des flags persistants plutot qu'executes a chaque tour ; leur derniere valeur
normalisee reste alors disponible pour l'arbitrage.

### 3. Arbitrage explicite

`electActiveStateFromCandidates(...)` elit d'abord le candidat principal issu des
analyses ordinaires. `buildPostureDecision(...)` combine ensuite ce resultat avec
les signaux structurels, l'etat precedent et les gardes deterministes. Il produit
un contrat de posture unique comprenant notamment :

- l'etat demande, l'etat effectif et la validite de la transition ;
- l'intention, les gestes permis, les interdits et la politique de relance ;
- la directivite, le registre d'adresse et l'expression eventuelle de
  l'incertitude ;
- les ajustements relationnels, tensions secondaires et indications de
  formulation actives ou explicitement inactives ;
- la decision semantique d'ouverture vers un soutien humain et sa possibilite
  d'execution technique.

Cette decision est la source de politique du tour normal. Les signaux secondaires
ne remplacent pas l'etat actif : ils peuvent seulement enrichir le contrat selon
les regles d'arbitrage.

### 4. Writer pilote

`generateReply(...)`, cree par `lib/writer.js`, recoit le contrat de posture deja
arbitre, l'historique utile et la memoire disponible. Il transforme ce contrat en
blocs de formulation adaptes a l'etat retenu. Il ne doit ni reclassifier le tour,
ni choisir un autre etat, ni creer une permission, un interdit ou une politique de
relance absents du contrat.

La conformite est preparee en amont par le routage, le contrat de posture et les
contraintes injectees au writer. La reponse generee n'est soumise a aucune passe
LLM de critique, de reecriture ou de regeneration post-generation. Cette absence
de correction aval est egalement necessaire au streaming, a la latence et au cout
du chemin actif.

## Priorites decisionnelles reelles

La priorite globale active est : **securite, puis crise, puis pipeline ordinaire**.
Les deux premieres familles peuvent interrompre le pipeline avant toute generation
ordinaire. Un signal N1, lorsqu'il ne provoque pas une sortie anticipee, force
l'etat effectif de crise N1 dans le contrat.

Dans le pipeline ordinaire, le runtime n'implemente pas une simple liste totale :

1. une decharge active gagne l'election des candidats ordinaires et neutralise le
   signal Contact ;
2. le besoin de soutien lie au risque de dependance prime ensuite sur
   l'exploration, l'information et le retour post-decharge ;
3. l'information et l'exploration sont arbitrees selon leur confiance, avec des
   exceptions deterministes documentees dans le code ;
4. une rupture d'alliance remplace une exploration, mais ne remplace ni une
   decharge ni un etat d'information deja retenu ;
5. la cloture s'applique apres ces choix, sauf en decharge active, rupture
   d'alliance ou besoin de soutien humain.

Il est donc exact que la decharge precede la rupture relationnelle dans le runtime.
La formule d'`AGENTS.md` — **Securite > Crise > Decharge > Rupture relationnelle >
Exploration > Information** — est un ordre produit synthetique, pas une liste
totale implementee litteralement. L'algorithme detaille ci-dessus est la verite du
runtime : confiance, exceptions deterministes et portee limitee de la rupture
determinent l'election effective.

## Ouverture vers un soutien humain

L'analyse d'alliance produit deux decisions distinctes :

- `allianceSignal` et son motif decrivent l'etat de l'alliance avec le bot ;
- `humanSupportProposal` et `humanSupportReason` disent s'il est semantiquement
  pertinent d'ouvrir ce tour vers un soutien humain, independamment d'une rupture
  d'alliance.

Le couple proposition/motif est normalise par `lib/human-support-contract.js`.
Une proposition n'est valide que pour le motif `ai_support_insufficient`; les cas
non indiques et deja abordes possedent leurs motifs compatibles. Une combinaison
invalide revient au choix conservateur `not_indicated`.

Cette decision semantique pilote deux voies qu'il faut garder distinctes :

1. **Ressources relationnelles personnelles qualifiees.** La decision amont
   `humanSupportProposal` determine si le tour doit ouvrir vers l'humain. Quand
   elle vaut `propose`, le writer ne reprend aucune decision de politique : il
   qualifie seulement, parmi les personnes deja etablies par l'utilisateur,
   celles qui constituent reellement des ressources relationnelles et, s'il en
   existe, doit les nommer. Une simple mention dans la memoire ne suffit pas. Leur
   disponibilite, leur pertinence et la qualite actuelle du lien restent
   incertaines ; aucune ressource ne peut etre inventee. En dehors de cette
   decision amont, le writer ne propose pas spontanement un proche memorise, sans
   empecher l'accompagnement d'une relation deja au centre du recit ou d'une envie
   de contact apportee par l'utilisateur.
2. **Accompagnement professionnel Facilitat.io.** La meme ouverture semantique ne
   devient une proposition effective du formulaire professionnel que si le relais
   technique est active (`humanHandoffAvailable`) et que le tour n'est pas dans
   un etat de crise. Le formulaire requiert ensuite le consentement et l'envoi
   explicites de l'utilisateur. Le writer ne promet ni transmission, ni
   interlocuteur, ni rendez-vous, ni delai.

La disponibilite technique du relais professionnel ne decide donc jamais si une
ressource personnelle qualifiee peut etre evoquee. Inversement, une demande
explicite de contact humain ou de contact avec le service est traitee comme telle,
meme lorsque la disponibilite technique n'est pas confirmee ; seule l'annonce de
l'option effectivement disponible est alors interdite.

## Memoire active

La memoire de session est un resume structure et recalcule, pas un journal de la
conversation. Son texte comporte `Contexte stable`, `Mouvements en cours` et
`Anciens mouvements`. Le LLM propose le contenu courant ; le code normalise le
contrat puis gere de facon deterministe les identifiants, transferts, suppressions,
timestamps, archivage et rendu final via `lib/memory.js`.

Le chemin normal suit volontairement cette chronologie :

1. le tour N lit la memoire de session et son etat structures disponibles au debut
   du tour, donc issus de N-1 ;
2. cette memoire alimente les analyses et le writer du tour N ;
3. la reponse retourne la meme version N-1 et `debugMeta.memoryState` expose cet
   etat de debut de tour ;
4. apres la generation, la mise a jour, la fusion et la persistance de la memoire
   s'executent pour N+1 sans etre attendues par la reponse HTTP.

Le decalage d'un tour est un invariant de latence et de robustesse, non une erreur
de synchronisation. La decision active du chemin normal est actuellement une mise
a jour a chaque tour ; son statut commence a `pending`, puis l'audit persiste le
resultat effectif ou l'echec de la tache de fond.

Une memoire inter-session distincte peut aussi etre injectee pour les conversations
authentifiees non privees. Elle ne remplace ni le resume de session ni les regles
de rappel : le routage de rappel decide quelle source est utile au tour.

## Observabilite

`debugMeta`, construit et normalise par `lib/debugmeta.js`, est le contrat
d'observabilite principal. Il accompagne la reponse HTTP et le message assistant
persiste. Il rend notamment visibles :

- securite, crise, etat retenu et transition ;
- signaux d'analyse, arbitrage, interdits et indications writer ;
- decision semantique de soutien humain, motif et execution effective du relais ;
- memoire N-1, decision/motif/source de mise a jour et statut de la tache
  asynchrone ;
- identifiants de trace et timings du pipeline.

Les journaux `pipeline_summary` donnent la vue consolidee des etapes et de leur
latence. Les traces locales de decision completent `debugMeta` sans le remplacer.

La normalisation, les traductions et les constructeurs de sections du debug
frontend sont centralises dans `public/js/debug-shared.js`. Les deux interfaces le
chargent puis ne conservent que leur logique de rendu. `public/index.html` et
`public/admin.html` doivent exposer le meme contenu de debug ; seule la presentation
depliee ou repliable peut differer.

## Frontend et contrat de transport

Le frontend affiche les messages, conserve l'etat local necessaire et transmet a
`/chat` la memoire, son etat structure, les flags, l'historique recent et le
contexte de conversation. Le backend renvoie la reponse, la memoire exposee pour
le tour, les flags, le debug et `debugMeta`.

Le frontend ne redecide ni l'etat conversationnel ni la politique de reponse. Toute
evolution de ce contrat doit rester synchronisee entre le backend, le client
principal et l'interface d'administration.

## Invariants de conservation

- Les chemins de securite suicidaire et de risque majeur imminent ne peuvent pas
  etre conditionnes ou contournes par les analyses ordinaires.
- Une seule decision de posture gouverne chaque generation ordinaire.
- Le writer formule cette decision ; il ne la remplace pas.
- Aucune correction LLM post-generation ne modifie la reponse.
- La memoire de session reste un resume structure, expose a N-1 et actualise en
  arriere-plan pour N+1.
- Decision semantique de soutien, ressources personnelles et disponibilite du
  relais professionnel restent des notions distinctes.
- Le contrat conversationnel et le contrat `debugMeta` restent coherents sur le
  backend, `index.html` et `admin.html`.
