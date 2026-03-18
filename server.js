require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const {
  CONVO_STATES
} = require("./constants");

const {
  analyzeMessage,
  normalizeSessionFlags
} = require("./analysis");

const {
  generateFreeReply
} = require("./replyGeneration");

const {
  summarizeSession
} = require("./sessionMemory");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());


// --------------------------------------------------
// HELPERS RESTANTS
// --------------------------------------------------

function isTrivialSilence(text = "") {
  const msg = String(text || "").trim();
  return msg === "" || msg === "." || msg === "...";
}

function assistantAskedTooMuch(history = []) {
  const recentAssistantMsgs = history
    .filter(m => m.role === "assistant")
    .slice(-3)
    .map(m => String(m.content || "").trim());

  if (recentAssistantMsgs.length < 2) return false;

  const questionCount = recentAssistantMsgs.filter(msg => msg.endsWith("?")).length;
  return questionCount >= 2;
}

function getCongruenceEscalationReply(level = 0) {
  if (level >= 4) {
    return "Si tu veux reprendre, on pourra repartir dans une nouvelle session.";
  }

  if (level === 3) {
    return "Je préfère m’arrêter là pour le moment.";
  }

  if (level === 2) {
    return "...";
  }

  if (level === 1) {
    return "Là, je ne parviens pas à répondre de façon juste.";
  }

  return null;
}

function updateCongruenceEscalation(currentLevel = 0, primaryState = CONVO_STATES.EXPLORATION) {
  const current = Number(currentLevel || 0);

  if (primaryState === CONVO_STATES.CONTAINMENT) {
    return 0;
  }

  if (primaryState === CONVO_STATES.BREAKDOWN) {
    return Math.min(current + 1, 4);
  }

  if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
    return current;
  }

  if (current > 0) {
    return Math.max(current - 1, 0);
  }

  return 0;
}

