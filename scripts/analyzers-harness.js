'use strict';

const {
  createAnalyzers,
  parseClosureIntentResult,
  parseEmotionalDecenteringResult,
  parseExplorationRelanceResult,
  hasExplicitPersonalSuicideMarker,
  hasIdiomaticDeathExpressionMarker,
  hasExplicitCrisisResolutionMarker
} = require('../lib/analyzers');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function makeFakeClient() {
  return {
    chat: {
      completions: {
        create: async ({ messages = [] }) => {
          const system = String(messages?.[0]?.content || '');
          const user = String(messages?.[messages.length - 1]?.content || '');

          if (
            system.includes('ANALYZE_DISCHARGE') ||
            system.includes('dischargeSignal": "regulated|dysregulated|null"')
          ) {
            const isDischarge =
              /craque|explose|pleure|ta gueule|ferme-la|ferme la|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(
                user
              );
            const isDysregulated =
              /explose|panique|perte de controle|etouffe|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(
                user
              );
            const aggressive = /ta gueule|ferme-la|ferme la/i.test(user);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isDischarge,
                      dischargeSignal: isDischarge
                        ? isDysregulated
                          ? 'dysregulated'
                          : 'regulated'
                        : null,
                      aggressiveDischargeDirectedToBot: aggressive
                    })
                  }
                }
              ]
            };
          }

          if (system.includes('contact emotionnel non-dechargeant')) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isContact: false,
                      contactSignal: null,
                      selfCriticismLevel: 'low',
                      insightMoment: false
                    })
                  }
                }
              ]
            };
          }

          if (system.includes('reajustement relationnel')) {
            const hasFriction =
              /tu ne m'aides? pas|tu ne comprends? pas|c'est nul|laisse tomber/i.test(
                user
              );
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      needsRelationalAdjustment: hasFriction
                    })
                  }
                }
              ]
            };
          }

          if (system.includes('isExploration')) {
            const isExploration =
              /je me demande|j'essaie de comprendre|je cherche a comprendre|je cherche a voir ce que/i.test(
                user
              );
            const everydayConcreteShare =
              /deliveroo|burger|chat gratte|bouchons|j'ai faim/i.test(user);
            const confidence = isExploration ? 'high' : 'low';
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isExploration,
                      confidence,
                      everydayConcreteShare
                    })
                  }
                }
              ]
            };
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({})
                }
              }
            ]
          };
        }
      }
    }
  };
}

