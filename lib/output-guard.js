"use strict";

function hasAgencyInjectionInReply(reply = "") {
  const text = String(reply || "").toLowerCase();
  const patterns = [
    "tu pourrais", "essaie de", "il faudrait", "tu devrais",
    "pourquoi ne pas", "je t'encourage", "je te conseille",
    "n'hesite pas a", "n'hesite pas a", "n'hésite pas à",
    "tu devrais peut-etre", "tu devrais peut-être"
  ];
  return patterns.some((p) => text.includes(p));
}

function hasTutoiementInReply(reply = "") {
  return /\btu\b|\btoi\b|\bton\b|\bta\b|\btes\b/.test(String(reply || "").toLowerCase());
}

function hasVouvoiementInReply(reply = "", userMessage = "") {
  const replyLower = String(reply || "").toLowerCase();
  const userLower = String(userMessage || "").toLowerCase();
  const vousPattern = /\bvous\b|\bvotre\b|\bvos\b/;
  if (!vousPattern.test(replyLower)) return false;
  if (vousPattern.test(userLower)) return false;

  const falsePositivePatterns = [
    /\brendez-vous\b/i,
    /\brencontre avec\b/i
  ];

  let cleaned = replyLower;
  for (const fp of falsePositivePatterns) {
    cleaned = cleaned.replace(fp, "");
  }
  return vousPattern.test(cleaned);
}

const INTERNAL_SIGNAL_LEAK_TOKENS = [
  "exploration_open",
  "exploration_restrained",
  "discharge_regulated",
  "discharge_dysregulated",
  "info_pure",
  "info_features",
  "info_psychoeducation",
  "stabilization",
  "alliance_rupture",
  "closure",
  "n1_crisis",
  "n2_crisis",
  "etat",
  "state",
  "niveau",
  "alliance",
  "tension",
  "autocrit",
  "decentrage_emo",
  "dependance",
  "dependency"
];

const RELANCE_SOFT_PATTERNS = [
  /\?/, 
  /\bje t['']ecoute\b/i,
  /\bje vous ecoute\b/i,
  /\bdis-moi\b/i,
  /\braconte-moi\b/i,
  /\bparle-moi\b/i,
  /\bcontinue\b/i,
  /\bje suis la\b/i,
  /\bqu['']est-ce qui se passe\b/i,
  /\bqu['']est-ce qu['']il se passe\b/i
];

const OPEN_QUESTION_PATTERNS = [
  /\bcomment\b\s*\?/i,
  /\bqu['']est-ce qui\b/i,
  /\bqu['']est-ce que\b/i,
  /\bde quoi\b/i,
  /\bcomment\b/i,
  /\bpourquoi\b/i,
  /\bque ressens?-tu\b/i,
  /\bque ressentez-vous\b/i
];

const INTERPRETIVE_HYPOTHESIS_PATTERNS = [
  /\bpeut-etre que\b/i,
  /\bil semblerait\b/i,
  /\bj['']ai l['']impression que\b/i,
  /\bcomme si\b/i,
  /\bje me demande si\b/i
];

const SELF_JUSTIFICATION_PATTERNS = [
  /\bce que je voulais dire\b/i,
  /\bce que j['']essayais de faire\b/i,
  /\bje voulais simplement\b/i,
  /\bmon intention etait\b/i,
  /\bje n['']ai pas voulu\b/i
];

const RECAP_PATTERNS = [
  /\ben resume\b/i,
  /\bpour resumer\b/i,
  /\ben bref\b/i,
  /\bsi je resume\b/i
];

const VALUE_AFFIRMATION_PATTERNS = [
  /\btu as de la valeur\b/i,
  /\bvous avez de la valeur\b/i,
  /\btu es quelqu['']un de bien\b/i,
  /\bvous etes quelqu['']un de bien\b/i,
  /\btu es une bonne personne\b/i,
  /\bvous etes une bonne personne\b/i
];

const LIST_STRUCTURE_REGEX = /^\s*[-•]\s/m;
const NUMBERED_LIST_STRUCTURE_REGEX = /^\s*\d+\.\s/m;

function sentenceCount(text = "") {
  return String(text || "")
    .split(/[.!?]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean).length;
}

function hasSignalLeakRisk(replyText = "") {
  const text = String(replyText || "");
  if (!text) return false;

  const bracketSignalPattern = /\[[^\]]*(signaux?|signals?|etat|state|niveau|alliance|tension|autocrit|decentrage_emo|dependance|dependency)\s*:[^\]]*\]/i;
  if (bracketSignalPattern.test(text)) return true;

  const lower = text.toLowerCase();
  if (!(lower.includes("[") && lower.includes("]") && (lower.includes("signal") || lower.includes("signaux")))) {
    return false;
  }

  return INTERNAL_SIGNAL_LEAK_TOKENS.some((token) => lower.includes(String(token).toLowerCase()));
}

