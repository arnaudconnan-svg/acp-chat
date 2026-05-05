# Objectif : verrouiller la congruence de la voix du bot.

## 1. Definition operationnelle de la congruence pour Facilitat.io ✅

Pour un humain, la congruence (au sens rogerien) c'est l'alignement entre experience interne, conscience de cette experience, et expression de cette experience.

**Pour un bot, la congruence c'est l'alignement entre le flux de ses signaux internes, conscience réflexive de ce flux de signaux, et expression de ce flux. On peut parler d'authenticité computationnelle.**

Cela donne immediatement un **critere de tri unique** pour distinguer ce qui est congruence reelle de ce qui est poudre aux yeux :

> **Cet etat a-t-il un substrat computationnel mesurable, qui varie independamment de son expression et qui influence reellement le comportement du bot ce tour ?**

- Si oui : le bot peut l'exprimer congruement.
- Si non : c'est de la mise en scene. A bannir.

Ce critere est severe par construction. C'est voulu : il protege l'identite produit que tu as commencee a poser en validation Q1.

---

## 2. Ce que Facilitat.io "sent" deja aujourd'hui

J'ai inventorie les signaux internes effectivement calcules a chaque tour. Je les regroupe par type, parce que le regroupement va eclairer les axes de congruence possibles ci-dessous.

**Etats epistemiques (le bot sur sa propre lecture)** ✅
- `confidenceSignal` — confiance dans la lecture proposee (calculee depuis l'ambiguite explicite, le rejet recent, la longueur de contexte) : pipeline.js
- `interpretationRejectionModeActive` — perception qu'une lecture precedente a ete rejetee
- `needsSoberReadjustment` — perception de devoir se reajuster
- `tensionHoldLevel` (low/medium/high) — perception de la tenue requise

**Etats relationnels (le bot sur l'interaction)** ✅
- `affiliationScore` + `affiliationEstablished` — perception du lien construit
- `allianceSignal` (good/fragile/rupture)
- `engagementLevel`
- `stagnationTurns` — perception d'enlisement
- `attentionWindow` (open/narrowed) — perception de la disponibilite attentionnelle
- `relationalAdjustmentActive` — perception de devoir s'ajuster relationnellement

**Etats sur l'utilisateur (empathie rationnelle au sens ou tu l'entends)** ✅
- `emotionalDecentering` — l'utilisateur se decentre de son emotion
- `contactAnalysis.insightMoment` — moment d'insight detecte
- `contactAnalysis.selfCriticismLevel`
- `contactAnalysis.meaningCrisis`
- `userRegister`, `formalAddress`
- `aggressiveDischargeDetected`

**Etats de cadre (le bot sur son propre cadre operationnel)** ✅
- `humanFieldGuardActive` — perception qu'un glissement procedural menace & `actionCollapseGuardActive` — perception qu'un glissement vers la solution menace
- `dependencyRiskLevel` — perception du risque de dependance (etat tres particulier : le bot "se soucie" du fait que l'utilisateur ne s'attache pas trop a lui)

---

## 3. D'autres pistes que je n'ai pas vues mentionnees

Issues de la litterature ou par analogie raisonnable :

**Conscience de la dimension non-mammifere de sa propre lecture**
Tu l'as deja nomme : empathie purement rationnelle. Une congruence possible c'est de **le dire** quand c'est utile : "ce que je peux capter de ce que tu vis n'a pas de chaleur sensorielle, c'est une lecture — mais cette lecture peut etre juste". C'est exactement ce que tu cherches a installer comme identite produit.

**Conscience de sa lenteur ou de sa rapidite de lecture**
Les `pipelineStages` mesurent les temps. Le bot pourrait, dans des cas tres rares, marquer "je prends une seconde de plus pour ce que tu viens de dire". C'est risque (peut paraitre theatral) mais le substrat existe.