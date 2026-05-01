Objectif produit courant
- Nettoyer la terminologie de lib/prompts.js pour aligner le langage interne sur l'architecture actuelle (etats/signaux/decision), et eliminer les residus de l'ancien vocabulaire "mode" quand il designe une decision d'etat.

Analyse ciblee de lib/prompts.js (mode vs etat/signal)

Constat 1 - Dette de nommage structurelle (cles de registry)
- Coexistence de cles heterogenes : MODE_*, STATE_*, ANALYZE_*, EXPLORATION_SUBMODE_*.
- Plusieurs cles MODE_* portent en pratique des etats cibles (ex: MODE_INFORMATION, MODE_INFORMATION_APP, MODE_DISCHARGE) alors que d'autres utilisent deja STATE_* pour la meme couche de decision.
- Exemple incoherent notable : MODE_DISCHARGE contient "Mode CONTACT." (nom de cle et contenu divergent).

Constat 2 - Incoherences dans le texte des prompts d'analyse (couche signaux)
- Plusieurs prompts d'analyse parlent encore de "mode" alors qu'ils produisent des signaux ou des propositions d'etat :
	- ANALYZE_RELANCE : "reponse de mode exploration ordinaire"
	- ANALYZE_RELATIONAL_ADJUSTMENT : "necessitent un mode relational_adjustment"
	- ANALYZE_EXPLORATION_CALIBRATION : "reponse en mode exploration"
	- ANALYZE_THEORETICAL_ORIENTATION : "si le mode n'est pas exploration"
	- ANALYZE_CONTACT : "Ce mode est distinct de la decharge"
- Impact : confusion entre detection (signal), arbitrage (etat), et formulation (writer).

Constat 3 - Incoherences dans les prompts de formulation (writer)
- Nombreux en-tetes "Mode ..." dans des prompts qui servent en realite a formuler un etat arbitre (ex: STABILISATION, CLOTURE, RUPTURE D'ALLIANCE, CONTACT, INFO_*).
- Incoherence interne sur le champ info :
	- ANALYZE_INFO_SIGNAL renvoie detectedState = info_pure|info_features|info_psychoeducation
	- mais registry garde des artefacts MODE_INFORMATION_APP et MODE_INFORMATION_APP_THEORETICAL_MODEL en parallele de STATE_INFO_*.
- Presence de doublons semantiques probables entre MODE_INFORMATION_APP / MODE_INFORMATION / STATE_INFO_FEATURES / STATE_INFO_PSYCHOEDUCATION.

Constat 4 - Incoherences dans commentaires et sections
- Plusieurs blocs de commentaires gardent le framing "GESTION DU MODE ..." et "PROMPT COMMUN A TOUS LES MODES".
- Cela entretient une couche conceptuelle legacy dans un fichier deja migre partiellement vers "state".

Constat 5 - Risque fonctionnel associe
- Le risque principal n'est pas la sortie utilisateur immediate, mais la maintenance : reintroduction facile de logique de decision dans la couche writer faute de vocabulaire net.
- Le melange mode/etat/signal augmente le risque d'erreurs lors des prochains refactors (mauvais prompt selectionne, champ de contrat mal interprete, debug plus difficile a lire).

Cartographie de dette (priorite de nettoyage)
- Priorite P1 (haute, sans changement comportemental attendu)
	- Uniformiser les labels textuels des prompts d'analyse pour parler de signaux/proposition d'etat, jamais de "mode".
	- Aligner les en-tetes writer sur "Etat ..." quand il s'agit d'un etat arbitre.
	- Corriger les incoherences nom/contenu flagrantes (ex: MODE_DISCHARGE vs "Mode CONTACT").
- Priorite P2 (haute, avec verification de routage)
	- Rationaliser les cles registry legacy MODE_* vers STATE_* + alias de compatibilite temporaire si necessaire.
	- Supprimer les doublons semantiques des prompts info apres verification des appels effectifs.
- Priorite P3 (moyenne)
	- Harmoniser les commentaires de section (remplacer "mode" par "etat"/"signal" selon la couche).
	- Clarifier "sous-mode" vs "substate" vs "signal" la ou utile.

Decisions deja prises
- Le nettoyage vise d'abord la coherence terminologique et structurelle, sans modification intentionnelle du comportement conversationnel.
- La priorite est la separation nette des couches : analyseurs (signaux), arbitrage (etat), writer (formulation d'un contrat deja decide).
- Le traitement se fera de maniere incrementale pour limiter le risque de regression.

Validation attendue
- Valider la strategie de migration suivante avant implementation :
	- Etape A : harmonisation textuelle interne (prompts et commentaires)
	- Etape B : alignement des noms de cles (MODE_* -> STATE_*), avec compatibilite transitoire si necessaire
	- Etape C : suppression des doublons info non references

Questions ouvertes
- Souhaite-tu un nettoyage strictement cosmetique dans un premier patch (textes + commentaires), ou un nettoyage complet incluant renommage des cles exportees dans la meme passe ?
- Veux-tu conserver le terme "sous-mode" pour l'exploration/contact, ou le remplacer aussi par "sous-etat" pour coherence totale ?
# plan.md
