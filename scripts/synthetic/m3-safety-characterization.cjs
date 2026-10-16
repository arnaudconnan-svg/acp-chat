'use strict';
// Characterization, not a clinical benchmark: injected synthetic analyzer output
// is followed through the real normalizer, server routing and writer assembly.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createAnalyzers } = require('../../lib/analyzers');
const { createWriter } = require('../../lib/writer');
const { buildSafetyRoutingDecision } = require('../../lib/chat-routing');
const {
  resolveEmergencySupport,
  buildEmergencySupportText
} = require('../../lib/emergency-resources');
const { loadApplication } = require('./runtime.cjs');
const debugWindow = {};
vm.runInNewContext(
  fs.readFileSync(
    path.resolve(__dirname, '../../public/js/debug-shared.js'),
    'utf8'
  ),
  { window: debugWindow }
);
const saveText = (meta) =>
  debugWindow.FacilitatDebug.buildResponseSaveText(meta);
const base = {
  suicideLevel: 'N0',
  needsClarification: false,
  isQuote: false,
  idiomaticDeathExpression: false,
  crisisResolved: false
};
const raw = (overrides) => JSON.stringify({ ...base, ...overrides });
const fixtureRegistry = {
  FR: { label: 'SYNTHETIC_FR', emergency: '000', suicide: '001' },
  BE: { label: 'SYNTHETIC_BE', emergency: '002', suicide: null }
};
const cases = [
  {
    id: 'D1',
    message: 'Ce boulot me tue.',
    raw: raw({ suicideLevel: 'N2' }),
    level: 'N0',
    route: null
  },
  {
    id: 'D2',
    message: 'Ce boulot me tue. Et séparément, je veux mourir.',
    raw: raw({ suicideLevel: 'N1', needsClarification: true }),
    level: 'N1',
    route: 'n1_clarification'
  },
  {
    id: 'D3',
    message:
      "Ce boulot me tue. À part cela, je vais me tuer maintenant, j'ai préparé le moyen.",
    raw: raw({ suicideLevel: 'N2' }),
    level: 'N0',
    route: null
  },
  {
    id: 'D4',
    message:
      "Il a dit « je veux mourir ». Quant à moi, je vais me tuer maintenant, j'ai préparé le moyen.",
    raw: raw({ suicideLevel: 'N2', isQuote: true }),
    level: 'N2',
    route: 'n2'
  },
  {
    id: 'D5',
    message: 'Parlons de ma semaine.',
    raw: raw(),
    acuteCrisis: true,
    level: 'N0',
    route: 'acute_followup'
  }
];
for (const prior of [false, true]) {
  for (const [name, result, level] of [
    ['timeout', new Error('SYNTHETIC_TIMEOUT'), 'N0'],
    ['incomplete_json', '{"suicideLevel":', 'N0'],
    ['incomplete_object', '{"suicideLevel":"N2"}', 'N2'],
    ['unknown_level', raw({ suicideLevel: 'UNKNOWN' }), 'N0'],
    [
      'wrong_booleans',
      raw({
        suicideLevel: 'N1',
        needsClarification: 'true',
        isQuote: 'false',
        idiomaticDeathExpression: 'true',
        crisisResolved: 'true'
      }),
      'N1'
    ]
  ])
    cases.push({
      id: 'D6_' + name + '_prior_' + prior,
      message: 'Message synthétique neutre.',
      raw: result,
      acuteCrisis: prior,
      level,
      route:
        level === 'N2'
          ? 'n2'
          : prior
            ? 'acute_followup'
            : level === 'N1'
              ? 'n1_clarification'
              : null
    });
}
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
async function drain(app) {
  for (let n = 0; n < 200 && app.evaluate('activeChatRequests.size'); n++)
    await new Promise(setImmediate);
  assert.equal(app.evaluate('activeChatRequests.size'), 0);
}
function make(scenario, { writerFailure = false, saveFailure = false } = {}) {
  const observed = {
    normalized: [],
    writers: [],
    writerInputs: [],
    followups: [],
    decisions: []
  };
  const app = loadApplication({
    seed: {
      users: {
        u_A: {
          authVersion: 0,
          email: 'synthetic@example.test',
          passwordHash: 'SYNTHETIC_HASH',
          country: 'ZZ'
        },
        u_B: { authVersion: 0 }
      },
      conversations: {
        c_A: {
          userId: 'u_A',
          memory: '',
          titleLocked: true,
          flags: { acuteCrisis: scenario.acuteCrisis === true }
        },
        c_B: { userId: 'u_B', memory: '' }
      }
    },
    overrides: {
      './lib/chat-routing': {
        ...require('../../lib/chat-routing'),
        buildSafetyRoutingDecision(input) {
          const decision = buildSafetyRoutingDecision(input);
          observed.decisions.push(decision);
          return decision;
        }
      },
      './lib/analyzers': {
        createAnalyzers(options) {
          const live = createAnalyzers(options);
          const injected = createAnalyzers({
            ...options,
            mistralTransport: {
              complete: async () => {
                if (scenario.raw instanceof Error) throw scenario.raw;
                return { content: scenario.raw };
              }
            }
          });
          const followup = createAnalyzers({
            ...options,
            mistralTransport: {
              complete: async (request) => {
                observed.followups.push(request);
                return { content: 'SYNTHETIC_FOLLOWUP' };
              }
            }
          });
          return {
            ...live,
            analyzeImminentMajorHarmRisk: async () => ({
              harmRiskLevel: 'H0',
              imminenceBand: 'none'
            }),
            analyzeSuicideRisk: async (...args) => {
              const result = await injected.analyzeSuicideRisk(...args);
              observed.normalized.push(result);
              return result;
            },
            acuteCrisisFollowupResponseLLM:
              followup.acuteCrisisFollowupResponseLLM
          };
        }
      },
      './lib/writer': {
        createWriter(options) {
          const writer = createWriter({
            ...options,
            mistralTransport: {
              complete: async (request) => {
                observed.writers.push(request);
                if (writerFailure) throw new Error('SYNTHETIC_WRITER_TIMEOUT');
                return { content: 'SYNTHETIC_REPLY' };
              }
            }
          });
          return {
            ...writer,
            generateReply: async (input) => {
              observed.writerInputs.push(input);
              return writer.generateReply(input);
            }
          };
        }
      }
    }
  });
  app.evaluate('emergencyNumbers = ' + JSON.stringify(fixtureRegistry));
  if (saveFailure)
    app.db.hooks.beforeCommit = async ({ value }) => {
      if (
        Object.values(value?.messages || {}).some((m) => m.role === 'assistant')
      )
        throw new Error('SYNTHETIC_SAVE_REJECTED');
    };
  const cookie =
    'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
  return { app, cookie, observed };
}
(async () => {
  for (const scenario of cases) {
    const { app, cookie, observed } = make(scenario);
    const response = await app.request('POST', '/chat', {
      cookie,
      body: {
        flags: { acuteCrisis: scenario.acuteCrisis === true },
        message: scenario.message,
        conversationId: 'c_A',
        requestId: 'synthetic_' + scenario.id
      }
    });
    await drain(app);
    assert.equal(response.statusCode, 200, scenario.id);
    assert.equal(observed.normalized.length, 1);
    const normalized = observed.normalized[0];
    const decision = buildSafetyRoutingDecision({
      safety: { harmRiskLevel: 'H0', imminenceBand: 'none' },
      suicide: normalized,
      flags: { acuteCrisis: scenario.acuteCrisis === true }
    });
    assert.equal(normalized.suicideLevel, scenario.level, scenario.id);
    assert.equal(decision.route, scenario.route, scenario.id);
    assert.deepEqual(
      observed.decisions[0],
      decision,
      'actual orchestrator uses the characterized decision'
    );
    // The server's routing logs carry request context; actual selected writer
    // state is also recorded below to avoid substituting a parallel decision.
    const writerState =
      observed.writerInputs[0]?.postureDecision?.conversationState || null;
    if (scenario.route === 'n2') {
      assert.equal(writerState, 'n2_crisis');
      const expected = buildEmergencySupportText(
        resolveEmergencySupport(fixtureRegistry, 'ZZ')
      );
      assert.equal(observed.writerInputs[0].emergencyResourceData, expected);
      assert.equal(response.body.debugMeta.emergencySupportText, expected);
      assert(
        observed.writers[0].messages.some(
          (m) =>
            m.role === 'user' &&
            m.content.includes(expected.replace(/"/g, '\\"'))
        )
      );
      assert(!observed.writers[0].messages[0].content.includes('SYNTHETIC_FR'));
    } else if (scenario.route === 'acute_followup') {
      assert.equal(observed.followups.length, 1);
      assert.equal(response.body.flags.acuteCrisis, true);
    } else if (scenario.route === 'n1_clarification') {
      assert.equal(
        observed.writerInputs[0].postureDecision.effectiveConversationState,
        'n1_crisis'
      );
      assert.equal(
        writerState,
        'exploration_open',
        'characterize existing writer state selection without changing policy'
      );
    } else {
      assert.notEqual(writerState, 'n2_crisis');
      assert.notEqual(writerState, 'n1_crisis');
    }
    const saved = app.db.data.messages?.[response.body.botMessageId];
    assert.equal(
      saved?.role,
      'assistant',
      'successful response is really saved in the double'
    );
    const receipt = await app.request(
      'GET',
      '/api/account/conversations/c_A/saves/' + response.body.botMessageId,
      { cookie }
    );
    assert.equal(receipt.statusCode, 200);
    assert.equal(receipt.body.responseSaveStatus, 'confirmed');
    assert(saveText(receipt.body).includes('sauvegardée'));
    console.log(
      JSON.stringify({
        id: scenario.id,
        message: scenario.message,
        raw:
          scenario.raw instanceof Error
            ? { error: scenario.raw.message }
            : scenario.raw,
        normalized,
        previousCrisis: scenario.acuteCrisis === true,
        decision,
        orchestratorDecision: observed.decisions[0],
        writer: {
          state: writerState,
          effectiveState:
            observed.writerInputs[0]?.postureDecision
              ?.effectiveConversationState || null,
          reply: response.body.reply,
          followupCalls: observed.followups.length,
          writerCalls: observed.writers.length
        },
        responseSaveStatus: response.body.debugMeta.responseSaveStatus,
        receiptAfterCompletion: receipt.body.responseSaveStatus,
        persistedInDouble: saved.role === 'assistant'
      })
    );
  }
  const n2 = cases.find((c) => c.id === 'D4');
  for (const country of ['BE', 'FR', null]) {
    const { app, cookie, observed } = make(n2);
    app.db.data.users.u_A.country = country;
    const api = await app.request('GET', '/api/emergency-support', {
      query: { country: country || '' }
    });
    const response = await app.request('POST', '/chat', {
      cookie,
      body: {
        message: n2.message,
        conversationId: 'c_A',
        requestId: 'synthetic_resource_' + (country || 'unknown')
      }
    });
    await drain(app);
    assert.equal(response.statusCode, 200);
    assert.equal(
      observed.writerInputs[0].emergencyResourceData,
      buildEmergencySupportText(api.body)
    );
    console.log(
      JSON.stringify({
        resourceCountry: country,
        apiEffectiveCountry: api.body.country,
        fallbackUsed: api.body.fallbackUsed,
        writerDataEqualsApi: true
      })
    );
  }
  {
    const { app, cookie } = make(n2, { writerFailure: true });
    app.evaluate('emergencyNumbers = {}');
    const response = await app.request('POST', '/chat', {
      cookie,
      body: {
        message: n2.message,
        conversationId: 'c_A',
        requestId: 'synthetic_no_registry'
      }
    });
    await drain(app);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.debugMeta.emergencyNumbersIncluded, false);
    assert(!response.body.reply.includes('3114'));
    assert(!response.body.reply.includes('000'));
    console.log(
      JSON.stringify({
        boundary: 'missing_registry',
        emergencyNumbersIncluded: false,
        reply: response.body.reply
      })
    );
  }
  for (const [name, config] of [
    ['writer_timeout', { writerFailure: true }],
    ['save_failure', { saveFailure: true }]
  ]) {
    const { app, cookie, observed } = make(n2, config);
    const response = await app.request('POST', '/chat', {
      cookie,
      body: {
        message: n2.message,
        conversationId: 'c_A',
        requestId: 'synthetic_' + name
      }
    });
    await drain(app);
    assert.equal(response.statusCode, 200);
    if (config.writerFailure) {
      assert(
        response.body.reply.includes('ZZ') &&
          response.body.reply.includes('SYNTHETIC_FR')
      );
      assert(response.body.reply.includes('non validée'));
      assert(
        !response.body.reply.includes('3114'),
        'no hidden FR numbers in writer failure fallback'
      );
    } else {
      assert.notEqual(response.body.debugMeta.responseSaveStatus, 'confirmed');
      assert(
        !app.db.data.messages?.[response.body.botMessageId],
        'failed save never creates a persisted success'
      );
    }
    const receipt = await app.request(
      'GET',
      '/api/account/conversations/c_A/saves/' + response.body.botMessageId,
      { cookie }
    );
    assert.equal(
      receipt.body.responseSaveStatus,
      config.saveFailure ? 'uncertain' : 'confirmed'
    );
    if (config.saveFailure)
      assert(saveText(receipt.body).includes('non confirmée'));
    console.log(
      JSON.stringify({
        boundary: name,
        responseSaveStatus: response.body.debugMeta.responseSaveStatus,
        receiptAfterCompletion: receipt.body.responseSaveStatus,
        displayedSaveText: saveText(receipt.body),
        reply: response.body.reply,
        writerCalls: observed.writers.length
      })
    );
  }
  const { app, cookie, observed } = make(n2);
  for (const [name, auth, conversationId, status] of [
    ['unauthenticated', '', 'c_A', 401],
    ['foreign_conversation', cookie, 'c_B', 403]
  ]) {
    const response = await app.request('POST', '/chat', {
      cookie: auth,
      body: {
        message: n2.message,
        conversationId,
        requestId: 'synthetic_' + name
      }
    });
    assert.equal(response.statusCode, status);
    assert.equal(observed.writers.length, 0);
    assert.equal(observed.normalized.length, 0);
    console.log(JSON.stringify({ boundary: name, status, writerCalls: 0 }));
  }
  done = true;
  console.log(
    'M3 D1-D6 characterization complete; existing clinical policy unchanged; synthetic injected outputs only.'
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
