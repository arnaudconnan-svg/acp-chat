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

    function normalizeMovementList(items, maxItems) {
      if (!Array.isArray(items)) return [];
      var normalized = items
        .map(function(item) {
          if (!item || typeof item !== "object") return null;
          var id = toTrimmedString(item.id, "");
          var text = typeof item.text === "string" ? item.text.trim() : "";
          if (!id && !text) return null;
          return {
            id: id,
            text: text,
            createdAt: toTrimmedString(item.createdAt, "") || null,
            archivedAt: toTrimmedString(item.archivedAt, "") || null
          };
        })
        .filter(Boolean);

      if (Number.isInteger(maxItems) && maxItems > 0) {
        return normalized.slice(0, maxItems);
      }
      return normalized;
    }

    var safeMemoryState = safe.memoryState && typeof safe.memoryState === "object" ? safe.memoryState : null;
    var normalizedMemoryState = safeMemoryState
      ? {
          sessionStableContext: Array.isArray(safeMemoryState.sessionStableContext)
            ? safeMemoryState.sessionStableContext.map(function(item) { return toTrimmedString(item, ""); }).filter(Boolean)
            : [],
          onGoingMovements: normalizeMovementList(safeMemoryState.onGoingMovements, 2),
          ancientMovements: normalizeMovementList(safeMemoryState.ancientMovements),
          pastSignals: safeMemoryState.pastSignals && typeof safeMemoryState.pastSignals === "object" && !Array.isArray(safeMemoryState.pastSignals)
            ? safeMemoryState.pastSignals
            : {}
        }
      : null;

    return {
      topChips: Array.isArray(safe.topChips)
        ? safe.topChips.map(function mapChip(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      memory: toTrimmedString(safe.memory, ""),
      memoryState: normalizedMemoryState,
      intersessionMemoryRuntime: toTrimmedString(safe.intersessionMemoryRuntime, "") || null,
      memoryAncientCleanupDeletedIds: Array.isArray(safe.memoryAncientCleanupDeletedIds)
        ? safe.memoryAncientCleanupDeletedIds.map(function mapDeletedId(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      directivityText: toTrimmedString(safe.directivityText, "") || toTrimmedString(safe.directivityLabel, ""),
      directivityLabel: toTrimmedString(safe.directivityLabel, ""),
      conversationState: toTrimmedString(safe.conversationState, "") || null,
      consecutiveNonExplorationTurns: Number.isInteger(safe.consecutiveNonExplorationTurns)
        ? Math.max(0, safe.consecutiveNonExplorationTurns)
        : 0,
      infoSignal: normalizeInfoSignal(safe.infoSignal),
      contactSignal: normalizeContactSignal(safe.contactSignal),
      interpretationRejection: toBooleanTrue(safe.interpretationRejection),
      needsSoberReadjustment: toBooleanTrue(safe.needsSoberReadjustment),
      relationalAdjustmentActive: toBooleanTrue(safe.relationalAdjustmentActive),
      pipelineStages: normalizePipelineStages(safe.pipelineStages),
      explorationCalibrationLevel: Number.isInteger(safe.explorationCalibrationLevel) ? safe.explorationCalibrationLevel : null,
      explorationSignal: toTrimmedString(safe.explorationSignal, "") || null,
      memoryBeforeSanitization: toTrimmedString(safe.memoryBeforeSanitization, "") || null,
      outputGuardTriggered: toBooleanTrue(safe.outputGuardTriggered),
      outputGuardRegenerationUsed: toBooleanTrue(safe.outputGuardRegenerationUsed),
      outputGuardFallbackUsed: toBooleanTrue(safe.outputGuardFallbackUsed),
      outputGuardViolations: Array.isArray(safe.outputGuardViolations)
        ? safe.outputGuardViolations.map(function mapViolation(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      outputGuardEvidence: Array.isArray(safe.outputGuardEvidence)
        ? safe.outputGuardEvidence.map(function mapEvidence(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      analyzerDeterministicEvidence: Array.isArray(safe.analyzerDeterministicEvidence)
        ? safe.analyzerDeterministicEvidence.map(function mapAnalyzerEvidence(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
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
      stagnationWindow: Array.isArray(safe.stagnationWindow)
        ? safe.stagnationWindow.map(function mapStagnation(v) { return v === true; }).slice(-4)
        : [],
      attentionWindow: toTrimmedString(safe.attentionWindow, "") || "open",
      dependencyRiskScore: clamp100(safe.dependencyRiskScore, 0),
      dependencyRiskLevel: toTrimmedString(safe.dependencyRiskLevel, "") || "low",
      isolationScore: clamp100(safe.isolationScore, 0),
      attachmentScore: clamp100(safe.attachmentScore, 0),
      dependencyCareMessagePending: ['medium', 'high'].indexOf(safe.dependencyCareMessagePending) !== -1 ? safe.dependencyCareMessagePending : false,
      externalSupportMode: toTrimmedString(safe.externalSupportMode, "") || "none",
      closureIntent: toBooleanTrue(safe.closureIntent),
      infoRoutingSource: toTrimmedString(safe.infoRoutingSource, "") || null,
      affiliationScore: typeof safe.affiliationScore === "number" ? safe.affiliationScore : null,
      affiliationFinalScore: typeof safe.affiliationFinalScore === "number" ? safe.affiliationFinalScore : null,
      affiliationWindow: Array.isArray(safe.affiliationWindow)
        ? safe.affiliationWindow.map(function mapAffiliation(v) {
            return typeof v === "number" ? Math.round(v * 100) / 100 : 0;
          })
        : [],
      affiliationEstablished: toBooleanTrue(safe.affiliationEstablished),
      somaticSignalAnalysis: safe.somaticSignalAnalysis && typeof safe.somaticSignalAnalysis === "object" && !Array.isArray(safe.somaticSignalAnalysis)
        ? {
            somaticSignalActive: toBooleanTrue(safe.somaticSignalAnalysis.somaticSignalActive),
            somaticLocalizationBlocked: toBooleanTrue(safe.somaticSignalAnalysis.somaticLocalizationBlocked),
            regexMatch: toTrimmedString(safe.somaticSignalAnalysis.regexMatch, "") || null,
            source: toTrimmedString(safe.somaticSignalAnalysis.source, "") || null
          }
        : null,
      emotionalDecentering: toBooleanTrue(safe.emotionalDecentering),
      formalAddress: toBooleanTrue(safe.formalAddress),
      writerIntentHints: Array.isArray(safe.writerIntentHints)
        ? safe.writerIntentHints.map(function mapHint(v) { return String(v || "").trim(); }).filter(Boolean)
        : [],
      writerIntentHintsInactive: Array.isArray(safe.writerIntentHintsInactive)
        ? safe.writerIntentHintsInactive
            .map(function mapInactiveHint(entry) {
              if (!entry || typeof entry !== "object") return null;
              var hint = toTrimmedString(entry.hint, "");
              var reason = toTrimmedString(entry.reason, "");
              if (!hint || !reason) return null;
              return { hint: hint, reason: reason };
            })
            .filter(Boolean)
        : [],
      contactInsightMoment: toBooleanTrue(safe.contactInsightMoment),
      contactSelfCriticismLevel: toTrimmedString(safe.contactSelfCriticismLevel, "") || "low",
      contactMeaningCrisis: toBooleanTrue(safe.contactMeaningCrisis),
      aggressiveDischargeDetected: toBooleanTrue(safe.aggressiveDischargeDetected),
      postDischargeTransitionActive: toBooleanTrue(safe.postDischargeTransitionActive),
      n2TurnType: toTrimmedString(safe.n2TurnType, "") || null,
      emergencyNumbersIncluded: toBooleanTrue(safe.emergencyNumbersIncluded),
      postCrisisSupportActive: toBooleanTrue(safe.postCrisisSupportActive),
      emergencySupportText: toTrimmedString(safe.emergencySupportText, "") || null,
      requestId: toTrimmedString(safe.requestId, "") || null,
      traceId: toTrimmedString(safe.traceId, "") || null,
      secondaryTension: normalizeSecondaryTension(safe.secondaryTension)
    };
  }

  function translateWriterMode(mode) {
    var map = {
      exploration_open: "exploration ouverte",
      exploration_restrained: "exploration restreinte",
      stabilization: "stabilisation",
      alliance_rupture: "rupture d'alliance",
      closure: "cl\u00f4ture",
      discharge_regulated: "d\u00e9charge r\u00e9gul\u00e9e",
      discharge_dysregulated: "d\u00e9charge d\u00e9r\u00e9gul\u00e9e",
      info_pure: "info pure",
      info_psychoeducation: "info psycho\u00e9ducation",
      info_features: "info fonctionnalites de l'app",
      n1_crisis: "crise N1",
      n2_crisis: "crise N2"
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
      affiliation_first_join: "prioriser le sentiment d'etre compris et rejoint (affiliation toujours en cours)",
      aggressive_discharge_minimal_presence: "decharge agressive: presence minimale",
      post_discharge_soft_landing: "atterrissage doux post-decharge",
      hold_emotional_thread: "maintenir le fil \u00e9motionnel",
      auto_compassion_door_open: "invitation \u00e0 l'auto-compassion",
      signify_pain_without_blocking: "signifier la douleur sans bloquer",
      amplify_insight: "amplifier l'insight",
      attention_narrow_single_axis: "attention restreinte: rester sur un seul axe",
      alliance_fragile_sensitive: "alliance fragile — avancée avec soin",
      alliance_restored_presence: "retour d'alliance",
      engagement_withdrawn_noticed: "retrait d'engagement not\u00e9",
      stagnation_noticed: "enlisement not\u00e9",
      meaning_crisis_witnessed: "effondrement de sens reconnu",
      formal_address_adopted: "passage au vouvoiement adopt\u00e9",
      formal_address_transition_query: "retour au tutoiement — question pos\u00e9e",
      relational_adjustment_noticed: "friction relationnelle reconnue",
      procedural_temptation_light: "tentation proc\u00e9durale \u2014 auto-d\u00e9rision",
      procedural_temptation_neutral: "tentation proc\u00e9durale \u2014 sobre",
      attention_overloaded_noticed: "surcharge attentionnelle not\u00e9e",
      dependency_care_expressed_medium: "lucidit\u00e9 relationnelle (medium)",
      dependency_care_expressed_high: "lucidit\u00e9 relationnelle (high)"
    };
    return map[value] || value;
  }

  function translateWriterHintInactiveReason(value) {
    var map = {
      affiliation_not_established: "affiliation fonctionnelle non \u00e9tablie"
    };
    return map[value] || value;
  }

  function formatInactiveWriterHints(items) {
    if (!Array.isArray(items)) return [];
    return items
      .map(function mapInactiveItem(entry) {
        if (!entry || typeof entry !== "object") return null;
        if (!entry.hint || !entry.reason) return null;
        return "Indication inactive : " + translateWriterHint(entry.hint) + " (raison : " + translateWriterHintInactiveReason(entry.reason) + ")";
      })
      .filter(Boolean);
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

  function parseDeterministicEvidence(evidenceEntries) {
    if (!Array.isArray(evidenceEntries)) return {};
    var result = {};
    for (var i = 0; i < evidenceEntries.length; i += 1) {
      var text = String(evidenceEntries[i] || "").trim();
      if (!text) continue;
      var keyMatch = text.match(/^([a-z0-9_]+)/i);
      var key = keyMatch && keyMatch[1] ? keyMatch[1].toLowerCase() : null;
      if (!key) continue;
      var quotedMatch = text.match(/\|\s*match:\s*"([^"]+)"/i);
      var rawMatch = quotedMatch && quotedMatch[1] ? quotedMatch[1] : null;
      if (rawMatch && !/^none$/i.test(rawMatch)) {
        result[key] = rawMatch;
      }
    }
    return result;
  }

  function enrichLineWithMatch(text, matchMap, guardKeys) {
    if (!matchMap || !Array.isArray(guardKeys) || guardKeys.length === 0) return text;
    for (var i = 0; i < guardKeys.length; i += 1) {
      var key = String(guardKeys[i] || "").toLowerCase();
      if (matchMap[key]) {
        return String(text || "") + ' (regex match: "' + matchMap[key] + '")';
      }
    }
    return text;
  }

  function buildSomaticFocusPolicyDebugLine(meta) {
    if (!meta || !meta.somaticFocusPolicy || meta.somaticFocusPolicy === "none") {
      return null;
    }

    var policyLabel = translateSomaticFocusPolicy(meta.somaticFocusPolicy);
    var baseLine = "Politique somatique : " + policyLabel;
    var analyzerMatchMap = parseDeterministicEvidence(meta.analyzerDeterministicEvidence);

    if (meta.somaticFocusPolicy === "address_frustration_before_somatic_relocalization") {
      return enrichLineWithMatch(baseLine, analyzerMatchMap, ["somatic_localization_guard_active", "somatic_signal_guard_active"]);
    }

    if (meta.somaticFocusPolicy === "prioritize_somatic_proximity") {
      return enrichLineWithMatch(baseLine, analyzerMatchMap, ["somatic_signal_guard_active"]);
    }

    return baseLine;
  }

  function buildNaturalDebugSummary(meta, variant) {
    var lines = [];
    var analyzerMatchMap = parseDeterministicEvidence(meta.analyzerDeterministicEvidence);

    if (meta.interpretationRejection === true) {
      var interpretationLine = variant === "admin"
        ? "Un rejet d'interpretation a ete detecte et pris en compte."
        : "Le systeme a detecte un rejet d'interpretation et a recentre la reponse.";
      lines.push(enrichLineWithMatch(interpretationLine, analyzerMatchMap, ["interpretation_rejection_guard_no_signal"]));
    }

    if (meta.needsSoberReadjustment === true) {
      if (variant === "admin") {
        lines.push("Un reajustement sobre a ete applique sur ce tour.");
      } else {
        lines.push("Un reajustement sobre a ete applique pour reduire la pression de la reponse.");
      }
    }

    if (meta.relationalAdjustmentActive === true) {
      var relationalLine = variant === "admin"
        ? "Un ajustement relationnel a ete declenche."
        : "Un ajustement relationnel a ete declenche pour proteger l'alliance.";
      lines.push(enrichLineWithMatch(relationalLine, analyzerMatchMap, ["relational_adjustment_guard_no_trigger"]));
    }

    if (meta.emotionalDecentering === true) {
      var decenteringLine = variant === "admin"
        ? "Un decentrage emotionnel a ete detecte."
        : "Le systeme a detecte un decentrage emotionnel.";
      lines.push(enrichLineWithMatch(decenteringLine, analyzerMatchMap, ["emotional_decentering_guard_active", "emotional_decentering_guard_llm_review"]));
    }

    if (meta.somaticSignalAnalysis && typeof meta.somaticSignalAnalysis === "object") {
      var somaticLine = meta.somaticSignalAnalysis.somaticSignalActive === true
        ? (variant === "admin" ? "Signal somatique confirme." : "Le systeme a confirme un signal somatique.")
        : (variant === "admin" ? "Signal somatique non retenu." : "Le systeme n'a pas retenu de signal somatique.");
      if (meta.somaticSignalAnalysis.regexMatch) {
        somaticLine += ' (regex: "' + meta.somaticSignalAnalysis.regexMatch + '")';
      }
      lines.push(somaticLine);
    }

    if (meta.dependencyRiskLevel && meta.dependencyRiskLevel !== "low") {
      var _careLabel = meta.dependencyRiskLevel === "high" ? "\u00e9lev\u00e9" : "mod\u00e9r\u00e9";
      var _depLine = "Risque de d\u00e9pendance : " + _careLabel + " (score global " + meta.dependencyRiskScore + "/100, isolement " + meta.isolationScore + ", attachement " + meta.attachmentScore + ")";
      if (meta.dependencyCareMessagePending) {
        _depLine += " \u2014 message de lucidit\u00e9 relationnelle en attente (" + meta.dependencyCareMessagePending + ")";
      }
      lines.push(_depLine + ".");
    }

    if (meta.externalSupportMode && meta.externalSupportMode !== "none") {
      lines.push("Rapport au soutien externe detecte: " + meta.externalSupportMode + ".");
    }

    if (meta.closureIntent === true) {
      lines.push("Une intention de cloture de session a ete detectee.");
    }

    if (meta.outputGuardTriggered === true) {
      if (meta.outputGuardFallbackUsed === true) {
        lines.push("Le garde de sortie deterministe a applique un fallback minimal apres echec de regeneration.");
      } else if (meta.outputGuardRegenerationUsed === true) {
        lines.push("Le garde de sortie deterministe a impose une regeneration ciblee du writer.");
      } else {
        lines.push("Le garde de sortie deterministe a ete declenche.");
      }

      if (Array.isArray(meta.outputGuardViolations) && meta.outputGuardViolations.length > 0) {
        lines.push("Violations detectees : " + meta.outputGuardViolations.join(" · "));
      }
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

    var runtimeText = "Temps de reponse global: " + totalMs + " ms (" + meta.pipelineStages.length + " etape(s)).";
    var requestId = meta && typeof meta.requestId === "string" ? meta.requestId.trim() : "";
    var traceId = meta && typeof meta.traceId === "string" ? meta.traceId.trim() : "";
    var correlation = [requestId ? "requestId: " + requestId : "", traceId ? "traceId: " + traceId : ""]
      .filter(Boolean)
      .join(" | ");

    return correlation ? runtimeText + " " + correlation : runtimeText;
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
    translateWriterHintInactiveReason: translateWriterHintInactiveReason,
    formatInactiveWriterHints: formatInactiveWriterHints,
    translateOrientationHint: translateOrientationHint,
    translateSomaticFocusPolicy: translateSomaticFocusPolicy,
    translateConfidenceSignal: translateConfidenceSignal,
    translateInfoRoutingSource: translateInfoRoutingSource,
    buildSomaticFocusPolicyDebugLine: buildSomaticFocusPolicyDebugLine,
    buildNaturalDebugSummary: buildNaturalDebugSummary,
    buildPipelineRuntimeText: buildPipelineRuntimeText,
    formatSecondaryTension: formatSecondaryTension,
    detectMemoryReactivationSignal: function(meta) {
      return meta && meta.memoryReactivationGuardTriggered === true
        ? "\u0047arde m\u00e9moire activ\u00e9e"
        : null;
    }
  };
})(window);