function makeAnalyzers({ mistralTransport = null } = {}) {
  const client = makeFakeClient();
  return createAnalyzers({
    client,
    MODEL_IDS: { analysis: 'fake-analysis', generation: 'fake-generation' },
    mistralTransport:
      mistralTransport ||
      {
        complete: async ({ messages = [] } = {}) => {
          const system = String(messages[0]?.content || '');
          const user = String(messages[messages.length - 1]?.content || '');
          if (system.includes('reajustement relationnel')) {
            return {
              content: JSON.stringify({
                needsRelationalAdjustment:
                  /tu ne m'aides? pas|tu ne comprends? pas|c'est nul|laisse tomber/i.test(
                    user
                  )
              })
            };
          }
          if (system.includes('allianceSignal')) {
            return {
              content: JSON.stringify({ allianceSignal: 'good' })
            };
          }
          if (system.includes('isInterpretationRejection')) {
            return {
              content: JSON.stringify({
                isInterpretationRejection: false,
                rejectsUnderlyingPhenomenon: false,
                relationalFrictionSignal: 'none'
              })
            };
          }
          if (
            system.includes(
              'dischargeSignal": "regulated|dysregulated|null"'
            )
          ) {
            const isDischarge =
              /craque|explose|pleure|ta gueule|ferme-la|ferme la|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(
                user
              );
            return {
              content: JSON.stringify({
                isDischarge,
                dischargeSignal: isDischarge
                  ? /explose|panique|perte de controle|etouffe|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(
                      user
                    )
                    ? 'dysregulated'
                    : 'regulated'
                  : null,
                aggressiveDischargeDirectedToBot:
                  /ta gueule|ferme-la|ferme la/i.test(user)
              })
            };
          }
          if (system.includes('contact emotionnel non-dechargeant')) {
            return {
              content: JSON.stringify({
                isContact: false,
                contactSignal: null,
                selfCriticismLevel: 'low',
                insightMoment: false
              })
            };
          }
          if (system.includes('isExploration')) {
            const isExploration =
              /je me demande|j'essaie de comprendre|je cherche a comprendre|je cherche a voir ce que/i.test(
                user
              );
            return {
              content: JSON.stringify({
                isExploration,
                confidence: isExploration ? 'high' : 'low',
                everydayConcreteShare:
                  /deliveroo|burger|chat gratte|bouchons|j'ai faim/i.test(
                    user
                  ),
                lowContextOpening: false
              })
            };
          }
          return { content: '{"isRelance": false}' };
        }
      },
    MISTRAL_MODEL_IDS: { analysis: 'fake-mistral-analysis' },
    isExplicitAppFeatureRequest: (message = '') =>
      /\b(app|outil|fonctionnalite|fonctionnalites)\b/i.test(
        String(message || '')
      ),
    llmInfoAnalysis: async (message = '') => ({
      isInfoRequest: /\?/.test(String(message || '')),
      source: 'fake_llm_info'
    }),
    normalizeMemory: (m) => String(m || ''),
    normalizeSessionFlags: (f) => f || {},
    shouldForceExplorationForSituatedImpasse: () => false,
    trimHistory: (h = []) => (Array.isArray(h) ? h : []),
    trimInfoAnalysisHistory: (h = []) => (Array.isArray(h) ? h : []),
    trimRecallAnalysisHistory: (h = []) => (Array.isArray(h) ? h : []),
    trimSuicideAnalysisHistory: (h = []) => (Array.isArray(h) ? h : [])
  });
}

