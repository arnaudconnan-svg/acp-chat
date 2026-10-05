# M1 — prérequis avant activation

Le code et les tests sont synthétiques. Aucun compte, grant, secret, service ou
donnée réel n'a été modifié. Ne pas activer ni fusionner automatiquement ce
chantier ; Work doit vérifier les prérequis avant livraison beta.

## Configuration et identités

1. Attester séparément par service la branche/SHA, la base, le projet Firebase,
   le principal consommé et ses règles IAM/RTDB. La carte M0 conserve les inconnus.
2. Révoquer/rotater hors Git les secrets précédemment publiés. Configurer des
   secrets dédiés et distincts `USER_SESSION_SECRET` et `ADMIN_SESSION_SECRET`
   (au moins 32 caractères aléatoires). Aucun repli sur `SESSION_SECRET` ou mot
   de passe admin partagé ; aucune capacité TWA large.
3. Provisionner sous mandat des identités individuelles dans
   `professionalIdentities/<id>` : email normalisé unique, `passwordHash` scrypt
   via le mécanisme existant, `active`, `roles` explicitement choisis parmi
   practitioner/commercial_support/technical_support/administrator,
   `authorizationVersion` entier non négatif, `displayName` lisible pour le
   consentement. Aucun compte réel inventé dans cette tâche.
4. Les cookies professionnels anciens sont refusés. Les nouvelles sessions
   opaques ont un schéma versionné, une durée maximale de 24 h et une révocation
   durable ; changer `authorizationVersion`, désactiver l'identité ou retirer
   un rôle coupe l'accès dès la prochaine requête. Contrôler la politique
   d'expiration et de conservation du journal avant activation.

## Affectations, consentement et audit

- Provisionner explicitement `practitionerAssignments/<professionalId>/<userId>`
  avec `active: true` pour les seules affectations voulues. Une affectation seule
  et une demande de contact humain ne donnent aucun accès au contenu.
- L'utilisateur accorde/révoque dans Mon compte son grant spécifique (choix des
  conversations publiques par titres/dates) ou de période (historique et futures
  publiques pendant la période). La synthèse inter-session a son propre choix.
  L'échéance est un instant local affiché avec son fuseau, persisté en epoch ms.
- Les API de grant contrôlent identité, affectation et objets ; les API praticien
  relisent affectation/grant/propriétaire avant restitution. Aucun cache de droits.
  Les rôles cumulés utilisent le rôle exercé par la route, sans promotion implicite.
- Chaque accès admin aux API exige un motif prédéfini. L'UI attend son choix.
  La levée de pseudonymisation utilise un motif distinct et produit
  `identity_unmask`. Les journaux durables contiennent des références HMAC/codes,
  jamais les paramètres bruts, transcript, mémoire ou debug.
- Le praticien reçoit la projection minimale. Sélection/copie/impression sont
  freinées dans l'UI ; aucune promesse d'impossibilité absolue de capture.

## Données privées, héritage et exploitation

- Transcript, memory/flags et memoryState complets restent dans le namespace
  authentifié de l'appareil. Le serveur attend la consolidation privée pour le
  résultat final, tout en transmettant les tokens avant sa fin. Le debug reste
  N-1. Aucun stockage privé Firebase/cache conversationnel inter-requêtes, ni
  enrichissement inter-session privé.
- La copie feedback volontaire reste une exception distincte : paire bornée,
  commentaire et contexte borné annoncés par la confirmation existante. L'import
  privé vers public reste explicite ; les IDs/dates de memoryState sont conservés.
- Les données héritées sans identité fiable restent physiquement conservées,
  en quarantaine : aucun claim ou transfert arbitraire. Les messages historiques
  orphelins ou étrangers bloquent l'import/overwrite. Les lectures/seeds excluent
  les enfants étrangers, privés ou sans propriétaire fiable.
- Après une bascule validée, inventorier l'ancien nœud privé et les logs historiques,
  leurs sauvegardes, accès et rétention. Une purge demande une cible attestée, un
  périmètre, un ordre, une preuve et un mandat opérationnel distincts. Rien n'est
  purgé ici. Le cycle serveur delete/reset/closure et la refonte replay restent M2.
- Le verrou total `--apply` des opérateurs est conservatoire. Les simulations ne
  prouvent ni une opération réelle ni l'isolation des services déployés.

## Reproduction

Dans un checkout propre, Node et npm disponibles :

```sh
npm ci --ignore-scripts --no-audit --no-fund
bash scripts/synthetic/verify.sh
```

Le runner assainit l'environnement et précharge son garde versionné. Il exécute
opérateur/isolation/professionnel/privé/navigateur/projection/associations/consentement
puis tout `npm run verify`. Aucun `/workspace/acp-validation`, secret ou serveur
externe n'est requis. Seul le téléchargement explicite des dépendances demande
l'accès au registre npm. Express réel traite parsing, montages, ordre, erreurs et
SSE sur des flux mémoire ; aucun listener réseau. RTDB reste un double local,
sans preuve de concurrence distribuée ou d'IAM réel.

Les preuves initiales exactes sont versionnées dans `evidence/initial` avec leurs
empreintes M0. Les fichiers `.cjs.txt` et `.sh.txt` sont des archives documentaires,
pas les commandes actuelles. Le runner courant se trouve dans `scripts/synthetic`.
