# M2 — matrice des parcours G15

Candidate non déployée. « Utilisateur » signifie session M1 et ownership du
parent/enfants ; « admin » exige administrator exercé et motif M1 journalisé.
Tous les contrôles cités utilisent des fixtures, aucun service réel.

| Fonction | Endpoint / flag | Autorité | Artefact et contrat | Preuve |
| --- | --- | --- | --- | --- |
| Conversation publique | POST `/chat` ; aucun nouveau flag | Utilisateur | Parent/messages, ticket de tour et génération, sauvegarde non bloquante, mémoire séparée | `m2-chat` : N/N+1, retrait, remplacement, manuel, Stop |
| Conversation privée | POST `/chat` et `/chat/stream` | Utilisateur ; transit privé sans adoption d'ID public | `memoryState` appareil ; aucun parent/message/cache privé ni consolidation Firebase | `object-private`, `m2-stream` témoin privé |
| Streaming fermé | POST `/chat/stream`, `/chat/stream/interrupted` ; `ENABLE_CHAT_STREAMING=false` par défaut | Refus 405 avant claim/writes | Aucun artefact ; seul ce refus explicite autorise fallback classique | `m2-lifecycle`, `object-private`, lecteur frontend réel |
| Streaming activé existant | POST `/chat/stream` ; flag true | Utilisateur, parent et génération à chaque restitution | Tokens/result/error SSE ; aucun token tardif après retrait/Stop/remplacement | `m2-stream`, `m2-browser` corps retenu |
| Interruption streaming | POST `/chat/stream/interrupted` ; flag true | Même compte/parent/requête admise ; privé ignoré côté serveur | Un slot de réponse ; retry idempotent ; réponse complète gagnante conservée ; aucun faux ack du partiel navigateur | `m2-stream` ack perdu/restart/completed-wins ; `m2-browser` completed-wins |
| Stop / progression | POST `/chat/cancel`, GET `/chat/progress` | Requête du compte ; autorité du parent si public | Annulation au commit public ; lease conservé jusqu'à fin des enfants ; aucune mémoire privée durable | `m2-chat` commit retenu, `m2-stream`, M1 ownership |
| Reçu de sauvegarde | GET `/api/account/conversations/:id/saves/:messageId` | Parent + enfant du compte | Statuts bornés, sans contenu ; remplacement détecté pour le slot de requête | `m2-browser` confirmé/incertain/remplacé ; handlers chat |
| Préparer une branche | POST `/api/branches/from-message` | Source et ancre canonique possédées ; pas de preuve par simple texte client | Branche + seed + destination préparée + reçu, même commit | `m2-copies` null initial/ack perdu/retry froid |
| Créer/activer une branche | POST `/api/branches/create-and-activate` | Même contrôle, enfants publics attribuables | Destination et enfants déterministes atomiques ; pas de doublon | `m2-copies`, `m2-browser` reprise et hydratation canonique |
| Activer / lire une branche | POST `/api/branches/:id/activate`, GET `/api/branches/:id`, GET `/api/branches` | Branche→source→seed→destination ; refus des références contradictoires M1 | Une activation ne réécrit pas le travail déjà présent ; copies/stateSnapshot conservés | `associations`, `m2-copies` témoin légitime + contradictions |
| Feedback public | POST `/api/messages/:id/feedback` | Parent/enfant du compte ; permissions M1 de lecture admin conservées | Feedback lié au message ; écriture refusée après retrait | `object-private`, garde des messages `m2-lifecycle` |
| Feedback volontaire privé | POST `/api/branches/feedback-snapshot` ; partage explicite | Utilisateur, consentement adminShare | Copie publique bornée user+bot/contexte, autonome par rapport à sa source ; retry sans double copie | `object-private`, `m2-copies` ack perdu/source supprimée |
| Replay admin | POST `/api/admin/conversations/import-replay` | Admin + motif ; source/destination/ancre/owner valides | writeIntent create/replace explicite ; replace exige expectedVersion ; génération renouvelée ; reconstruction déclarée | `m2-copies`, `m2-chat` anciens enfants retenus, replay frontend réel |
| Préparer/revoir le replay | GET admin conversations/messages ; UI admin→index | Admin + motif M1, projection minimisée | Modèle mémoire réel et snapshots ; aucune fidélité historique automatique | `professional`, `m2-copies` objets mémoire réels, `m2-browser` reload/reprise |
| Import volontaire local→public | POST `/api/account/conversations/import-local` | Utilisateur ; batch borné ; aucun parent/enfant étranger, privé serveur ou orphelin adopté | Batch atomique, IDs déterministes/reçus ; forceOverwrite explicite et CAS ; nouvelle copie privée refuse une collision publique | `associations`, `m2-copies`, `m2-browser`, `m2-chat` remplacement |
| Close / consolidation | POST `/session/close`, PUT `/api/intersession-memory`, POST `/api/session/beacon` | Session + parent public ; privé exclu de consolidation | Destination/identité figées ; génération et révision utilisateur au commit ; beacon n'atteste pas consolidation | `m2-chat`, `m2-browser` close ancien légitime / bascule / suppression / manuel |
| Édition mémoire | PATCH `/api/intersession-memory/direct` | Utilisateur courant | Priorité manuelle, historique existant borné, ancienne consolidation refusée | `m2-chat`, `m2-lifecycle` |
| Retrait conversation / compte | DELETE account/admin conversation ; POST reset/close | Propriétaire ou admin + motif | Parent/enfants/copies attribuables/reçus retirés, fences conservées, reset nouveau userId ; aucun accountArchives nouveau | `m2-lifecycle`, `m2-chat`, `m2-copies`, `m2-browser` |

Les rôles practitioner/support n'obtiennent aucune élévation via ces copies.
Les contrôles M1 opérateur/isolation/grants/projection/consentement restent dans
le même runner. Aucun flag n'est activé par ce patch. Une réponse réseau perdue
reste incertaine jusqu'à une reprise/lecture canonique ; aucune garantie SMTP,
fournisseur ou exactly-once universelle ne découle des reçus de base de données.
