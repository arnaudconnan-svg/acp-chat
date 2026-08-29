# WORKFLOW.md — Facilitat.io

## 1. Objet

Ce fichier decrit le mode de travail reel du projet.

- l'utilisateur formule un objectif produit, un probleme visible, une contrainte metier ou soumet une conversation test avec des commentaires dev écrits par lui
- l'agent propose des axes d'amélioration, choisit l'implementation technique, structure le chantier, modifie le code, puis verifie
- GitHub reste la source de verite
- la branche `beta` reste la base de travail principale sauf besoin explicite contraire
- ChatGPT web ou mobile assure la continuite conversationnelle entre les sessions et les terminaux
- Codex Cloud/Remote travaille directement sur le repo GitHub, dans l'environnement `acp-chat` et sur la branche `beta` par defaut
- le fonctionnement courant ne depend d'aucun repo local, VS Code local ou Chrome local

## 2. Regle generale

Le controle porte sur le comportement visible, pas sur chaque decision de code.

Toujours :

1. formuler l'objectif en langage produit ou comportemental
2. laisser l'agent choisir le moyen technique
3. tester ce qui est modifie
4. conserver un historique git lisible

Ne jamais :

- valider un changement visible non compris
- melanger un vrai changement produit et un refactoring large sans l'annoncer
- supposer qu'un diff court est automatiquement plus sur qu'un diff structurel propre

## 3. Changement purement technique vs changement visible

### Changement purement technique

Exemples :

- logs
- renommage interne
- extraction en modules
- refactoring local
- factorisation

Dans ces cas :

- l'agent agit directement
- il explique apres coup ce qu'il a fait
- il valide dans l'environnement Codex Cloud/Remote avec les commandes adaptees

### Changement visible pour l'utilisateur final

Exemples :

- ton de reponse
- routing de mode
- reponse de crise
- forme de la memoire affichee
- comportement frontend perceptible

Dans ces cas :

1. l'agent annonce ce qui va changer
2. l'agent indique le risque principal
3. il attend un go avant de coder

## 4. Verification attendue

Verification minimale apres changement backend significatif :

1. `node --check server.js`
2. `npm run verify`

Note prompting :

- `npm run verify` inclut `npm run prompts:consistency`, garde-fou deterministe des incoherences de prompting (notamment `UPDATE_MEMORY`)
- tout echec de ce harnais est bloquant, meme si le reste des harnesses passe

Verification complementaire selon le chantier :

- lecture des logs `[PIPELINE]` pour un diagnostic fin de `/chat`
- pour toute lenteur percue sur `/chat`, commencer par les `pipeline_summary` et lancer `npm run perf:chat:summary` sur un log reel avant de modifier le code
- des qu'un diagnostic production Render est necessaire, l'agent lit les logs live depuis Codex Cloud/Remote via l'API Render quand `RENDER_API_KEY` et `RENDER_SERVICE_ID` sont disponibles (pas de copier-coller manuel requis)
- si l'utilisateur doit suivre un test depuis `admin.html`, lancer le test en non-prive (`isPrivateConversation=false`) et communiquer `conversationId` + `requestId`
- reserver `isPrivateConversation=true` aux tests demandes explicitement en prive
- sequence Render de reference :
  - 1.  `GET /v1/services/{serviceId}` pour recuperer `ownerId`
  - 2.  `GET /v1/logs?ownerId=<ownerId>&resource=<serviceId>`
  - 3.  lecture brute initiale, puis filtrage local (temps + motifs)
  - 4.  en cas de pagination, iterer jusqu'a couvrir la fenetre demandee
- si un `requestId` est fourni par l'utilisateur :
  - 1.  extraire d'abord toutes les lignes de logs contenant ce `requestId` depuis le dump brut pagine
  - 2.  ne pas prefiltrer par theme avant cette extraction
  - 3.  restituer les lignes completes trouvees avant toute synthese
- interpretation erreurs Render :
  - `404` = mauvais endpoint (route non disponible)
  - `400` = endpoint valide, parametres invalides/incomplets
  - ne pas conclure "pas de logs" avant d'avoir valide la combinaison `ownerId + resource`
- harness comportemental centre sur `debugMeta`
- test manuel cible quand le changement est visible
- `pipeline:harness`, `debugmeta:harness` ou `eval:chat` sur GO explicite seulement (LLM en direct)

Pour le chantier Android TWA, le chemin de validation et de deploiement doit etre le suivant :