function stripSignalLeakFragments(replyText = "") {
  const text = String(replyText || "");
  if (!text) return text;

  const linePattern = /^\s*\[[^\]]*(signaux?|signals?|etat|state|niveau|alliance|tension|autocrit|decentrage_emo|dependance|dependency)[^\]]*\]\s*$/gim;
  const inlinePattern = /\s*\[[^\]]*(signaux?|signals?|etat|state|niveau|alliance|tension|autocrit|decentrage_emo|dependance|dependency)[^\]]*\]/gim;

  return text
    .replace(linePattern, "")
    .replace(inlinePattern, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function canStrictlyStripSignalLeakWithoutAmputating(originalText = "", strippedText = "") {
  const original = String(originalText || "").replace(/\s+/g, " ").trim();
  const stripped = String(strippedText || "").replace(/\s+/g, " ").trim();
  if (!stripped) return false;
  if (stripped.length >= 120) return true;
  const ratio = stripped.length / Math.max(1, original.length);
  return ratio >= 0.55;
}

function detectRelanceLike(reply = "") {
  return RELANCE_SOFT_PATTERNS.some((pattern) => pattern.test(String(reply || "")));
}

function detectOpenQuestionLike(reply = "") {
  const text = String(reply || "");
  if (!text.includes("?")) return false;
  return OPEN_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

function detectInterpretiveHypothesisLike(reply = "") {
  return INTERPRETIVE_HYPOTHESIS_PATTERNS.some((pattern) => pattern.test(String(reply || "")));
}

function detectSelfJustificationLike(reply = "") {
  return SELF_JUSTIFICATION_PATTERNS.some((pattern) => pattern.test(String(reply || "")));
}

function detectRecapLike(reply = "") {
  return RECAP_PATTERNS.some((pattern) => pattern.test(String(reply || "")));
}

function detectValueAffirmationLike(reply = "") {
  return VALUE_AFFIRMATION_PATTERNS.some((pattern) => pattern.test(String(reply || "")));
}

function detectListLike(reply = "") {
  const text = String(reply || "");
  return LIST_STRUCTURE_REGEX.test(text) || NUMBERED_LIST_STRUCTURE_REGEX.test(text);
}

function validateReplyContract({
  reply = "",
  postureDecision = {},
  message = ""
} = {}) {
  const violations = [];
  const evidence = [];

  const safeReply = String(reply || "").trim();
  const maxSentences = Number.isFinite(postureDecision.maxSentences) && postureDecision.maxSentences > 0
    ? postureDecision.maxSentences
    : null;

  if (maxSentences) {
    const count = sentenceCount(safeReply);
    if (count > maxSentences) {
      violations.push("contract_length_exceeded");
      evidence.push(`length:${count}>${maxSentences}`);
    }
  }

  if (postureDecision.formalAddress === true && hasTutoiementInReply(safeReply)) {
    violations.push("formal_address_violation");
    evidence.push("detected:tutoiement");
  }

  if (postureDecision.formalAddress !== true && hasVouvoiementInReply(safeReply, message)) {
    violations.push("informal_address_violation");
    evidence.push("detected:vouvoiement");
  }

  if (hasSignalLeakRisk(safeReply)) {
    violations.push("signal_leak");
    evidence.push("detected:signal_leak");
  }

  const forbidden = Array.isArray(postureDecision.forbidden) ? postureDecision.forbidden : [];
  for (const item of forbidden) {
    if (item === "relance" && detectRelanceLike(safeReply)) {
      violations.push("forbidden_relance");
      evidence.push("detected:relance");
    }
    if (item === "open_question" && detectOpenQuestionLike(safeReply)) {
      violations.push("forbidden_open_question");
      evidence.push("detected:open_question");
    }
    if (item === "list" && detectListLike(safeReply)) {
      violations.push("forbidden_list");
      evidence.push("detected:list");
    }
    if (item === "prescriptive_language" && hasAgencyInjectionInReply(safeReply)) {
      violations.push("forbidden_prescriptive_language");
      evidence.push("detected:prescriptive");
    }
    if (item === "action_concrete_proposal" && hasAgencyInjectionInReply(safeReply)) {
      violations.push("forbidden_action_concrete_proposal");
      evidence.push("detected:action_proposal");
    }
    if (item === "interpretive_hypothesis" && detectInterpretiveHypothesisLike(safeReply)) {
      violations.push("forbidden_interpretive_hypothesis");
      evidence.push("detected:interpretive_hypothesis");
    }
    if (item === "self_justification" && detectSelfJustificationLike(safeReply)) {
      violations.push("forbidden_self_justification");
      evidence.push("detected:self_justification");
    }
    if (item === "recap" && detectRecapLike(safeReply)) {
      violations.push("forbidden_recap");
      evidence.push("detected:recap");
    }
    if (item === "value_affirmation" && detectValueAffirmationLike(safeReply)) {
      violations.push("forbidden_value_affirmation");
      evidence.push("detected:value_affirmation");
    }
  }

  return {
    violations: Array.from(new Set(violations)),
    evidence: Array.from(new Set(evidence)),
    isValid: violations.length === 0
  };
}

function buildRepairDirectives(violations = []) {
  const directives = [];
  const set = new Set(Array.isArray(violations) ? violations : []);

  if (set.has("contract_length_exceeded")) directives.push("Respecte strictement la limite de phrases du contrat.");
  if (set.has("formal_address_violation")) directives.push("Vouvoiement obligatoire sur toute la reponse.");
  if (set.has("informal_address_violation")) directives.push("Tutoiement obligatoire sur toute la reponse.");
  if (set.has("signal_leak")) directives.push("Interdit absolu d'afficher des signaux internes, etiquettes ou annotations techniques.");
  if (set.has("forbidden_relance")) directives.push("Aucune relance ni invitation a continuer.");
  if (set.has("forbidden_open_question")) directives.push("Aucune question ouverte.");
  if (set.has("forbidden_list")) directives.push("Aucune liste ou enumeration.");
  if (set.has("forbidden_prescriptive_language") || set.has("forbidden_action_concrete_proposal")) {
    directives.push("Aucune consigne, recommandation ou proposition d'action concrete.");
  }
  if (set.has("forbidden_interpretive_hypothesis")) directives.push("Aucune hypothese interpretative.");
  if (set.has("forbidden_self_justification")) directives.push("Aucune auto-justification de ta reponse precedente.");
  if (set.has("forbidden_recap")) directives.push("Aucun recapitulatif de l'echange.");
  if (set.has("forbidden_value_affirmation")) directives.push("Ne pas formuler d'affirmation de valeur sur la personne.");

  return directives;
}

function buildDeterministicFallbackReply({
  conversationState = "exploration_open",
  formalAddress = false
} = {}) {
  const vouvoie = formalAddress === true;

  if (conversationState === "closure") {
    return vouvoie
      ? "Je prends note de votre arret ici."
      : "Je prends note de ton arret ici.";
  }

  if (conversationState === "discharge_dysregulated") {
    return vouvoie
      ? "Je reste tres simple et present avec vous, une chose a la fois."
      : "Je reste tres simple et present avec toi, une chose a la fois.";
  }

  if (conversationState === "discharge_regulated") {
    return vouvoie
      ? "Je recois l'intensite de ce moment avec vous."
      : "Je recois l'intensite de ce moment avec toi.";
  }

  if (conversationState === "stabilization") {
    return vouvoie
      ? "Je reste au plus simple avec vous dans ce qui est la."
      : "Je reste au plus simple avec toi dans ce qui est la.";
  }

  if (conversationState === "alliance_rupture") {
    return vouvoie
      ? "Je vous ai rate sur ce point et je me reajuste sobrement."
      : "Je t'ai rate sur ce point et je me reajuste sobrement.";
  }

  if (String(conversationState).startsWith("info_")) {
    return vouvoie
      ? "Je vous reponds de facon directe et concise sur votre demande."
      : "Je te reponds de facon directe et concise sur ta demande.";
  }

  if (conversationState === "n1_crisis") {
    return vouvoie
      ? "Je reste avec vous, de facon claire et contenante."
      : "Je reste avec toi, de facon claire et contenante.";
  }

  if (conversationState === "n2_crisis") {
    return vouvoie
      ? "Si vous etes en danger immediat, appelez les secours sans attendre."
      : "Si tu es en danger immediat, appelle les secours sans attendre.";
  }

  return vouvoie
    ? "Je rencontre un probleme technique sur ce tour. Pouvez-vous renvoyer votre message ?"
    : "Je rencontre un probleme technique sur ce tour. Peux-tu renvoyer ton message ?";
}

module.exports = {
  hasSignalLeakRisk,
  stripSignalLeakFragments,
  canStrictlyStripSignalLeakWithoutAmputating,
  validateReplyContract,
  buildRepairDirectives,
  buildDeterministicFallbackReply,
  sentenceCount
};
