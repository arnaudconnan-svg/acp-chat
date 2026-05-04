"use strict";

(function attachFacilitatDebug(globalObj) {
  function toTrimmedString(value, fallback = "") {
    return typeof value === "string" ? value.trim() : fallback;
  }

  function toBooleanTrue(value) {
    return value === true;
  }

  function clamp01(value, fallback = 1.0) {
    return typeof value === "number" ? Math.max(0, Math.min(1, value)) : fallback;
  }

  function clamp100(value, fallback = 0) {
    return Number.isFinite(value)
      ? Math.max(0, Math.min(100, Math.round(Number(value))))
      : fallback;
  }

  function normalizePipelineStages(pipelineStages) {
    if (!Array.isArray(pipelineStages)) {
      return [];
    }

    return pipelineStages
      .map(function mapStage(entry) {
        return {
          stage: typeof (entry && entry.stage) === "string" ? entry.stage : null,
          deltaMs: Number.isFinite(entry && entry.deltaMs) ? entry.deltaMs : null
        };
      })
      .filter(function keepValid(entry) {
        return !!entry.stage;
      });
  }

  function normalizeInfoSignal(value) {
    var raw = toTrimmedString(value, "");
    if (raw === "app") return "app_features";
    if (["pure", "psychoeducation", "app_features"].indexOf(raw) >= 0) return raw;
    return null;
  }

  function normalizeContactSignal(value) {
    var raw = toTrimmedString(value, "");
    if (["regulated", "dysregulated"].indexOf(raw) >= 0) return raw;
    return null;
  }

  function normalizeSecondaryTension(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    var rawFamily = toTrimmedString(value.family, "").toLowerCase();
    var canonicalFamily = rawFamily
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "");

    var familyAliases = {
      discharge: "discharge",
      decharge: "discharge",
      emotional_discharge: "discharge",
      info: "info",
      information: "info",
      informational: "info",
      exploration: "exploration",
      stabilization: "stabilization",
      stabilisation: "stabilization",
      alliance_rupture: "alliance_rupture",
      alliancerupture: "alliance_rupture",
      rupture_alliance: "alliance_rupture",
      relational_rupture: "alliance_rupture",
      relationalrupture: "alliance_rupture",
      relational_friction: "alliance_rupture",
      friction_relationnelle: "alliance_rupture",
      frictionrelationnelle: "alliance_rupture"
    };

    var family = familyAliases[canonicalFamily] || null;
    if (!family) {
      return null;
    }

    var rawConfidence = toTrimmedString(value.confidence, "").toLowerCase();
    var canonicalConfidence = rawConfidence
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "");

    var confidenceAliases = {
      high: "high",
      highest: "high",
      strong: "high",
      fort: "high",
      medium: "medium",
      med: "medium",
      moderate: "medium",
      moyen: "medium",
      moyenne: "medium",
      low: "low",
      weak: "low",
      faible: "low"
    };

    return {
      family: family,
      confidence: confidenceAliases[canonicalConfidence] || "low"
    };
  }

  function normalizeDebugMeta(debugMetaValue) {
    var safe = debugMetaValue && typeof debugMetaValue === "object" ? debugMetaValue : {};

    return {
      topChips: Array.isArray(safe.topChips)
        ? safe.topChips.map(function mapChip(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      memory: toTrimmedString(safe.memory, ""),
      directivityText: toTrimmedString(safe.directivityText, "") || toTrimmedString(safe.directivityLabel, ""),
      directivityLabel: toTrimmedString(safe.directivityLabel, ""),
      conversationState: toTrimmedString(safe.conversationState, "") || toTrimmedString(safe.conversationStateKey, "") || null,
      conversationStateKey: toTrimmedString(safe.conversationStateKey, "") || toTrimmedString(safe.conversationState, "") || null,
      consecutiveNonExplorationTurns: Number.isInteger(safe.consecutiveNonExplorationTurns)
        ? Math.max(0, safe.consecutiveNonExplorationTurns)
        : 0,
      infoSignal: normalizeInfoSignal(safe.infoSignal),
      contactSignal: normalizeContactSignal(safe.contactSignal),
      interpretationRejection: toBooleanTrue(safe.interpretationRejection),
      needsSoberReadjustment: toBooleanTrue(safe.needsSoberReadjustment),
      relationalAdjustmentActive: (safe.relationalAdjustmentActive ?? safe.relationalAdjustmentTriggered) === true,
      relationalAdjustmentTriggered: toBooleanTrue(safe.relationalAdjustmentTriggered),
      pipelineStages: normalizePipelineStages(safe.pipelineStages),
      explorationCalibrationLevel: Number.isInteger(safe.explorationCalibrationLevel) ? safe.explorationCalibrationLevel : null,
      explorationSignal: toTrimmedString(safe.explorationSignal, "") || null,
      memoryRewriteIntent: safe.memoryRewriteIntent && typeof safe.memoryRewriteIntent === "object"
        ? {
            compressionRequested: toBooleanTrue(safe.memoryRewriteIntent.compressionRequested),
            interpretationRejectionActive: toBooleanTrue(safe.memoryRewriteIntent.interpretationRejectionActive),
            rejectsUnderlyingPhenomenon: toBooleanTrue(safe.memoryRewriteIntent.rejectsUnderlyingPhenomenon),
            soberReadjustmentActive: toBooleanTrue(safe.memoryRewriteIntent.soberReadjustmentActive),
            lectureBotForcedReset: toBooleanTrue(safe.memoryRewriteIntent.lectureBotForcedReset)
          }
        : null,
      memoryCompressed: toBooleanTrue(safe.memoryCompressed),
      memoryAge: Number.isInteger(safe.memoryAge) && safe.memoryAge > 0 ? safe.memoryAge : 0,
      memoryBeforeCompression: toTrimmedString(safe.memoryBeforeCompression, "") || null,
      criticTriggered: toBooleanTrue(safe.criticTriggered),
      criticIssues: Array.isArray(safe.criticIssues)
        ? safe.criticIssues.map(function mapIssue(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      criticOriginalReply: toTrimmedString(safe.criticOriginalReply, "") || null,
      criticTriggerReasons: Array.isArray(safe.criticTriggerReasons)
        ? safe.criticTriggerReasons.map(function mapReason(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      writerMode: toTrimmedString(safe.writerMode, "") || null,
      intent: toTrimmedString(safe.intent, "") || null,
      forbidden: Array.isArray(safe.forbidden)
        ? safe.forbidden.map(function mapForbidden(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      confidenceSignal: clamp01(safe.confidenceSignal, 1.0),
      responseRegister: toTrimmedString(safe.responseRegister, "") || "courant",
      phraseLengthPolicy: toTrimmedString(safe.phraseLengthPolicy, "") || "moyenne",
      relancePolicy: toTrimmedString(safe.relancePolicy, "") || "selective",
      useDirectAddress: toBooleanTrue(safe.useDirectAddress),
      somaticFocusPolicy: toTrimmedString(safe.somaticFocusPolicy, "") || "none",
      actionCollapseGuardActive: toBooleanTrue(safe.actionCollapseGuardActive),
      stateTransitionFrom: toTrimmedString(safe.stateTransitionFrom, "") || null,
      stateTransitionValid: safe.stateTransitionValid !== false,
      stateTransitionRequested: toTrimmedString(safe.stateTransitionRequested, "") || null,
      allianceSignal: toTrimmedString(safe.allianceSignal, "") || "good",
      engagementLevel: toTrimmedString(safe.engagementLevel, "") || "active",
      stagnationTurns: Number.isInteger(safe.stagnationTurns) ? Math.max(0, safe.stagnationTurns) : 0,
      processingWindow: toTrimmedString(safe.processingWindow, "") || "open",
      dependencyRiskScore: clamp100(safe.dependencyRiskScore, 0),
      dependencyRiskLevel: toTrimmedString(safe.dependencyRiskLevel, "") || "low",
      externalSupportMode: toTrimmedString(safe.externalSupportMode, "") || "none",
      closureIntent: toBooleanTrue(safe.closureIntent),
      infoRoutingSource: toTrimmedString(safe.infoRoutingSource, "") || null,
      affiliationScore: typeof safe.affiliationScore === "number" ? safe.affiliationScore : null,
      affiliationWindow: Array.isArray(safe.affiliationWindow)
        ? safe.affiliationWindow.map(function mapAffiliation(v) {
            return typeof v === "number" ? Math.round(v * 100) / 100 : 0;
          })
        : [],
      affiliationEstablished: toBooleanTrue(safe.affiliationEstablished),
      emotionalDecentering: toBooleanTrue(safe.emotionalDecentering),
      formalAddress: toBooleanTrue(safe.formalAddress),
      writerIntentHints: Array.isArray(safe.writerIntentHints)
        ? safe.writerIntentHints.map(function mapHint(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      contactInsightMoment: toBooleanTrue(safe.contactInsightMoment),
      contactSelfCriticismLevel: toTrimmedString(safe.contactSelfCriticismLevel, "") || "low",
      contactMeaningCrisis: toBooleanTrue(safe.contactMeaningCrisis),
      aggressiveDischargeDetected: toBooleanTrue(safe.aggressiveDischargeDetected),
      postDischargeTransitionActive: toBooleanTrue(safe.postDischargeTransitionActive),
      n2TurnType: toTrimmedString(safe.n2TurnType, "") || null,
      emergencyNumbersIncluded: toBooleanTrue(safe.emergencyNumbersIncluded),
      postCrisisSupportActive: toBooleanTrue(safe.postCrisisSupportActive),
      postCrisisSupportCarryTurn: toBooleanTrue(safe.postCrisisSupportCarryTurn),
      emergencySupportText: toTrimmedString(safe.emergencySupportText, "") || null,
      secondaryTension: normalizeSecondaryTension(safe.secondaryTension)
    };
  }

  function translateWriterMode(mode) {
    var map = {
      exploration_open: "exploration ouverte",
      exploration_restrained: "exploration guid\u00e9e",
      post_contact: "exploration ouverte (legacy)",
      stabilization: "stabilisation",
      alliance_rupture: "rupture d'alliance",
      closure: "cl\u00f4ture",
      contact: "exploration ouverte (legacy)",
      discharge_regulated: "d\u00e9charge r\u00e9gul\u00e9e",
      discharge_dysregulated: "d\u00e9charge d\u00e9r\u00e9gul\u00e9e",
      info_pure: "info pure",
      info_psychoeducation: "info psycho\u00e9ducation",
      info_app_features: "info app",
      n1_crisis: "crise N1"
    };
    return map[mode] || mode;
  }

  function translateForbidden(value) {
    var map = {
      prescriptive_language: "langage prescriptif",
      relance: "relance",
      interpretive_hypothesis: "hypoth\u00e8ses interpr\u00e9tatives",
      open_question: "question ouverte",
      list: "liste",
      self_justification: "auto-justification",
      recap: "r\u00e9capitulatif",
      single_anchor_proposal: "proposition d'ancrage",
      action_concrete_proposal: "proposition d'action concr\u00e8te",
      value_affirmation: "affirmation de valeur",
      casual_register: "registre vivant suspendu"
    };
    return map[value] || value;
  }

  function translateRegister(value) {
    if (value === "familier") return "familier";
    if (value === "soutenu") return "soutenu";
    return "courant";
  }

  function translatePhraseLengthPolicy(value) {
    if (value === "courte") return "phrases courtes";
    return "phrases moyennes";
  }

  function translateExplorationSignal(value) {
    if (value === "interpretation") return "interpretation";
    if (value === "phenomenological_follow") return "accompagnement phenomenologique";
    return value;
  }

  function translateRelancePolicy(value) {
    if (value === "forbidden") return "interdite";
    if (value === "discouraged") return "d\u00e9conseill\u00e9e";
    if (value === "open") return "ouverte";
    if (value === "selective") return "s\u00e9lective";
    return value;
  }

  function translateAttentionQuality(value) {
    if (value === "narrowed") return "restreinte";
    if (value === "overloaded") return "surcharg\u00e9e";
    return value;
  }

  function translateAttentionEngagement(value) {
    if (value === "passive") return "passif";
    if (value === "withdrawn") return "en retrait";
    return value;
  }

  function translateWriterHint(value) {
    var map = {
      affiliation_first_join: "prioriser le sentiment d'etre compris et rejoint",
      aggressive_discharge_minimal_presence: "decharge agressive: presence minimale",
      post_discharge_soft_landing: "atterrissage doux post-decharge",
      hold_emotional_thread: "maintenir le fil \u00e9motionnel",
      auto_compassion_door_open: "invitation \u00e0 l'auto-compassion",
      signify_pain_without_blocking: "signifier la douleur sans bloquer",
      amplify_insight: "amplifier l'insight",
      attention_narrow_single_axis: "attention restreinte: rester sur un seul axe",
      alliance_fragile_sensitive: "alliance fragile — avancée avec soin",
      alliance_restored_presence: "retour d'alliance",
      engagement_withdrawn_noticed: "retrait d'engagement not\u00e9"
    };
    return map[value] || value;
  }

  function translateOrientationHint(value) {
    if (value === "unfinished_business_subtle_opening") return "ouverture subtile sur l'inachev\u00e9";
    return value;
  }

  function translateSomaticFocusPolicy(value) {
    if (value === "prioritize_somatic_proximity") return "priorite proximite somatique";
    if (value === "address_frustration_before_somatic_relocalization") return "frustration d'abord, pas de relocalisation imposee";
    return "aucune";
  }

  function translateConfidenceSignal(value) {
    if (value === "low") return "faible";
    if (value === "high") return "\u00e9lev\u00e9";
    return value;
  }

  function translateInfoRoutingSource(value) {
    if (!value) return null;
    if (value === "deterministic_app_features" || value === "deterministic_human_field") return "d\u00e9terministe";
    if (value === "llm") return "LLM";
    if (value === "llm_fallback") return "LLM (fallback)";
    return value;
  }

  function buildNaturalDebugSummary(meta, variant) {
    var lines = [];

    if (meta.interpretationRejection === true) {
      if (variant === "admin") {
        lines.push("Un rejet d'interpretation a ete detecte et pris en compte.");
      } else {
        lines.push("Le systeme a detecte un rejet d'interpretation et a recentre la reponse.");
      }
    }

    if (meta.needsSoberReadjustment === true) {
      if (variant === "admin") {
        lines.push("Un reajustement sobre a ete applique sur ce tour.");
      } else {
        lines.push("Un reajustement sobre a ete applique pour reduire la pression de la reponse.");
      }
    }

    if (meta.relationalAdjustmentActive === true || meta.relationalAdjustmentTriggered === true) {
      if (variant === "admin") {
        lines.push("Un ajustement relationnel a ete declenche.");
      } else {
        lines.push("Un ajustement relationnel a ete declenche pour proteger l'alliance.");
      }
    }

    if (meta.stagnationTurns > 0) {
      lines.push("Stagnation detectee depuis " + meta.stagnationTurns + " tour(s).");
    }

    if (meta.dependencyRiskLevel && meta.dependencyRiskLevel !== "low") {
      lines.push("Risque de dependance estime: " + meta.dependencyRiskLevel + " (" + meta.dependencyRiskScore + "/100).");
    }

    if (meta.externalSupportMode && meta.externalSupportMode !== "none") {
      lines.push("Rapport au soutien externe detecte: " + meta.externalSupportMode + ".");
    }

    if (meta.closureIntent === true) {
      lines.push("Une intention de cloture de session a ete detectee.");
    }

    if (meta.criticTriggered === true) {
      var criticReasonLabels = {
        contractLengthExceeded: "Longueur contractuelle d\u00e9pass\u00e9e",
        humanFieldRisk: "Risque de ton proc\u00e9dural/instrumental",
        formalAddressRisk: "Risque de tutoiement non conforme",
        vouvoiementRisk: "Risque de vouvoiement non conforme",
        theoreticalViolationRisk: "Risque de formulation th\u00e9orique/interpr\u00e9tative",
        n1CrisisForced: "D\u00e9clenchement forc\u00e9 en crise N1",
        recallForced: "D\u00e9clenchement forc\u00e9 en rappel m\u00e9moire"
      };
      var reasons = (meta.criticTriggerReasons || []).map(function mapReason(r) {
        return criticReasonLabels[r] || r;
      }).filter(Boolean);

      if (meta.criticIssues.length > 0) {
        lines.push("Le critic pass a corrig\u00e9 " + meta.criticIssues.length + " point(s) :");
        meta.criticIssues.forEach(function eachIssue(issue) {
          lines.push("\u00b7 " + issue);
        });
      } else {
        lines.push("Le critic pass a \u00e9t\u00e9 lanc\u00e9 sans correction n\u00e9cessaire.");
      }

      if (reasons.length > 0) {
        lines.push("Raisons : " + reasons.join(" \u00b7 "));
      }
    }

    return lines;
  }

  function buildMemoryRewriteIntentLines(meta) {
    var intent = meta && meta.memoryRewriteIntent && typeof meta.memoryRewriteIntent === "object"
      ? meta.memoryRewriteIntent
      : null;

    if (!intent) return [];

    var lines = [];
    if (intent.compressionRequested === true) {
      lines.push("Compression m\u00e9moire demand\u00e9e");
    }
    if (intent.interpretationRejectionActive === true) {
      lines.push("R\u00e9\u00e9criture motiv\u00e9e par un rejet d'interpr\u00e9tation");
    }
    if (intent.rejectsUnderlyingPhenomenon === true) {
      lines.push("Le ph\u00e9nom\u00e8ne sous-jacent a \u00e9t\u00e9 rejet\u00e9");
    }
    if (intent.soberReadjustmentActive === true) {
      lines.push("R\u00e9\u00e9criture motiv\u00e9e par un r\u00e9ajustement sobre");
    }
    if (intent.lectureBotForcedReset === true) {
      lines.push("Lecture bot forc\u00e9e \u00e0 '-' par r\u00e8gle d'\u00e9tat");
    }

    return lines;
  }

  function buildPipelineRuntimeText(meta) {
    if (!meta || !Array.isArray(meta.pipelineStages) || meta.pipelineStages.length === 0) {
      return "";
    }

    var totalMs = meta.pipelineStages.reduce(function sum(acc, stage) {
      return acc + (Number.isFinite(stage.deltaMs) ? stage.deltaMs : 0);
    }, 0);

    return "Temps de reponse global: " + totalMs + " ms (" + meta.pipelineStages.length + " etape(s)).";
  }

  function formatSecondaryTension(secondaryTension) {
    var st = normalizeSecondaryTension(secondaryTension);
    if (!st) return null;

    var familyMap = {
      discharge: "D\u00e9charge",
      info: "Info",
      exploration: "Exploration",
      alliance_rupture: "Rupture d'alliance",
      stabilization: "Stabilisation"
    };

    var confMap = {
      high: "fort",
      medium: "mod\u00e9r\u00e9",
      low: "faible"
    };

    return {
      familyLabel: familyMap[st.family] || st.family,
      confidenceLabel: confMap[st.confidence] || st.confidence,
      normalized: st
    };
  }

  globalObj.FacilitatDebug = {
    normalizePipelineStages: normalizePipelineStages,
    normalizeSecondaryTension: normalizeSecondaryTension,
    normalizeDebugMeta: normalizeDebugMeta,
    translateWriterMode: translateWriterMode,
    translateForbidden: translateForbidden,
    translateRegister: translateRegister,
    translatePhraseLengthPolicy: translatePhraseLengthPolicy,
    translateExplorationSignal: translateExplorationSignal,
    translateRelancePolicy: translateRelancePolicy,
    translateAttentionQuality: translateAttentionQuality,
    translateAttentionEngagement: translateAttentionEngagement,
    translateWriterHint: translateWriterHint,
    translateOrientationHint: translateOrientationHint,
    translateSomaticFocusPolicy: translateSomaticFocusPolicy,
    translateConfidenceSignal: translateConfidenceSignal,
    translateInfoRoutingSource: translateInfoRoutingSource,
    buildNaturalDebugSummary: buildNaturalDebugSummary,
    buildMemoryRewriteIntentLines: buildMemoryRewriteIntentLines,
    buildPipelineRuntimeText: buildPipelineRuntimeText,
    formatSecondaryTension: formatSecondaryTension
  };
})(window);
