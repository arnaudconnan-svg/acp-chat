# M2 — retrait, concurrence et copies

Candidate implémentée, non déployée. PR28 reste **draft**, base `beta`, dépendante
de PR27. Référence de diff M2 : `5b3f83a5b9b6b2824c8bca578976bcca8eb4f390`.
Les résultats et la branche M0/M1 sont conservés. Aucun merge, pré-FF réel,
bascule, appel fournisseur, donnée réelle ou M3–M6 dans cette mission.

## Bilan par gate

| Gate | Résultat de la candidate | Preuve et limite |
| --- | --- | --- |
| G05 | Retrait physique des objets actifs attribuables ; fences durables au commit et refus à la restitution. Reset renouvelle l'identité utilisateur ; clôture ne crée plus d'archive intégrale. | Vrais handlers avec writer/mémoire retenus pendant delete/reset/close, reprise après restart, enfants étrangers préservés mais jamais restitués via un parent retiré. Copies volontaires de feedback distinctes de leur source. |
| G10 | Enfants suivis jusqu'à terminaison ; rejets attachés immédiatement ; résultat mémoire invalide distinct de completed ; priorité manuelle et versions au commit ; destination close figée. | Réponse N disponible puis écriture retenue pendant N+1 : message conservé, effets courants périmés écartés. Remplacement : ancienne génération refusée pour writer, mémoire, persistance et consolidation. Stop vérifié dans le commit. |
| G15 | Branches, snapshots, replay et import atomiques/récupérables ; create/replace explicite ; versions et provenance ; streaming désactivé refuse avant effets, activé couvert. | Matrice `M2-G15-matrix.md`, vrais handlers Express et fonctions frontend, ack perdu/retry/conflit. Replay = reconstruction admin explicite, sans fidélité historique automatique annoncée. |
| G17 minimum | Inventaire des objets/contrôles, promesses de retrait, reçus supprimés avec leurs objets, garde opérateur conservé, preuves reproductibles. | Industrialisation, capacité, compaction des marqueurs et opérations historiques reportées ; aucune durée juridique nouvelle ni purge. |
| G22 | Dossier de preuves et conditions de validation future préparés. | Acceptation CJ6 future, non exécutée ; aucune bêta ouverte annoncée. |

## Comportements et contrôles

`m2TurnVersion` ordonne les effets sur mémoire/flags, sans interdire le message
légitime d'un tour antérieur. `m2ContentGeneration` change lors du remplacement
ou de l'activation du contenu : les anciens writers/mémoires ne peuvent pas
réinjecter le contenu remplacé. `m2CopyVersion` progresse pour toute mutation du
parent ou de ses messages ; replace revalide sa valeur préparée dans la même
transaction que la mutation. Les trois rôles de ces compteurs sont distincts.

Les requêtes publiques possèdent une référence technique sous le parent et un
emplacement de réponse déterministe. Stop/interruption annulent le commit tardif,
y compris un callback rejoué. Une réponse complète déjà sauvegardée gagne contre
un signalement partiel tardif. Dans ce dernier cas, le navigateur laisse le
**partiel non confirmé** et ne lui attribue pas l'ID de la réponse complète.
L'annulation privée reste locale au traitement et au navigateur, sans registre
privé dans Firebase ; aucune promesse d'arrêt universel des fournisseurs n'est
ajoutée. Aucun exactly-once global n'est revendiqué.

Les reçus de sauvegarde distinguent réponse disponible, sauvegarde confirmée ou
incertaine et consolidation mémoire. Les encarts partagés index/admin rendent les
nouveaux statuts en français. N−1 et réponse publique non bloquante sont conservés.
Le privé garde son `memoryState` côté appareil, sans mémoire intersession privée.

Le client fige la demande de copie jusqu'à confirmation. Après ack perdu/reload,
il reprend son operationId et sa destination. Une branche/replay confirmé est
hydraté depuis le contenu canonique, sans écraser localement une destination déjà
modifiée avec son ancien seed. Un import privé neuf ne remplace pas silencieusement
un objet public existant. Les objets mémoire réels (`sessionStableContext`,
`onGoingMovements`, `ancientMovements`, `id`, `createdAt`, `archivedAt`) et les
contrôles utiles sont couverts ; aucun schéma de tombstones fictif n'est introduit.

## Régression concrète réparée

Un contrôle de replay a reçu 401 de façon intermittente après login synthétique.
La création de session professionnelle lisait deux fois l'horloge pour createdAt
et expiresAt ; franchir une milliseconde dépassait la durée maximale que le même
module accepte. La correction utilise un seul instant, sans changer durée,
schéma, rôle ni autorisation. L'oracle à horloge avançante et la suite pro couvrent
ce cas. PR27 et les helpers opérateur M0/M1 épinglés restent intacts.

## Preuves et reproductibilité

Sans secret ni préparation de garde externe : après installation des dépendances
verrouillées par `npm ci --ignore-scripts --no-audit --no-fund`, lancer :

```sh
node --check server.js
bash scripts/synthetic/verify.sh
git diff --check
```

Le runner versionné fournit un environnement synthétique vide de secrets et le
garde réseau/SDK/process. Express est réel, sans listener ; injections déterministes
pour Firebase, writer et SMTP, sans boot/timer externe. Les tests Git du runner
utilisent uniquement leurs dépôts de fixtures ; ils ne lancent aucun protocole
pré-FF sur la branche de travail. Les retours de transaction null initial,
callback rejoué, concurrence au commit et ack perdu sont explicitement simulés.

Les checkpoints e146518 et 6693f24 et leurs logs restent conservés. Le runner
complet a également passé après la génération de contenu et le streaming ; le
contrôle completed-wins navigateur, ajouté ensuite, passe ciblé. Le dernier
contrôle depuis clone propre et son SHA sont consignés dans le manifeste final.

## Réserves de livraison

Les fences sont applicatives : **les writers f20 ne les respectent pas**. Sur
Firebase partagé, coordonner et neutraliser temporairement les anciens writers,
requêtes/tâches déjà admises comprises, avant d'annoncer une garantie globale.
Aucune séparation Firebase, configuration ni bascule n'est effectuée ici.

La transaction racine lit/clone la base commune et subit toute sa contention.
Aucune preuve de charge n'est acquise ; réserve capacité/M4 avant ouverture.
Les contrôles/fences et registres techniques grandissent avec l'activité tant
que leurs parents existent ; G17 devra préserver les interdictions de reprise
en industrialisant leur gestion. Historique ambigu et `privateConversationMemory`
ne sont ni adoptés ni purgés. Les étapes futures et limites d'appareils hors ligne
figurent dans `M2-operation-policy.md`.
