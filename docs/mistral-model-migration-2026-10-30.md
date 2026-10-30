# Migration Mistral du 30 octobre 2026

## Motif et portée

Mistral annonce le retrait de Medium 3.5 au 30 avril 2027. Sa documentation
associe explicitement `mistral-medium-latest` à ce modèle et recommande
`mistral-large-4-0` comme remplacement. Le code utilise cet alias Medium pour
la génération, certaines analyses de sécurité et les deux mémoires.

Cette modification prépare leur migration vers Large 4. Les analyses ordinaires
et les titres conservent `mistral-small-latest`, non concerné par cette annonce.
Les variables `MISTRAL_MODEL_*` restent prioritaires, notamment pour permettre
un retour à la configuration précédente. Aucun remplacement implicite d'une
valeur configurée n'est effectué.

Large 4 accepte `low`, `medium` et `high`, mais pas `none`. Le transport choisit
explicitement `low` pour ses deux identifiants officiels si l'appelant n'a pas
défini d'effort, afin de limiter le calcul de raisonnement et la latence. Ce choix
technique doit être évalué avec le vrai modèle avant activation ; il ne garantit
pas une équivalence comportementale avec Medium. Les autres modèles et les
efforts explicitement fournis restent inchangés.

Le SDK verrouillé `@mistralai/mistralai` 2.6.4 sait sérialiser cet effort et lire
les blocs de réponse documentés ; aucune mise à jour de dépendance n'est requise.
Le transport existant ne transmet que le texte final à l'application. Les traces
de raisonnement ne sont ni ajoutées à la mémoire ni diffusées à l'utilisateur.

## Configuration à appliquer après validation

| Variable                   | Nouvelle valeur               |
| -------------------------- | ----------------------------- |
| `MISTRAL_MODEL_GENERATION` | `mistral-large-4-0`           |
| `MISTRAL_MODEL_MEMORY`     | `mistral-large-4-0`           |
| `MISTRAL_MODEL_ANALYSIS`   | Conserver la valeur existante |
| `MISTRAL_MODEL_TITLE`      | Conserver la valeur existante |

Lire et conserver les deux anciennes valeurs non secrètes dans chaque
environnement avant de modifier quoi que ce soit. Vérifier les éventuels groupes
de variables Render ; une valeur définie sur le service prime sur un groupe.
Modifier seulement les deux clés nécessaires, sans remplacer toute la collection.
Appliquer d'abord sur la recette, puis vérifier son déploiement et les scénarios
synthétiques. La production et les configurations Codex Cloud demandent leur
propre lecture et leur propre validation ; la fusion du code ne les met pas à jour.

## Validation et limite de livraison

Le harnais de transport utilise le véritable SDK avec un transport HTTP simulé :
il vérifie le modèle, `reasoning_effort`, le JSON structuré, le streaming mêlant
blocs de raisonnement et texte, le suivi des tokens et la conservation des
surcharges. Les harnais writer, mémoire et crise utilisent le nouvel identifiant.

Avant activation, vérifier avec l'API réelle : réponse conversationnelle simple,
réponse streamée, synthèse mémoire JSON et chemins de sécurité utilisant le
modèle de génération. Employer uniquement des scénarios synthétiques isolés,
avec plafond de coût et suivi établis selon `WORKFLOW.md`.

Au moment de cette préparation, les valeurs Render n'ont pas pu être lues par
le connecteur et la connexion au tableau de bord a été annulée. Les deux
environnements Codex Cloud existants affichaient « Dépôt inconnu » et leur
édition échouait. Aucun appel API Mistral réel, changement d'environnement,
déploiement ou promotion n'a été effectué. La PR reste en brouillon jusqu'à
validation réelle et réconciliation des configurations.

Retour arrière : rétablir les deux anciennes valeurs enregistrées, redéployer
le même service, vérifier le déploiement, `/health` et les scénarios concernés.
Cette possibilité reste valable seulement tant que l'ancien modèle répond.

## Sources vérifiées le 30 octobre 2026

- [Medium 3.5 : alias, retrait et remplacement](https://docs.mistral.ai/models/mistral-medium-3-5-26-04.md)
- [Large 4 : identifiants et fonctionnalités](https://docs.mistral.ai/models/mistral-large-4-0.md)
- [Effort de raisonnement et formats des réponses](https://docs.mistral.ai/studio/conversations/reasoning.md)
- [Configuration des variables Render](https://render.com/docs/configure-environment-variables.md)
