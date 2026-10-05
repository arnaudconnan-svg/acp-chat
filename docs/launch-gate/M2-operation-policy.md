# M2 — politique d'opération (en cours)

Le contrat de suppression est physique pour les données actives connues et
attribuables. Les enfants historiques étrangers ou sans propriétaire fiable ne
sont jamais adoptés ni supprimés au nom d'un autre compte ; un parent absent
empêche leur restitution. Les copies volontaires de feedback sont séparées de
leur source : supprimer la source seule ne signifie pas retirer ce partage.
Reset/clôture suppriment les objets actifs directement attribuables au compte,
grants et affectations compris ; ils ne suppriment pas l'identité professionnelle.
La clôture ne crée plus d'archive intégrale. L'audit reset HMAC existant reste à
30 jours, sans nouvelle durée juridique inventée.

## Atomicité du schéma existant

Parents, messages, branches, grants et utilisateurs sont des collections racines
distinctes. Leur validation conditionnelle et leur mutation utilisent donc une
transaction sur leur ancêtre commun : la racine RTDB. Un contrôle avant `set`
ou un simple update multi-chemins n'aurait pas fermé la course avec le retrait.

C'est un coût réel : lecture/cache de la racine, clone en mémoire, transfert et
contention/retry avec toute écriture concurrente du projet partagé. Aucune
mesure de charge réelle n'est acquise ici. Ce choix conserve le schéma actuel
sans migration de données ; il ne doit pas être décrit comme une transaction
bornée à un utilisateur ni comme une preuve de capacité de production.

Les données de transaction ne sont ni journalisées ni retournées au client.
Les callbacks d'opération ne déclenchent aucun fournisseur. Le test double
rejoue explicitement le callback sur null initial et conflit : le warm-cache
ne constitue pas, à lui seul, une garantie.

Le proxy protège les mutations des collections visées, y compris child,
query.ref, snapshot.ref et updates multi-chemins dans une collection. Une
mutation racine directe est refusée ; les opérations atomiques passent par
le module dédié. Les collections techniques non visées gardent leur accès
existant. Cette frontière doit être maintenue pour tout nouveau writer.

Les `lifecycleFences` contiennent uniquement des empreintes SHA256 d'IDs et un
booléen de retrait. Ce sont des interdictions de réutilisation, pas des archives
de contenu ni des journaux d'activité. Les effacer rouvrirait la réclamation
après restart : aucune purge automatique n'est ajoutée. Leur maintenance relève
de l'industrialisation G17 et exige de préserver cette interdiction.

## Opérations futures distinctes

Les fences sont applicatives : un writer de l'ancienne version f20 ne les lit
pas et peut recréer un objet sur Firebase partagé. Pendant validation/livraison,
coordonner les deux services et neutraliser temporairement les anciens writers
(requêtes et tâches admises comprises) avant d'annoncer la garantie globale.
La cible Firebase reste partagée ; aucune opération de bascule n'est réalisée
dans cette mission. Une coexistence de versions ne constitue pas une preuve de
retrait global. La réserve de capacité liée aux transactions racines reste à
qualifier avec M4 avant ouverture ; aucune validation de charge n'est acquise.

`privateConversationMemory` historique n'a pas d'ownership fiable : aucune
adoption ni purge pendant M2. L'ordre CJ2 reste déploiement du chemin local-only,
vérification/coupure des writers, purge globale séparément autorisée, redémarrage
et contrôle de non-réapparition. Le garde M0 `--apply` fermé est conservé.

Les appareils hors ligne ne sont pas effaçables à distance. L'appareil courant
efface l'espace capturé lors du reset/clôture, sans toucher au nouveau compte.

## Reprise des copies (checkpoint 2)

Les reçus `copyReceipts` portent l'acteur, les références source/destination et
les IDs des messages, sans seconde copie du contenu. Ils sont supprimés lors du
retrait de la source/destination concernée (hors contrat séparé du feedback) et
du compte. Les fences demeurent : effacer un reçu n'autorise pas à recréer son ID.
Une nouvelle tentative incertaine utilise la même demande et le même operationId.
Un replay admin est une reconstruction déclarée, pas une preuve automatique du
contexte historique exact. Une création ne remplace jamais une destination ; un
remplacement explicite exige sa révision courante. Cette révision couvre aussi
les writers de chat/mémoire/messages et se revalide dans le callback de commit.
