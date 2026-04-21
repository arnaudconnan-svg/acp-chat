# WORKFLOW.md — Facilitat.io

## 1. Objectif

Ce projet est développé avec deux environnements :

- Android + Spck : édition rapide, mobilité, petites retouches
- Windows + VS Code + Codex : analyse, modifications structurées, revue des diffs

GitHub est la source de vérité.
La branche `beta` sert de base de travail principale.
Les modifications avec Codex doivent se faire sur une branche dédiée.

---

## 2. Règle générale

Ne jamais laisser Codex modifier le projet sans contrôle.

Toujours :
1. formuler une demande précise
2. demander un diff réel
3. relire le diff
4. valider ou refuser
5. tester
6. commit ensuite

Ne jamais :
- valider un patch sans lire le diff
- accepter un refactor non demandé
- accepter un patch plus large que l’objectif demandé

---

## 3. Workflow Windows

### Avant de commencer
1. ouvrir le repo local propre dans VS Code
2. vérifier la branche active
3. partir d’une branche dédiée si la modification n’est pas triviale

Exemple :
```bash
git checkout beta
git pull origin beta
git checkout -b codex/nom-de-tache

### Pendant le travail avec Codex

Toujours demander :

un patch minimal
la préservation de la logique métier
l’absence de refactor global
un diff réel avant application
Après proposition de Codex

Vérifier :

taille du diff
suppressions inattendues
déplacements de blocs
modifications hors périmètre
cohérence avec la demande initiale
Après validation
tester
relire rapidement le code final
commit
push si nécessaire

---

## 4. Workflow Android

Android + Spck sert principalement à :

corriger du texte
ajuster du CSS
faire de petites modifications locales
consulter rapidement le projet

Éviter sur Android :

modifications complexes de server.js
changements structurels
modifications critiques du pipeline /chat

Quand une modification devient sensible ou difficile à relire sur téléphone :
→ basculer sur Windows

---

## 5. Quand utiliser Codex

Utiliser Codex pour :

analyser un fichier ou une zone du projet
proposer un patch localisé
ajouter une route simple
ajouter des logs
faire une modification ciblée dans un fichier précis
repérer une incohérence ou un blocage

Ne pas utiliser Codex en premier recours pour :

refactor global
réécriture large de server.js
réorganisation importante de index.html
modifications sensibles du pipeline sans revue humaine stricte

---

## 6. Quand refuser un patch

Refuser immédiatement si :

le diff est beaucoup plus grand que prévu
il y a des suppressions inattendues
Codex déplace des blocs sans nécessité claire
Codex modifie la logique métier
Codex touche plusieurs zones alors qu’une seule était demandée
le résumé de Codex ne correspond pas au diff
le patch "semble intelligent" mais n’est pas strictement demandé

En cas de doute :
→ refuser
→ reformuler
→ demander un patch plus petit

---

## 7. Zones les plus sensibles

Les zones suivantes demandent une vigilance maximale :

server.js

Très sensible, surtout :

registre de prompts
flags
mémoire
pipeline d’analyse
route /chat
public/index.html

Très sensible, surtout :

stockage local
transitions et temporisations
logique d’envoi/réception
comportement UX lent et immersif
public/sw.js

Ne pas modifier sans intention explicite.

---

## 8. Méthode de demande à Codex

Préférer ce format :

objectif
invariants à préserver
niveau de modification autorisé
demande de diff réel
interdictions claires

Exemple :

"Objectif : ajouter une route GET /health.
Contraintes :

patch minimal
ne modifier aucune autre logique
ne pas refactoriser
montrer le diff réel avant application."

---

## 9. Règle de sécurité Git

Avant une tâche Codex importante :

partir d’une branche dédiée
ne jamais travailler directement sur une branche critique si le changement est risqué

Si un patch tourne mal :

git restore nom-du-fichier

Si tout tourne mal sur la branche :

git reset --hard HEAD

À utiliser seulement si on sait qu’on veut jeter les modifications locales non committées.

---

## 10. Discipline de validation

Le résumé de Codex n’est jamais une preuve.
Le diff réel est la référence.

Toujours juger sur :

les lignes réellement modifiées
l’emplacement exact
la taille réelle du patch
11. Philosophie de travail

Sur ce projet :

stabilité > élégance
clarté > abstraction
patch local > refactor
contrôle humain > automatisation

Codex est un assistant de modification.
Il ne décide pas de l’architecture à lui seul.

---

## 12. Routine test conversationnel en direct (assistée)

Objectif :

- tester le comportement du bot en boucle courte avec pilotage humain

Protocole :

1. Codex propose 3 messages utilisateur fictifs, style casual
2. l'utilisateur choisit un message via son numero, ou envoie `send: ...`
3. Codex envoie ce message au serveur local (`/chat`)
4. Codex renvoie :
	- la reponse brute du bot
	- 3 nouvelles propositions de message utilisateur
5. on repete jusqu'a demande explicite d'arret

Contraintes de generation des 3 propositions :

- profils humains plausibles, parfois peu a l'aise emotionnellement
- longueurs variees (court, moyen, long)
- ajout possible de bruit naturel (hesitations, auto-corrections, ellipses)
- ton casual, non force

Usage de la balise `<notes>` :

- l'utilisateur peut fournir des informations hors flux via `<notes>...</notes>`
- ces notes servent a orienter les essais et l'analyse
- elles ne sont pas envoyees telles quelles au serveur sauf demande explicite

Commandes operatoires :

- `send: <texte>` : envoyer exactement le texte indique
- `stop` : arreter la boucle de test
- apres `stop` : lancer un debrief synthese (patterns observes, points de risque, idees d'ajustement)

Verification minimale a chaque tour :

- confirmer le message effectivement envoye
- afficher la reponse du bot recue
- proposer immediatement 3 nouvelles options