1. `npm run android:deploy:release`
2. verification automatique orientation via `npm run android:orientation:verify` (incluse dans `android:build:release`)
3. verification de la signature de l'APK contre `public/.well-known/assetlinks.json`
4. installation via l'ADB du SDK Android, jamais via un binaire `adb` pris au hasard dans `PATH`
5. en cas de signature incompatible sur le package deja installe, desinstallation automatique avant reinstall
6. apres install reussie, redemarrage force TWA: arret best-effort de l'hote navigateur puis `adb shell am start -S ...` (kill + start deterministes) pour eviter de garder une Custom Tab stale au premier plan

Point de controle obligatoire orientation:

- la valeur Android generee `string/orientation` doit rester `portrait` (pas `default`)
- si ce point echoue, le build release doit etre considere bloque

Si `adb devices` ne voit pas le telephone, utiliser d'abord l'ADB du SDK (`ANDROID_SDK_ROOT` ou `ANDROID_HOME`), puis seulement diagnostiquer le branchement physique ou l'autorisation USB. Ne pas multiplier les installs manuelles ni les essais de signature a l'aveugle.

Deux regles produit doivent rester stables sur Android TWA :

- l'orientation portrait est la regle par defaut et doit etre preservee dans les manifests generes et dans le projet Android applique
- le splash doit rester minimal et coherent visuellement avec l'accueil web ; on peut le raccourcir ou l'aligner, mais pas le reconcevoir a chaque install

## 5. Strategie de chantier

L'ordre prefere est :

1. observabilite
2. correction locale ou refactoring necessaire
3. validation et seulement ensuite elargissement

Pour les gros chantiers techniques, privilegier :

- extraction modulaire incrementale
- validation apres chaque extraction
- un seul type de risque a la fois

## 6. Zones sensibles

Les zones qui demandent le plus de rigueur sont :

- `server.js` et la route `/chat` (pipeline d'execution, early-returns, ordre des etapes)
- `lib/pipeline.js` et `lib/analyzers.js` (arbitrage posture, signaux)
- les fonctions de memoire (`lib/memory.js`)
- les transitions d'etat conversationnel (`lib/conversation-state.js`)
- le contrat frontend/backend entre `public/index.html`, `public/admin.html` et `/chat`
- `public/sw.js` (service worker, cache, offline)
- `lib/debugmeta.js` (toute modification doit etre synchronisee dans les deux interfaces)

La sensibilite d'une zone ne signifie pas qu'elle est intouchable.
Elle signifie qu'elle doit etre modifiee avec verification adaptee.

## 7. Phase actuelle — priorites operationnelles

Le produit est en phase de stabilisation comportementale.

Cela signifie :

- la priorite est de corriger, stabiliser et tester les comportements existants — pas d'en ajouter de nouveaux
- tout nouveau signal, analyseur, etat machine, token writer, champ debug ou champ memoire est traite comme exceptionnel : le signaler comme besoin avec justification comportementale et attendre un go explicite
- les bugs comportementaux visibles restent traites immediatement, sans attendre
- les ameliorations de l'outillage (harness, logs, tests deterministes) restent autorisees sans validation prealable
- les refactorings qui ameliorent la fiabilite sans ajouter de comportement nouveau sont autorises

Cette phase prend fin sur decision explicite de l'utilisateur.

## 7. Git

Regles pratiques :

- preferer des commits lisibles et thematiques
- ne pas melanger plusieurs chantiers sans lien dans un meme commit
- ne jamais utiliser de reset destructif sans demande explicite
- si le working tree est sale, ne pas revert les changements utilisateur sans accord

## 8. Philosophie

Sur ce projet :

- stabilite du comportement > qualite du code > optimisation
- mais stabilite du comportement ne signifie pas immobilite du code
- si une structure interne freine la fiabilite, l'agent doit la faire evoluer
- l'architecture doit progressivement converger vers V4 strict : noyau deterministe, analyseurs paralleles, arbitrage explicite, writer pilote par contrat
- la conformite de sortie est assuree uniquement en amont (analyseurs, arbitrage, contrat writer, contraintes deterministes), sans post-traitement, sans reecriture, sans regeneration

---

## 9. Fonctionnement cloud et continuite

Le flux de travail courant est 100 % cloud :

- la continuite des echanges est portee par ChatGPT web ou mobile
- les modifications, validations et operations Git sont realisees par Codex Cloud/Remote sur le repo GitHub
- l'environnement `acp-chat` et la branche `beta` sont utilises par defaut
- aucun fichier du repo ni environnement local ne sert de pont de reprise entre les terminaux

Codex desktop/local, VS Code local et Chrome local sont reserves aux configurations ponctuelles qui ne peuvent pas etre accomplies proprement dans le cloud :

- 2FA ou OAuth
- utilisation d'une session web deja connectee
- recuperation initiale de secrets
- acces a un service sans API ni pont cloud propre

Une fois cette configuration terminee, le travail courant reprend dans ChatGPT web/mobile et Codex Cloud/Remote.