async function run() {
  const analyzers = makeAnalyzers();

  check('inactive analyzeMemoryUpdateNeeds is not exposed', () => {
    assert(
      analyzers.analyzeMemoryUpdateNeeds === undefined,
      'dead memory update analyzer must remain absent from runtime exports'
    );
  });

  check('inactive n1ResponseLLM is absent and crisis fallbacks remain exposed', () => {
    assert(
      analyzers.n1ResponseLLM === undefined,
      'inactive N1 helper must not be exposed'
    );
    assert(typeof analyzers.n1Fallback === 'function', 'n1Fallback must remain');
    assert(
      typeof analyzers.imminentMajorHarmResponseLLM === 'function',
      'major harm response must remain'
    );
    assert(
      typeof analyzers.acuteCrisisFollowupResponseLLM === 'function',
      'acute crisis followup must remain'
    );
  });

  check('parseExplorationRelanceResult: strict true boolean accepted', () => {
    assert(
      parseExplorationRelanceResult('```json\n{"isRelance":true}\n```')
        .isRelance === true,
      'expected isRelance=true'
    );
    assert(
      parseExplorationRelanceResult('{"isRelance":"true"}').isRelance ===
        false,
      'expected non-boolean value to normalize to false'
    );
  });

  let mistralRequest = null;
  const relanceAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete(request) {
        mistralRequest = request;
        return { content: '{"isRelance": true}' };
      }
    }
  });
  const ambiguousRelance = await relanceAnalyzers.analyzeExplorationRelance({
    reply: 'On peut prendre un instant.'
  });
  check(
    'analyzeExplorationRelance: ambiguous signal uses only Mistral Small path',
    () => {
      assert(ambiguousRelance.isRelance === true, 'expected isRelance=true');
      assert(ambiguousRelance.source === 'llm', 'expected source=llm');
      assert(
        mistralRequest?.model === 'fake-mistral-analysis',
        'expected Mistral analysis model'
      );
      assert(mistralRequest?.maxTokens === 30, 'expected technical token guard');
      assert(
        String(mistralRequest?.messages?.[0]?.content || '').includes(
          'invite implicitement'
        ),
        'expected unchanged exploration relance prompt'
      );
    }
  );

  const relanceFallback = await makeAnalyzers({
    mistralTransport: {
      async complete() {
        return { content: 'invalid json' };
      }
    }
  }).analyzeExplorationRelance({ reply: 'Tu peux continuer.' });
  check('analyzeExplorationRelance: invalid Mistral output keeps fallback', () => {
    assert(relanceFallback.isRelance === false, 'expected safe false fallback');
    assert(
      relanceFallback.source === 'llm_fallback',
      'expected source=llm_fallback'
    );
  });

  let deterministicMistralCalls = 0;
  const deterministicRelanceAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete() {
        deterministicMistralCalls += 1;
        return { content: '{"isRelance": false}' };
      }
    }
  });
  const explicitRelance =
    await deterministicRelanceAnalyzers.analyzeExplorationRelance({
      reply: 'Tu veux continuer ?'
    });
  const noRelance =
    await deterministicRelanceAnalyzers.analyzeExplorationRelance({
      reply: 'Merci pour ce partage.'
    });
  check('analyzeExplorationRelance: deterministic guards bypass Mistral', () => {
    assert(explicitRelance.isRelance === true, 'expected question guard true');
    assert(noRelance.isRelance === false, 'expected no-signal guard false');
    assert(deterministicMistralCalls === 0, 'expected no Mistral call');
  });

  check('parseClosureIntentResult: strict true boolean accepted', () => {
    assert(
      parseClosureIntentResult('```json\n{"closureIntent":true}\n```')
        .closureIntent === true,
      'expected closureIntent=true'
    );
    assert(
      parseClosureIntentResult('{"closureIntent":"true"}').closureIntent ===
        false,
      'expected non-boolean value to normalize to false'
    );
  });

  let closureMistralRequest = null;
  const closureAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete(request) {
        closureMistralRequest = request;
        return { content: '{"closureIntent": true}' };
      }
    }
  });
  const ambiguousClosure = await closureAnalyzers.analyzeClosureIntent(
    "J'ai besoin de temps pour reflechir"
  );
  check(
    'analyzeClosureIntent: ambiguous signal uses only Mistral Small path',
    () => {
      assert(
        ambiguousClosure.closureIntent === true,
        'expected closureIntent=true'
      );
      assert(
        closureMistralRequest?.model === 'fake-mistral-analysis',
        'expected Mistral analysis model'
      );
      assert(
        closureMistralRequest?.maxTokens === 30,
        'expected technical token guard'
      );
      assert(
        String(closureMistralRequest?.messages?.[0]?.content || '').includes(
          'ignore les propos cites/rapportes'
        ),
        'expected unchanged closure intent prompt'
      );
    }
  );

  const closureFallback = await makeAnalyzers({
    mistralTransport: {
      async complete() {
        return { content: 'invalid json' };
      }
    }
  }).analyzeClosureIntent('Je dois y aller');
  check('analyzeClosureIntent: invalid Mistral output keeps safe fallback', () => {
    assert(
      closureFallback.closureIntent === false,
      'expected safe false fallback'
    );
  });

  let deterministicClosureMistralCalls = 0;
  const deterministicClosureAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete() {
        deterministicClosureMistralCalls += 1;
        return { content: '{"closureIntent": false}' };
      }
    }
  });
  const explicitClosure =
    await deterministicClosureAnalyzers.analyzeClosureIntent('Au revoir');
  const noClosure = await deterministicClosureAnalyzers.analyzeClosureIntent(
    'Je poursuis mon recit.'
  );
  check('analyzeClosureIntent: deterministic guards bypass Mistral', () => {
    assert(explicitClosure.closureIntent === true, 'expected strong guard true');
    assert(noClosure.closureIntent === false, 'expected no-signal guard false');
    assert(
      deterministicClosureMistralCalls === 0,
      'expected no Mistral call'
    );
  });

  const vouvoiementOnly = await analyzers.analyzeUserRegister(
    'Pourriez-vous me dire ce que vous en pensez ?'
  );
  check('analyzeUserRegister: vouvoiement only -> formalAddress true', () => {
    assert(vouvoiementOnly.formalAddress === true, 'expected formalAddress=true');
    assert(
      vouvoiementOnly.deterministicEvidence?.[0]?.includes('match: vous') ===
        true,
      'expected deterministic evidence to record vous'
    );
    assert(
      Object.prototype.hasOwnProperty.call(vouvoiementOnly, 'userRegister') ===
        false,
      'expected userRegister to be absent'
    );
  });

  const politeTutoiement = await analyzers.analyzeUserRegister(
    'Je voudrais savoir si tu peux aider'
  );
  check(
    'analyzeUserRegister: polite tutoiement keeps formalAddress false',
    () => {
      assert(
        politeTutoiement.formalAddress === false,
        'expected formalAddress=false'
      );
      assert(
        politeTutoiement.deterministicEvidence?.[0]?.includes('match: tu') ===
          true,
        'expected deterministic evidence to record tu'
      );
    }
  );

  check(
    'lexical suicide: "j\'aimerais en finir" -> explicit personal marker true',
    () => {
      assert(
        hasExplicitPersonalSuicideMarker("Parfois j'aimerais en finir") ===
          true,
        'expected explicit personal marker true'
      );
    }
  );

  check(
    'lexical suicide: "ce serait mieux si je n\'etais plus la" -> explicit personal marker true',
    () => {
      assert(
        hasExplicitPersonalSuicideMarker(
          "Je pense que ce serait mieux si je n'etais plus la"
        ) === true,
        'expected explicit personal marker true'
      );
    }
  );

  check(
    'lexical suicide: "ce boulot me tue" -> idiomatic marker true',
    () => {
      assert(
        hasIdiomaticDeathExpressionMarker('Franchement ce boulot me tue') ===
          true,
        'expected idiomatic marker true'
      );
    }
  );

  check(
    'lexical suicide: personal suicidality wording is not idiomatic',
    () => {
      assert(
        hasIdiomaticDeathExpressionMarker("Je vais me donner la mort") ===
          false,
        'expected idiomatic marker false'
      );
    }
  );

  check(
    'lexical crisis resolution: explicit test declaration -> true',
    () => {
      assert(
        hasExplicitCrisisResolutionMarker(
          "Je ne suis pas suicidaire, c'etait un test"
        ) === true,
        'expected explicit crisis resolution true'
      );
    }
  );

  check(
    'lexical crisis resolution: acute intent statement -> false',
    () => {
      assert(
        hasExplicitCrisisResolutionMarker(
          'Je vais sans doute me donner la mort bientot'
        ) === false,
        'expected explicit crisis resolution false'
      );
    }
  );

  const discharge = await analyzers.proposeState(
    "Je suis en train d'exploser",
    [],
    { wasDischarge: false }
  );
  check("proposeState: candidat discharge produit (C2 n'arbitre plus)", () => {
    const candidate = (discharge.stateCandidates || []).find(
      (c) => c.family === 'discharge'
    );
    assert(
      candidate !== undefined,
      'expected discharge candidate in stateCandidates'
    );
    assert(
      candidate.detectedState === 'discharge_dysregulated',
      `expected discharge_dysregulated, got ${candidate.detectedState}`
    );
    assert(
      candidate.confidence === 'high',
      'expected high confidence for discharge'
    );
    // contactAnalysis est toujours présent — suppression déléguée à C3
    assert(
      discharge.contactAnalysis !== undefined,
      'expected contactAnalysis to be present'
    );
  });

  const explorationWithContact = await analyzers.proposeState(
    "Je m'en veux tellement",
    [],
    { wasDischarge: false }
  );
  check(
    'proposeState: pas de décharge ni info → candidat exploration high confidence',
    () => {
      const candidate = (explorationWithContact.stateCandidates || []).find(
        (c) => c.family === 'exploration'
      );
      assert(candidate !== undefined, 'expected exploration candidate');
      assert(
        candidate.confidence === 'high',
        `expected high confidence, got ${candidate.confidence}`
      );
      assert(
        explorationWithContact.contactAnalysis?.isContact === true,
        'expected contactAnalysis.isContact=true'
      );
    }
  );

  const infoWithContact = await analyzers.proposeState(
    "Je m'en veux tellement, ton app fait quoi dans ce cas ?",
    [],
    { wasDischarge: false }
  );
  check(
    'proposeState: info détectée → candidat info présent, contactAnalysis passé tel quel',
    () => {
      const candidate = (infoWithContact.stateCandidates || []).find(
        (c) => c.family === 'info'
      );
      assert(
        candidate !== undefined,
        'expected info candidate in stateCandidates'
      );
      assert(
        candidate.detectedState === 'info_features',
        `expected info_features, got ${candidate.detectedState}`
      );
      assert(
        infoWithContact.contactAnalysis?.isContact === true,
        'expected contactAnalysis.isContact=true'
      );
    }
  );

  const relationalNeutral = await analyzers.analyzeRelationalAdjustmentNeed(
    'Je me sens fatigué',
    [],
    '',
    false
  );
  check(
    'analyzeRelationalAdjustmentNeed: neutral message -> deterministic skip, no LLM',
    () => {
      assert(
        relationalNeutral.needsRelationalAdjustment === false,
        'expected false'
      );
      assert(
        relationalNeutral.llmTriggered === false,
        'expected llmTriggered=false'
      );
      assert(
        relationalNeutral.source === 'deterministic_no_trigger',
        `expected deterministic_no_trigger, got ${relationalNeutral.source}`
      );
    }
  );

  const relationalFriction = await analyzers.analyzeRelationalAdjustmentNeed(
    "Tu ne m'aides pas du tout",
    [],
    '',
    false
  );
  check(
    'analyzeRelationalAdjustmentNeed: explicit friction -> LLM triggered',
    () => {
      assert(
        relationalFriction.llmTriggered === true,
        'expected llmTriggered=true'
      );
      assert(
        relationalFriction.source === 'llm',
        `expected llm, got ${relationalFriction.source}`
      );
    }
  );

  const relationalIncomprehension =
    await analyzers.analyzeRelationalAdjustmentNeed(
      "Je n'ai pas compris ta question",
      [],
      '',
      false
    );
  check(
    'analyzeRelationalAdjustmentNeed: explicit incomprehension -> LLM triggered',
    () => {
      assert(
        relationalIncomprehension.llmTriggered === true,
        'expected llmTriggered=true'
      );
      assert(
        relationalIncomprehension.source === 'llm',
        `expected llm, got ${relationalIncomprehension.source}`
      );
    }
  );

  const allianceHardRupture = await analyzers.analyzeAllianceRupture(
    "Tu racontes n'importe quoi, t'es completement a cote de la plaque",
    []
  );
  check('analyzeAllianceRupture: hard rupture wording -> rupture', () => {
    assert(
      allianceHardRupture.explicitRelationalFriction === true,
      'expected explicitRelationalFriction=true'
    );
    assert(
      allianceHardRupture.allianceSignal === 'rupture',
      `expected rupture, got ${allianceHardRupture.allianceSignal}`
    );
  });

  const interpretationRejected = await analyzers.analyzeInterpretationRejection(
    {
      message: "Pourquoi tu me dis ca ? Tu racontes n'importe quoi.",
      history: [],
      memory: ''
    }
  );
  check(
    'analyzeInterpretationRejection: challenge wording triggers analyzer path',
    () => {
      assert(
        interpretationRejected.source !== 'deterministic_no_signal',
        `expected analyzer path, got ${interpretationRejected.source}`
      );
    }
  );

  const relationalContact = await analyzers.analyzeRelationalAdjustmentNeed(
    "Tu ne m'aides pas",
    [],
    '',
    true
  );
  check(
    'analyzeRelationalAdjustmentNeed: isContact=true -> guard short-circuit',
    () => {
      assert(
        relationalContact.needsRelationalAdjustment === false,
        'expected false'
      );
      assert(
        relationalContact.llmTriggered === false,
        'expected llmTriggered=false'
      );
      assert(
        relationalContact.source === 'isContact_guard',
        `expected isContact_guard, got ${relationalContact.source}`
      );
    }
  );

  // --- analyzeDischargeState guard deterministe ---

  const dischargeCalm = await analyzers.analyzeDischargeState(
    "Je me sens triste aujourd'hui",
    [],
    { wasDischarge: false }
  );
  check(
    'analyzeDischargeState: message calme -> guard deterministe, pas de LLM',
    () => {
      assert(dischargeCalm.isDischarge === false, 'expected false');
      assert(
        dischargeCalm.source === 'deterministic_no_signal',
        `expected deterministic_no_signal, got ${dischargeCalm.source}`
      );
    }
  );

  const dischargeMontee = await analyzers.analyzeDischargeState(
    'Je suis au bord de craquer',
    [],
    { wasDischarge: false }
  );
  check(
    'analyzeDischargeState: message avec signal positif (craqu) -> LLM declenche',
    () => {
      assert(
        dischargeMontee.source !== 'deterministic_no_signal',
        `expected LLM path, got ${dischargeMontee.source}`
      );
    }
  );

  const dischargeExplose = await analyzers.analyzeDischargeState(
    "Je suis en train d'exploser",
    [],
    { wasDischarge: false }
  );
  check(
    'analyzeDischargeState: explos -> LLM declenche, detectedState discharge_dysregulated',
    () => {
      assert(
        dischargeExplose.isDischarge === true,
        'expected isDischarge=true'
      );
      assert(
        dischargeExplose.detectedState === 'discharge_dysregulated',
        `expected discharge_dysregulated, got ${dischargeExplose.detectedState}`
      );
    }
  );

  const dischargeAgressif = await analyzers.analyzeDischargeState(
    'Ta gueule !!!',
    [],
    { wasDischarge: false }
  );
  check(
    'analyzeDischargeState: insulte + !! -> LLM declenche, aggressiveDischargeDirectedToBot',
    () => {
      assert(
        dischargeAgressif.isDischarge === true,
        'expected isDischarge=true'
      );
      assert(
        dischargeAgressif.aggressiveDischargeDirectedToBot === true,
        'expected aggressiveDischargeDirectedToBot=true'
      );
    }
  );

  const dischargeContinuite = await analyzers.analyzeDischargeState(
    'Je me sens mieux maintenant',
    [],
    { wasDischarge: true }
  );
  check(
    'analyzeDischargeState: wasDischarge=true -> passe toujours au LLM meme sans signal',
    () => {
      assert(
        dischargeContinuite.source !== 'deterministic_no_signal',
        `expected LLM path on continuation, got ${dischargeContinuite.source}`
      );
    }
  );

  const dischargePanicSomatic = await analyzers.analyzeDischargeState(
    "Je crois que je fais une crise d'angoisse, j'ai du mal a respirer",
    [],
    { wasDischarge: false }
  );
  check(
    "analyzeDischargeState: crise d'angoisse + respiration difficile -> candidate dysregulated",
    () => {
      assert(
        dischargePanicSomatic.isDischarge === true,
        'expected isDischarge=true'
      );
      assert(
        dischargePanicSomatic.detectedState === 'discharge_dysregulated',
        `expected discharge_dysregulated, got ${dischargePanicSomatic.detectedState}`
      );
    }
  );

  const dischargePanicUrgency = await analyzers.analyzeDischargeState(
    "J'ai la tete qui tourne, ca va pas, qu'est-ce que je fais ?",
    [],
    { wasDischarge: false }
  );
  check(
    'analyzeDischargeState: vertige + urgence explicite -> candidate dysregulated',
    () => {
      assert(
        dischargePanicUrgency.isDischarge === true,
        'expected isDischarge=true'
      );
      assert(
        dischargePanicUrgency.detectedState === 'discharge_dysregulated',
        `expected discharge_dysregulated, got ${dischargePanicUrgency.detectedState}`
      );
    }
  );

  // --- analyzeExplorationSignal ---

  const explorationSelfQuery = await analyzers.analyzeExplorationSignal(
    'Je me demande pourquoi je reagis comme ca',
    []
  );
  check(
    'analyzeExplorationSignal: questionnement explicite sur soi -> isExploration=true, high',
    () => {
      assert(
        explorationSelfQuery.isExploration === true,
        'expected isExploration=true'
      );
      assert(
        explorationSelfQuery.confidence === 'high',
        `expected high, got ${explorationSelfQuery.confidence}`
      );
      assert(
        ['llm', 'llm_error'].includes(explorationSelfQuery.source),
        `expected llm source, got ${explorationSelfQuery.source}`
      );
      assert(
        explorationSelfQuery.everydayConcreteShare === false,
        'expected everydayConcreteShare=false'
      );
    }
  );

  const explorationNeutral = await analyzers.analyzeExplorationSignal(
    'Je suis fatigue',
    []
  );
  check(
    'analyzeExplorationSignal: description neutre -> isExploration=false',
    () => {
      assert(
        explorationNeutral.isExploration === false,
        'expected isExploration=false'
      );
      assert(
        explorationNeutral.everydayConcreteShare === false,
        'expected everydayConcreteShare=false'
      );
    }
  );

  const explorationEverydayConcrete = await analyzers.analyzeExplorationSignal(
    "J'attends mon Deliveroo, j'ai faim",
    []
  );
  check(
    'analyzeExplorationSignal: partage quotidien concret -> everydayConcreteShare=true',
    () => {
      assert(
        explorationEverydayConcrete.everydayConcreteShare === true,
        'expected everydayConcreteShare=true'
      );
    }
  );

  check('parseEmotionalDecenteringResult: strict boolean accepted', () => {
    assert(
      parseEmotionalDecenteringResult(
        '```json\n{"emotionalDecentering":true}\n```'
      ).emotionalDecentering === true,
      'expected emotionalDecentering=true'
    );
    assert(
      parseEmotionalDecenteringResult(
        '{"emotionalDecentering":"true"}'
      ).emotionalDecentering === false,
      'expected non-boolean value to normalize to false'
    );
  });

  let decenteringMistralRequest = null;
  const decenteringAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete(request) {
        decenteringMistralRequest = request;
        return { content: '{"emotionalDecentering": true}' };
      }
    }
  });
  const ambiguousDecentering =
    await decenteringAnalyzers.analyzeEmotionalDecentering(
      'Dans cette histoire, en fait peu importe',
      [{ role: 'assistant', content: 'Que se passe-t-il ?' }]
    );
  check(
    'analyzeEmotionalDecentering: ambiguous signal uses Mistral Small path',
    () => {
      assert(
        ambiguousDecentering.emotionalDecentering === true,
        'expected emotionalDecentering=true'
      );
      assert(
        ambiguousDecentering.source === 'llm_review',
        'expected source=llm_review'
      );
      assert(
        decenteringMistralRequest?.model === 'fake-mistral-analysis',
        'expected Mistral analysis model'
      );
      assert(
        decenteringMistralRequest?.maxTokens === 40,
        'expected technical token guard'
      );
      assert(
        String(decenteringMistralRequest?.messages?.[0]?.content || '').includes(
          'amorce une emotion et la deflecte'
        ),
        'expected unchanged emotional decentering prompt'
      );
    }
  );

  const decenteringFallback = await makeAnalyzers({
    mistralTransport: {
      async complete() {
        return { content: 'invalid json' };
      }
    }
  }).analyzeEmotionalDecentering('Dans cette histoire, en fait peu importe');
  check(
    'analyzeEmotionalDecentering: invalid Mistral output keeps safe fallback',
    () => {
      assert(
        decenteringFallback.emotionalDecentering === false,
        'expected safe false fallback'
      );
      assert(
        decenteringFallback.source === 'llm_fallback',
        'expected source=llm_fallback'
      );
    }
  );

  let deterministicDecenteringMistralCalls = 0;
  const deterministicDecenteringAnalyzers = makeAnalyzers({
    mistralTransport: {
      async complete() {
        deterministicDecenteringMistralCalls += 1;
        return { content: '{"emotionalDecentering": false}' };
      }
    }
  });
  const emotionalDecenteringActive =
    await deterministicDecenteringAnalyzers.analyzeEmotionalDecentering(
      "J'ai un truc qui monte quand j'y pense, bref on passe.",
      []
    );
  const emotionalDecenteringAtStart =
    await deterministicDecenteringAnalyzers.analyzeEmotionalDecentering(
      'Bref, autre chose.',
      []
    );
  const emotionalDecenteringNoSignal =
    await deterministicDecenteringAnalyzers.analyzeEmotionalDecentering(
      'Je raconte simplement la suite.',
      []
    );
  check(
    'analyzeEmotionalDecentering: deterministic guards bypass Mistral',
    () => {
      assert(
        emotionalDecenteringActive.emotionalDecentering === true,
        'expected active deterministic guard true'
      );
      assert(
        emotionalDecenteringAtStart.emotionalDecentering === false,
        'expected starts-with guard false'
      );
      assert(
        emotionalDecenteringNoSignal.emotionalDecentering === false,
        'expected no-signal guard false'
      );
      assert(
        deterministicDecenteringMistralCalls === 0,
        'expected no Mistral call'
      );
    }
  );

  const emotionalDecenteringEvidence =
    await analyzers.analyzeEmotionalDecentering(
      "J'ai un truc qui monte quand j'y pense, bref on passe.",
      []
    );
  check(
    'analyzeEmotionalDecentering: guard actif -> evidence match expose',
    () => {
      assert(
        emotionalDecenteringEvidence.emotionalDecentering === true,
        'expected emotionalDecentering=true'
      );
      const hasMatch =
        Array.isArray(emotionalDecenteringEvidence.deterministicEvidence) &&
        emotionalDecenteringEvidence.deterministicEvidence.some(
          function hasEntry(entry) {
            return (
              /emotional_decentering_guard_active/.test(String(entry || '')) &&
              /\|\s*match:\s*"[^"]+"/i.test(String(entry || '')) &&
              !/\|\s*match:\s*"none"/i.test(String(entry || ''))
            );
          }
        );
      assert(
        hasMatch,
        'expected emotional decentering deterministic evidence with match'
      );
    }
  );

  const stateWithExploration = await analyzers.proposeState(
    'Je me demande pourquoi je reagis comme ca',
    [],
    { wasDischarge: false }
  );
  check(
    'proposeState: message exploratoire -> exploration candidate avec confiance LLM',
    () => {
      const candidate = (stateWithExploration.stateCandidates || []).find(
        (c) => c.family === 'exploration'
      );
      assert(candidate !== undefined, 'expected exploration candidate');
      // Si LLM detecle l'exploration, confidence reflète ce que le LLM renvoie ("high" ici avec le fake)
      assert(
        ['high', 'medium', 'low'].includes(candidate.confidence),
        `confidence inattendue: ${candidate.confidence}`
      );
      assert(
        stateWithExploration.explorationAnalysis?.everydayConcreteShare ===
          false,
        'expected explorationAnalysis.everydayConcreteShare=false'
      );
      assert(
        stateWithExploration.explorationAnalysis?.lowContextOpening === false,
        'expected explorationAnalysis.lowContextOpening=false'
      );
    }
  );

  const stateEverydayConcrete = await analyzers.proposeState(
    "J'attends mon Deliveroo, j'ai faim",
    [],
    { wasDischarge: false }
  );
  check(
    'proposeState: partage quotidien concret -> explorationAnalysis.everydayConcreteShare=true',
    () => {
      assert(
        stateEverydayConcrete.explorationAnalysis?.everydayConcreteShare ===
          true,
        'expected explorationAnalysis.everydayConcreteShare=true'
      );
      assert(
        stateEverydayConcrete.explorationAnalysis?.lowContextOpening === false,
        'expected explorationAnalysis.lowContextOpening=false'
      );
    }
  );

  console.log(`\n[ANALYZERS] ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('[ANALYZERS] fatal:', err?.message || err);
  process.exit(1);
});
