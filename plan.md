Base de reprise - conversation test du 14/05/2026

Decisions implementees
- Ajout de "Oui" dans le declencheur lexical de validation courte d'affiliation (avec validation contextuelle LLM conservee).
- Ajout d'un cap de baisse inter-tour du score d'affiliation: baisse max de 0.20 par tour.
- Exception: ce cap ne s'applique pas si le signal d'alliance est "rupture".

Etat de verification
- node --check server.js: OK
- npm run verify: OK

Point produit restant a surveiller
- Verifier en test conversationnel que la cloture saine n'effondre plus l'affiliation tout en laissant une vraie baisse libre en cas de rupture d'alliance.
