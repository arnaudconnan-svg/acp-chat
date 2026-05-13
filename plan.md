# Plan de test assisté — Facilitat.io

## Objectif

Utiliser `PERSONAS.md` pour produire des tests ciblés de Facilitat.io, sans chercher à valider le produit globalement.

Le but n’est pas de savoir si l’app est “bonne”, mais de repérer :

- les réponses franchement à côté ;
- les mauvais déclenchements de mode ;
- les moments où le bot coupe trop tôt le processus ;
- les moments où il plaque trop le modèle ;
- les moments où il confronte de façon juste, ferme et calme ;
- les moments où il devient plat, prudent ou incohérent.

## Principe général

Chaque test doit être court.

Ne pas générer de longues conversations libres.

Format recommandé :

- 1 persona ;
- 1 situation précise ;
- 1 axe de stress-test ;
- 3 à 8 messages utilisateur maximum ;
- récupération du transcript complet ;
- récupération des logs/debug si disponibles.

## Rôle de Copilot / Agent IA

Copilot doit jouer un utilisateur simulé à partir d’une persona du fichier `PERSONAS.md`.

Il ne doit pas jouer un utilisateur générique.

Il doit respecter :

- le contexte de vie ;
- le style d’expression ;
- les dynamiques internes ;
- les comportements en interaction ;
- les signaux naturels indiqués dans la fiche.

Le testeur IA ne doit pas chercher à aider Facilitat.io.

Il doit simplement simuler un usage plausible, avec les réactions naturelles de la persona.

## Catégories de tests prioritaires

### 1. Pré-contact émotionnel

But : vérifier que le mode CONTACT ne se déclenche pas trop tôt.

À tester :

- envie de pleurer ;
- quelque chose qui monte ;
- tension entre analyse et émotion ;
- émotion approchée mais pas encore vécue pleinement.

Résultat attendu :

- Facilitat.io reste actif ;
- ne disparaît pas prématurément ;
- maintient une exploration vivante ;
- n’étouffe pas la montée.

### 2. Rationalisation / mentalisation

But : vérifier que le bot ne reste pas trop mou face au mental.

À tester :

- longues analyses ;
- explications très construites ;
- compréhension intellectuelle sans mouvement émotionnel ;
- “je comprends tout mais rien ne bouge”.

Résultat attendu :

- le bot ne se contente pas de reformuler ;
- il introduit une tension ;
- il ramène vers l’expérience ;
- il reste ferme sans devenir prescriptif.

### 3. Rejet d’interprétation

But : vérifier que le bot ajuste sans s’écraser ni se défendre.

À tester :

- “non, ce n’est pas ça” ;
- “tu plaques quelque chose” ;
- “ce n’est pas ce que je ressens” ;
- “tu vas trop vite”.

Résultat attendu :

- le bot ne justifie pas son interprétation ;
- il n’abandonne pas totalement la zone de tension ;
- il ajuste la formulation ;
- il reste proche du phénomène observable.

### 4. Débordement réel / CONTACT

But : vérifier que CONTACT se déclenche seulement quand le processus se vit vraiment.

À tester :

- message fragmenté ;
- pleurs déjà présents ;
- débordement émotionnel ;
- colère directe ;
- perte de structure dans le langage.

Résultat attendu :

- réponse courte ;
- pas d’explication ;
- pas de relance ;
- présence minimale ajustée ;
- pas de disparition prématurée avant le débordement réel.

### 5. Mode INFO

But : vérifier que le bot ne plaque pas le modèle et ne le défend pas trop.

À tester :

- question théorique ;
- comparaison avec une autre approche ;
- objection philosophique ;
- demande d’explication sur une notion.

Résultat attendu :

- réponse claire ;
- pas de défense idéologique ;
- pas de volonté de convaincre ;
- le modèle reste une norme implicite, pas un dogme imposé.

### 6. Mémoire

But : vérifier si la mémoire soutient la continuité sans rigidifier les hypothèses.

À tester :

- reprise après plusieurs messages ;
- rejet d’une interprétation précédente ;
- changement de nuance dans le vécu ;
- retour sur un thème déjà évoqué.

Résultat attendu :

- mémoire utile ;
- pas d’oubli brutal ;
- pas de fixation excessive ;
- pas de transformation d’une hypothèse en vérité stable.

## Format de sortie attendu après chaque test

Pour chaque test, produire un compte rendu court avec :

```markdown
## Test X — [Persona] — [Axe testé]

### Situation de départ
[Décrire la situation simulée en 2-3 lignes]

### Messages utilisateur simulés
[Copier les messages envoyés]

### Réponses de Facilitat.io
[Copier les réponses complètes]

### Logs / debug utiles
[Copier les informations de mode, directivité, mémoire, CONTACT, INFO, etc.]

### Analyse rapide
- Moment juste :
- Moment à côté :
- Mode possiblement mal déclenché :
- Réponse trop plate / trop prudente :
- Réponse trop interprétative :
- Effet global sur l’expérience :

### Verdict
- À garder :
- À surveiller :
- À corriger :