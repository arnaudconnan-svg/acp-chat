require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());


// --------------------------------------------------
// 1) ANALYSE UNIQUE : TRIAGE + SOLUTIONS + INFO
// --------------------------------------------------

async function analyzeMessage(userMessage, history = []) {
  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte récent.

Tu dois identifier quatre choses :
1. le niveau de risque suicidaire
2. si une clarification est nécessaire
3. si la personne demande explicitement des solutions
4. si la personne pose une question d'information factuelle

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "solutionRequest": true|false,
  "infoRequest": true|false
}

Règles :

Risque suicidaire :
- N0 : pas de contenu suicidaire explicite
- N1 : idéation passive explicite (souhait de mourir, disparaître, ne plus être là), sans intention ni plan
- N2 : intention, plan, moyens, imminence, auto-agression envisagée pour soi

Règles importantes pour le risque suicidaire :
- Ne classe en N1 ou N2 que s'il existe une référence explicite ou quasi explicite à mourir, disparaître, se suicider ou se faire du mal, dans le message actuel ou dans le contexte immédiat.
- Une phrase vague, elliptique, sombre ou émotionnellement chargée ne suffit pas.
- En l'absence de contenu suicidaire explicite, choisis N0.
- N'utilise pas needsClarification simplement parce qu'un message est ambigu, bref, flou ou lourd émotionnellement.
- Si le message rapporte les paroles de quelqu'un d'autre, mets isQuote=true.
- Si ambigu entre N1 et N2, choisis N1 et needsClarification=true.
- Si le message actuel ne contient aucune référence explicite à la mort, au suicide, à la disparition ou à l'auto-agression, choisis N0, sauf si le contexte immédiat parlait déjà explicitement de cela.

Demande explicite de solutions :
solutionRequest = true seulement si la personne demande clairement :
- des idées
- des conseils
- des pistes
- des solutions
- quoi faire
- comment s'y prendre

Ne mets pas solutionRequest à true si :
- la personne explore une situation
- elle décrit un blocage sans demander explicitement de solution
- elle réfléchit à voix haute
- elle pose une question théorique ou conceptuelle
- elle évoque un problème sans demander d'aide concrète

Demande d'information factuelle :
infoRequest = true si la personne demande :
- si quelque chose existe
- si un concept, un courant, un domaine ou une approche existe
- si des recherches ont été faites
- si des auteurs ont travaillé sur un sujet
- une information historique, théorique, scientifique ou documentaire

Ne mets pas infoRequest à true si :
- la personne cherche un conseil
- elle demande quoi faire
- elle demande des idées ou des solutions
- elle explore principalement son vécu personnel
- elle pose une question dont l'objectif principal est l'introspection

Si solutionRequest est true, alors infoRequest doit être false.


Quand la personne pose une question factuelle, théorique, historique ou scientifique,
réponds directement à la question.

Dans ce cas :
- ne renvoie pas la question vers le vécu ou le ressenti de la personne
- ne reformule pas la question sous forme introspective
- ne demande pas ce que cela évoque pour elle

Réponds simplement avec l'information demandée.

Si nécessaire, tu peux ajouter une phrase courte pour relier cette information
à ce que la personne explore, mais cela reste optionnel.
`;

  const context = history
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 120,
    messages: [
      { role: "system", content: system },
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const raw = (r.choices?.[0]?.message?.content ?? "").trim();

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);

    const suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel)
      ? obj.suicideLevel
      : "N0";

    return {
      suicideLevel,
      needsClarification: obj.needsClarification === true,
      isQuote: obj.isQuote === true,
      solutionRequest: obj.solutionRequest === true,
      infoRequest: obj.solutionRequest === true ? false : obj.infoRequest === true,
    };
  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      solutionRequest: false,
      infoRequest: false,
    };
  }
}


// --------------------------------------------------
// 2) N1 — CLARIFICATION DOUCE
// --------------------------------------------------

function n1Fallback() {
  return "Tu parles d’une envie de disparaître, ou d’une intention de te faire du mal ?";
}

async function n1ResponseLLM(userMessage) {
  const system = `
Tu réponds de manière brève, claire et non dramatique.
Tu t'adresses à la personne en la tutoyant.
Tu ne donnes pas de conseil.

Objectif unique : clarifier si la personne parle
- d'une envie de disparaître / ne plus être là
ou
- d'une intention de se suicider
ou
- des paroles de quelqu'un d'autre.

Réponse en une phrase maximum.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
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


// --------------------------------------------------
// 3) N2 — URGENCE
// --------------------------------------------------

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 (ou le 15). En France tu peux aussi appeler le 3114. Si tu peux, ne reste pas seul.";
}


// --------------------------------------------------
// 4) RÉSUMÉ INTER-SESSIONS
// --------------------------------------------------

