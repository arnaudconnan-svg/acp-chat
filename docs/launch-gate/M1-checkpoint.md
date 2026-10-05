# M1 en cours — checkpoint, 5 octobre 2026

Ce checkpoint n'est ni une clôture, ni une livraison, ni une autorisation de fusion.
Destination : work/m0-m1-launch-gate ; PR future vers beta uniquement, revue Work.

Fichiers courants : server.js (identités professionnelles durables, rôles explicites,
révocation et grants, contrôles d'autorité initiaux, suppression des stockages privés,
consolidation privée retournée au client) ; lib/professional-access.js ;
lib/log-projection.js et lib/logger.js (projection avant destinations) ;
public/js/conversation-data.js et public/index.html (transport/stockage memoryState).
Le runner M0 utilise désormais Express réel sans listener ; son terminal de test et
son contrôle de fin des assertions ont été renforcés après la revue Work.

Tests réellement exécutés : node --check server.js PASS ; harness isolation M0
Express/montages/ordre/erreurs PASS ; professional-harness PASS (identités, restart,
rôles, grants, révocation, projection praticien, supports, motif admin, journal) ;
log-projection-harness PASS (marqueurs factices absents de pino, console et bindings).
Les tests de projection doivent encore partager intégralement la factory du logger
production. Aucun test ne fait appel aux fournisseurs réels.

Prochaines actions : compléter les frontières objet et les collisions/finalisations,
valider privé multi-tour/reload/restart et exceptions explicites ; isoler navigateur
par identité et tester logout/onglets/offline/retours tardifs ; sécuriser redirects ;
compléter UI praticien/grants/motifs ; brancher tous les nouveaux harnesses au runner
reproductible ; exécuter verify complet et corriger les échecs. Mettre à jour le
rapport par gate et ouvrir la PR pour Work sans fusion.

Limites ouvertes : principals/bases/IAM des services déployés non attestés ; rotation,
provisioning réel, historique/rétention des logs et ancien nœud privé à traiter sous
mandat opérationnel distinct. Aucun déploiement, compte réel ni purge réelle.
