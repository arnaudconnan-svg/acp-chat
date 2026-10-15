# PROMPTING.md — Facilitat.io

Appliquer le [mandat permanent de WORKFLOW.md](WORKFLOW.md#mandat-permanent--autorité-et-limites) pour les autorisations, promotions, tests Mistral, coûts et isolement des données.

## 1. Cadre de travail

Le projet fonctionne avec une asymetrie claire :

- l'utilisateur est expert produit et psychopraticien
- l'agent est le developpeur
- les demandes peuvent etre formulees en langage produit, pas en langage code

Une demande utile peut donc etre de la forme :

- "la reponse semble trop explicative"
- "je veux que l'app tienne plus le contact"
- "on travaille dans de mauvaises conditions, ameliore le cadre technique"

## 2. Comment formuler une demande

Format prefere :

1. objectif ou probleme observe
2. ce qui ne doit pas changer visiblement
3. eventuelle urgence ou priorite

Exemple :

"Quand l'utilisateur refuse de creuser, la reponse relance encore trop. Je veux un mouvement plus sobre sans changer la gestion de crise."

## 3. Ce que l'agent doit comprendre

### Si la demande est technique

Exemples :

- logs
- modularisation
- nettoyage interne
- script de verification

Dans ce cas, l'agent implemente directement puis valide.

### Si la demande change le comportement visible

Exemples :

- ton des reponses
- routing exploration / contact / information
- comportement de crise
- memoire affichee

Dans ce cas, l'agent doit :

1. annoncer le changement en langage produit
2. indiquer le risque principal
3. avancer si cet effet est déjà couvert par l’autorisation produit ; sinon attendre un arbitrage avant codage

## 4. Verification attendue

Pour un changement backend significatif :

1. `node --check server.js`
2. `npm run verify`

Pour un changement sur le pipeline `/chat`, ajouter selon le cas :

- lecture des logs `[PIPELINE]`
- harness comportemental centre sur `debugMeta`
- test manuel cible

## 5. Prompt d'ouverture utile

Quand une nouvelle session commence, lire en priorite :

1. `AGENTS.md`
2. `WORKFLOW.md`
3. `PROMPTING.md`
4. `ARCHITECTURE.md`

Aucun fichier de reprise conversationnelle n’est requis. Vérifier le HEAD initial
égal à `origin/beta` par fetch frais avant mutation, puis suivre le flux de PR vers
`beta` du mandat permanent.

Ensuite seulement, ouvrir le fichier ou la zone qui controle directement le comportement vise.

## 6. Regle pratique

Ne pas demander "quel diff exact faire ?" si le besoin est deja clair.
Il vaut mieux decrire :

- ce qui se passe
- ce qui devrait se passer
- ce qui ne doit pas bouger

L'agent choisit ensuite le moyen technique le plus propre.

## 7. Prompt d'audit architectural (a coller en debut de session d'audit)

Audit strict V4 à quatre couches (contenu des prompts compris) + ecarts critiques + plan priorise + implementation immediate des quick wins techniques non visibles.
Inclure explicitement une section conditions de travail agent : tests manquants, observabilite, protocoles anti-regression, discipline de commit.
Changements visibles permis et souhaites si pertinents, mais sous regle stricte :

- annoncer d'abord effet utilisateur + risque de regression + perimetre impacte
- vérifier que l’effet est couvert par l’autorisation existante
- sinon attendre un arbitrage produit avant de coder

Verifications supplementaires dans l'audit C1/C2 :
Pour chaque etat de CONVERSATION_STATES, verifier qu'il existe au moins un analyseur C2 capable de le declencher en conditions normales (sans intervention manuelle, flag admin, ou override externe). Tout etat non atteignable par analyse per-tour est a signaler comme ecart.

Verifications supplementaires dans l'audit C3 :
Verifier que les champs du return de buildPostureDecision sont nommes comme des decisions (ce que le writer doit faire), pas comme des relais de signaux C2 bruts. Tout champ prefixe is\* ou portant le nom d'un signal C2 est un ecart potentiel a justifier ou corriger.

Verifications supplementaires debug front :
Appliquer les regles de presentation du debug definies dans AGENTS.md §7 ("Regles de presentation du debug front"). Pour chaque champ rendu visible dans le debug de index.html et admin.html, verifier langue, masquage des booleens false, non-redondance, parite admin/index et coherence des noms avec debugmeta.js.

Sortie obligatoire (format fixe) :

- statut par couche : OK / PARTIEL / NON
- ecarts critiques (ordonnes par severite)
- quick wins techniques executes maintenant
- changements visibles proposés et statut de leur autorisation
- actions restantes
- batch suivant
- etat de verification : commandes lancees + resultats
- commit, branche de tâche publiée, PR exclusivement vers `beta`, contrôles et fusion si conforme (ou blocage factuel)
- SHA initial/final, instructions relues sur le SHA intégré et procédure de retour arrière Git
