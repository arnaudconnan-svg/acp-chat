# MANUAL_TESTS.md

## Objectif

Checklist manuelle courte pour verifier les durcissements recents sans suite de tests automatisee.

## Pre-requis

- lancer le serveur avec `npm start`
- ouvrir l'app sur `http://localhost:3000`
- garder les DevTools ouverts pour voir les reponses HTTP si besoin

## Verif automatique rapide

Depuis la racine du projet :

```bash
npm run smoke
```

Attendu :

- sortie `[SMOKE] 8/8 checks passed.`

## Maintenance index Firebase RTDB

Depuis la racine du projet :

```bash
npm run rtdb:index
```

Attendu (dry run) :

- indique si `messages..indexOn` contient deja `conversationId`

Pour appliquer la mise a jour avec backup automatique :

```bash
npm run rtdb:index:apply
```

Attendu (apply) :

- backup des regles RTDB dans `data/rtdb-rules-backup-*.json`
- message `Validation OK`

## 1. Chat - payload invalide bloque

Depuis la console navigateur sur la page principale :

```js
fetch("/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: ["bad"], conversationId: "c_test" })
}).then(async res => ({ status: res.status, body: await res.json() }))
```

Attendu :

- status `400`
- body contenant `error: "Invalid chat request"`
- aucune reponse assistant parasite dans l'UI

## 2. Session close - flags invalides bloques

Depuis la console navigateur :

```js
fetch("/session/close", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ memory: "ok", flags: [] })
}).then(async res => ({ status: res.status, body: await res.json() }))
```

Attendu :

- status `400`
- body contenant `error: "Invalid session close request"`

## 2 bis. Middleware JSON global - JSON mal forme bloque proprement

Depuis un terminal :

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/chat" -Method Post -ContentType "application/json" -Body '{'
```

Attendu :

- status `400`
- log serveur `[HTTP][INVALID_JSON]`
- plus de page HTML Express exposee comme comportement attendu

## 3. Admin login - erreur correctement affichee

- ouvrir `/admin-login.html`
- saisir un mauvais mot de passe

Attendu :

- message `Mot de passe incorrect`
- pas de redirection

## 4. Admin login - requete invalide

Depuis la console sur `/admin-login.html` :

```js
fetch("/api/admin/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: 123 })
}).then(async res => ({ status: res.status, body: await res.json() }))
```

Attendu :

- status `400`
- body contenant `error: "Invalid admin login request"`

## 5. Admin labels - echec visible

- ouvrir `/admin.html`
- ouvrir le bottom sheet d'une conversation
- couper volontairement le serveur ou simuler le hors-ligne dans DevTools
- cliquer sur `Enregistrer`

Attendu :

- le bottom sheet reste ouvert
- un message `Erreur reseau` ou `Erreur serveur` apparait
- le libelle visible dans la liste ne change pas

## 6. Titre conversation - lecture robuste

Depuis la console navigateur :

```js
fetch("/api/conversations/%20/title", { cache: "no-store" })
  .then(async res => ({ status: res.status, body: await res.json() }))
```

Attendu :

- status `400`
- body contenant `error: "Conversation invalide"`

## 7. Chat - logs de decision utiles

Envoyer un message normal via l'UI avec `logsEnabled` actif si l'interface de debug est utilisee.

Attendu dans le terminal serveur :

- `[CHAT][DECISION]` avec au minimum `suicide_analysis_result`
- puis `recall_routing`
- puis `mode_detected`
- et `exploration_relance_registered` si le mode final est `exploration`

## 8. Chat - fallback sans trou d'historique

Test manuel recommande seulement sur branche de travail :

- provoquer temporairement une erreur volontaire juste apres la persistance du message utilisateur dans `/chat`
- envoyer un message depuis l'UI
- verifier ensuite la conversation dans l'admin

Attendu :

- le message utilisateur est present
- une reponse assistant fallback est aussi presente
- le terminal affiche `[CHAT][FALLBACK_PERSISTED]`

## 9. Verification minimale finale

- executer `node --check .\server.js`
- verifier qu'aucune erreur n'apparait dans les diagnostics VS Code sur `server.js`, `public/index.html`, `public/admin.html` et `public/admin-login.html`