# ARCHITECTURE.md — Facilitat.io

## Vue d’ensemble

Application conversationnelle avec :

- Backend : Node.js + Express + OpenAI + Firebase
- Frontend : index.html (tout-en-un)
- Stockage :
  - localStorage côté client
  - Firebase côté serveur

---

## Backend (server.js)

Fichier central contenant :

- route principale : /chat
- logique conversationnelle complète
- analyses LLM (suicide, contact, info, etc.)
- gestion des flags
- gestion de la mémoire

---

## Pipeline /chat (simplifié)

1. réception message
2. sauvegarde Firebase
3. analyse suicide
4. gestion crise
5. analyse recall
6. analyse contact
7. détection info/exploration
8. génération réponse
9. mise à jour mémoire
10. réponse au frontend

⚠️ L’ordre est critique et ne doit pas être modifié

---

## Flags importants

- explorationDirectivityLevel
- contactState
- acuteCrisis

Ils influencent directement le comportement de l’IA.

---

## Frontend (index.html)

Responsabilités :
- affichage
- gestion mémoire locale
- gestion flags
- envoi des messages

⚠️ dépend fortement du backend

---

## Points sensibles

- route /chat
- mémoire
- flags
- ordre du pipeline
- UX lente (timers)

---

## Principe global

Le système repose sur :
- la continuité
- la cohérence
- la stabilité du comportement

Toute modification peut avoir des effets indirects.