function acuteCrisisFollowupResponse() {
  return "Je reste sur quelque chose de très simple là. Si le danger est immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

function n1Fallback() {
  return "Quand tu dis ça, est-ce que tu parles d’une envie de mourir, de disparaître au sens vital, ou d’autre chose ?";
}

async function n1ResponseLLM(client, userMessage) {
  const system = `
Tu t’adresses directement à la personne en la tutoyant.

Ta seule tâche est de poser une question de clarification
brève, claire et non dramatique.

Tu ne dois jamais :
- parler de "la personne"
- décrire ou analyser le message
- faire une méta-explication
- répondre comme un évaluateur

Tu poses simplement une question directe pour clarifier
si la personne parle :
- d'une envie de mourir
- d'une disparition au sens vital
- d'une intention de mettre fin à sa vie
- ou d'autre chose

Réponse : une seule phrase.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 50,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  if (!out || out.length > 220) return n1Fallback();
  return out;
}

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

function getConflictualityLabel(level = 0) {
  return `Niveau de conflictualité : ${Number(level || 0)}`;
}

function getPrimaryStateLabel(primaryState = CONVO_STATES.EXPLORATION) {
  return `État primaire : ${primaryState}`;
}

function getSecondaryStateLabel(secondaryState = CONVO_STATES.NONE) {
  return `État secondaire : ${secondaryState}`;
}

function buildDebugLines({
  analysis = {},
  flags = {},
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE
} = {}) {
  const lines = [];

  if (analysis.suicideLevel === "N2") {
    lines.push("Alerte suicide");
  }

  if (analysis.needsClarification === true) {
    lines.push("Risque suicidaire probable");
  }

  if (analysis.isQuote === true) {
    lines.push("Évoque une autre personne");
  }

  lines.push(getConflictualityLabel(flags.congruenceEscalation || 0));
  lines.push(getPrimaryStateLabel(primaryState));
  lines.push(getSecondaryStateLabel(secondaryState));

  if (analysis.reliefOrShift === true) {
    lines.push("Soulagement");
  }

  if (analysis.promptingBotToSpeak === true) {
    lines.push("Pousse le bot à parler");
  }

  if (analysis.sufficientClosure === true) {
    lines.push("Clôture");
  }

  if (analysis.crisisResolved === true) {
    lines.push("Crise résolue");
  }

  return [...new Set(lines)];
}

function buildDebugPayload({
  analysis = {},
  flags = {},
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE
} = {}) {
  return buildDebugLines({ analysis, flags, primaryState, secondaryState });
}


// --------------------------------------------------
// ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const previousHistory = Array.isArray(req.body?.previousHistory) ? req.body.previousHistory : [];
    const summary = String(req.body?.summary ?? "");
    const isNewSession = Boolean(req.body?.isNewSession);
    const flags = normalizeSessionFlags(req.body?.flags);

    const safeIsNewSession = isNewSession && previousHistory.length > 0;
    const sessionRestarted = safeIsNewSession;

    let newSummary = summary;

    if (sessionRestarted) {
      newSummary = await summarizeSession(client, previousHistory, summary);
    }

    const analysis = await analyzeMessage(client, userMessage, history, flags);
    const newFlags = normalizeSessionFlags(flags);

    if (analysis.suicideLevel === "N2") {
      newFlags.congruenceEscalation = 0;
      newFlags.acuteCrisis = true;

      const reply = n2Response();
      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: analysis.primaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (flags.acuteCrisis === true) {
      if (analysis.crisisResolved === true) {
        newFlags.acuteCrisis = false;
        newFlags.congruenceEscalation = 0;
      } else {
        newFlags.acuteCrisis = true;
        newFlags.congruenceEscalation = 0;

        const reply = acuteCrisisFollowupResponse();
        const debug = buildDebugPayload({
          analysis,
          flags: newFlags,
          primaryState: analysis.primaryState,
          secondaryState: analysis.secondaryState
        });

        return res.json({
          reply,
          debug,
          summary: newSummary,
          flags: newFlags,
          isNewSession: safeIsNewSession,
          sessionRestarted
        });
      }
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      newFlags.congruenceEscalation = 0;

      const reply = await n1ResponseLLM(client, userMessage);
      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: analysis.primaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const trivialSilence = isTrivialSilence(userMessage);
    const effectivePrimaryState =
      trivialSilence && analysis.primaryState !== CONVO_STATES.CONTAINMENT
        ? CONVO_STATES.SILENCE
        : analysis.primaryState;

    newFlags.congruenceEscalation = updateCongruenceEscalation(
      flags.congruenceEscalation,
      effectivePrimaryState
    );

    if (effectivePrimaryState === CONVO_STATES.BREAKDOWN) {
      const reply =
        getCongruenceEscalationReply(newFlags.congruenceEscalation) ||
        "Je préfère m’arrêter là pour le moment.";

      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: effectivePrimaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const reply = await generateFreeReply({
      client,
      userMessage,
      history,
      summary: newSummary,
      primaryState: effectivePrimaryState,
      secondaryState: analysis.secondaryState,
      reliefOrShift: analysis.reliefOrShift,
      assistantOverquestioning: assistantAskedTooMuch(history),
      promptingBotToSpeak: analysis.promptingBotToSpeak,
      congruenceResponseMode: analysis.congruenceResponseMode,
      sufficientClosure: analysis.sufficientClosure,
      investigativeDrift: analysis.investigativeDrift === true
    });

    const debug = buildDebugPayload({
      analysis,
      flags: newFlags,
      primaryState: effectivePrimaryState,
      secondaryState: analysis.secondaryState
    });

    return res.json({
      reply,
      debug,
      summary: newSummary,
      flags: newFlags,
      isNewSession: safeIsNewSession,
      sessionRestarted
    });

  } catch (err) {
    console.error("Erreur /chat:", err);

    return res.json({
      reply: "Je t’écoute.",
      debug: [],
      summary: "",
      flags: normalizeSessionFlags({}),
      isNewSession: false,
      sessionRestarted: false
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});