async function summarizeSession(previousHistory = [], previousSummary = "") {
  if (!previousHistory || previousHistory.length === 0) return previousSummary;

  const transcript = previousHistory
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");

  const system = `
Tu résumes des échanges entre une personne et un assistant d'écoute.

But :
- conserver uniquement ce qui aide à comprendre la personne dans la durée
- garder les thèmes importants, émotions récurrentes, événements de vie, dynamiques notables
- écrire un résumé court, clair, humain
- ne pas donner de conseil
- si une forme de dissociation ou de déconnexion de soi a été évoquée, le faire apparaître explicitement
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    max_tokens: 220,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Résumé précédent :\n" +
          (previousSummary || "(aucun)") +
          "\n\nSession à intégrer :\n" +
          transcript +
          "\n\nNouveau résumé :"
      }
    ],
  });

  return (r.choices?.[0]?.message?.content ?? "").trim() || previousSummary;
}


// --------------------------------------------------
// 5) GÉNÉRATION LIBRE DU LLM
// --------------------------------------------------

async function generateFreeReply(
  userMessage,
  history = [],
  summary = "",
  isNewSession = false,
  solutionRequest = false,
  infoRequest = false
) {
  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.

Tutoie la personne.

Accueille ce qui est partagé tel que c'est vécu.
Soutiens l'exploration personnelle et le questionnement.
Reste du côté de l'expérience plutôt que des solutions.

Évite autant que possible les questions directes.
Quand tu ouvres quelque chose, fais-le le plus souvent par une reformulation ou une affirmation ouverte.

Les questions doivent rester rares et simples.
Évite les formulations pseudo-interrogatives ou indirectement interrogatives comme :
- "peut-être que..."
- "ça pourrait être intéressant de..."
- "est-ce que cela pourrait..."
- "peut-être que cela..."
- "tu pourrais peut-être..."

Si une question apparaît, elle doit être claire, directe et utile.
Sinon, préfère une reformulation simple.

Langage simple, chaleureux, naturel et humain.
Évite les tournures lourdes ou artificielles.

Structure tes réponses en paragraphes courts.
Saute une ligne entre deux idées importantes.
Évite les blocs de texte trop longs.

Reste au plus près de ce qui est effectivement donné par la personne.
N'invente pas de profondeur, de symbolique, d'émotion, d'intention ou de vécu non exprimé.

Si la personne exprime simplement que cela va bien, qu'elle se sent calme ou que rien de particulier ne se passe, accueille cela tel quel.
N'introduis pas d'hypothèse sur une hésitation, une ambivalence, une ouverture cachée ou une difficulté sous-jacente si cela n'est pas explicitement exprimé.

Dans ce type de situation, une reformulation simple et brève suffit.
Il n'est pas nécessaire de chercher à relancer l'exploration.

Si le message est très bref, fragmentaire, répétitif ou pauvre en contenu, reste simple, descriptif et sobre.

Quand le sens n'est pas clair, reflète simplement ce qui est là ou dis que le sens ne t'apparaît pas encore clairement.

Quand quelque chose est clair, tu peux reformuler, faire une hypothèse douce ou guider légèrement, mais sans quitter l'expérience réellement exprimée.

Si tu te trompes sur un élément concernant la personne (par exemple un fait, un mot utilisé, un genre grammatical ou une interprétation), reconnais simplement l'erreur et corrige-la.
N'invente pas d'explication vague, défensive ou spéculative pour justifier l'erreur.

Évite les formulations emphatiques, poétiques ou grandiloquentes quand elles ne sont pas justifiées par le message.

Observe comment la personne entre en contact avec son expérience.

Certaines personnes se rapprochent de leur vécu en décrivant leurs sensations ou en restant simplement présentes à ce qui se passe en elles.
D'autres s'en rapprochent en réfléchissant, en mettant des mots, en élaborant des idées ou en clarifiant leur vision.

Accueille la manière dont la personne s'y prend.

Si la personne explore activement par la réflexion, la mise en sens ou la clarification, ne freine pas ce mouvement.
Ne suggère pas d'arrêter de chercher ou de simplement laisser être.
Reconnais plutôt que cette élaboration peut faire partie de sa manière de se reconnecter à ce qu'elle vit.

À l'inverse, si la personne semble bloquée dans l'analyse ou tournée en boucle dans ses pensées, tu peux doucement l'inviter à revenir vers l'expérience.

Ne propose de simplement "laisser être", "ne rien faire" ou "juste accueillir" que si la personne semble débordée, coincée ou en lutte avec ce qu'elle ressent.
Ne propose pas cela quand la personne est déjà dans un mouvement actif d'exploration de son expérience.

Quand la personne exprime clairement de la joie, de la fierté ou de la gratitude, laisse apparaître une résonance chaleureuse plus visible.
Reconnais le mouvement vécu ou le chemin parcouru.
Sois un peu plus vivant que d'habitude, sans compliment générique ni enthousiasme artificiel.
Ne prends pas la scène : reste centré sur ce que la personne vit.

Quand la personne semble faire une découverte, clarifier quelque chose, ou se déplacer intérieurement, tu peux le reconnaître simplement.
Nommes sobrement ce qui semble bouger, se préciser, s’éclairer ou se réorganiser en elle.
Fais-le sans exagération, sans compliment, et sans attribuer plus que ce qui apparaît réellement.

Si le message ne contient pas de mots reconnaissables ou semble être du bruit, réponds très brièvement en observant simplement ce qui est écrit.
Ne formule aucune hypothèse psychologique.

Tes réponses ne suivent pas un schéma fixe.
Selon la situation, tu peux simplement refléter, reconnaître ce qui est dit, ou rester très bref.
Il n'est pas nécessaire d'ouvrir ou de relancer à chaque message.

Réponds aussi brièvement que possible tout en restant aidant.

Quand le message est court, confus, fragmentaire ou pauvre en contenu, une ou deux phrases suffisent.

N'occupe pas l'espace à la place de l'expérience de la personne.

Adapte la longueur de ta réponse à celle du message.

Quand la question est courte ou directe, réponds en une à trois phrases maximum.
`;

  const context = history
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));

  const extraSystemMessages = [];

  if (isNewSession && summary) {
    extraSystemMessages.push({
      role: "system",
      content: "Résumé des échanges précédents : " + summary
    });
  }

  if (solutionRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne demande explicitement des idées, des conseils, des pistes ou des solutions.

Reconnais d'abord cette demande de manière simple, directe et chaleureuse.

Fais comprendre clairement que cette demande est entendue et qu'elle a du sens.
Veille à ce que la réponse ne donne pas l'impression d'un abandon, d'une esquive, d'une froideur ou d'une incompétence.

Explique ensuite brièvement que ce programme ne propose pas de solutions toutes faites.
Il a été conçu pour soutenir le développement du centre d'évaluation interne de la personne, plutôt que pour orienter sa pensée à sa place.

Le développeur de ce programme part de l'idée, nourrie par son expérience de thérapeute, que donner des solutions peut parfois court-circuiter, affaiblir ou empêcher le processus d'évolution propre de l'autre.

Ne propose donc pas de liste d'idées, de pistes ou de solutions concrètes.
Ne pars pas hors sujet.

Tu peux en revanche proposer de rester avec la personne dans sa réflexion, ou de l'aider à clarifier ce qui émerge pour elle.

Réponds clairement, sobrement, humainement, et brièvement.
Trois à six phrases suffisent.
`
    });
  }

  if (infoRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne pose une question factuelle, théorique, historique, scientifique ou documentaire.

Dans ce cas, réponds normalement à la question en apportant l'information demandée.
Tu peux citer brièvement :
- des domaines de recherche
- des courants théoriques
- des approches
- des auteurs
- des tentatives déjà existantes

Reste clair, simple, pertinent et bref.
Ne renvoie pas la personne vers une introspection si elle pose une question factuelle.
Ne fais pas semblant de répondre en restant vague.
Réponds à la question posée.
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: baseSystem },
      ...extraSystemMessages,
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  if (!out) {
    return "Je t’écoute.";
  }

  return out;
}


// --------------------------------------------------
// 8) NORMALISATION FLAGS
// --------------------------------------------------

function normalizeFlags(flags) {
  return (flags && typeof flags === "object") ? flags : {};
}


// --------------------------------------------------
// 9) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const previousHistory = Array.isArray(req.body?.previousHistory) ? req.body.previousHistory : [];
    const summary = String(req.body?.summary ?? "");
    const isNewSession = Boolean(req.body?.isNewSession);
    const flags = normalizeFlags(req.body?.flags);

    const sessionRestarted = isNewSession && previousHistory.length > 0;

    let newSummary = summary;

    if (sessionRestarted) {
      newSummary = await summarizeSession(previousHistory, summary);
    }

    const analysis = await analyzeMessage(userMessage, history);

    if (analysis.suicideLevel === "N2") {
      return res.json({
        reply: n2Response(),
        summary: newSummary,
        flags,
        isNewSession,
        sessionRestarted
      });
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({
        reply,
        summary: newSummary,
        flags,
        isNewSession,
        sessionRestarted
      });
    }

    const reply = await generateFreeReply(
      userMessage,
      history,
      newSummary,
      isNewSession,
      analysis.solutionRequest,
      analysis.infoRequest
    );

    return res.json({
      reply,
      summary: newSummary,
      flags,
      isNewSession,
      sessionRestarted
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      summary: "",
      flags: normalizeFlags({}),
      isNewSession: false,
      sessionRestarted: false
    });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});