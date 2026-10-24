'use strict';
/* global __dirname */
// No server socket: the existing M0 runtime executes the real Express routes.
const assert = require('node:assert/strict');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline');
assert(require.cache[path.join(__dirname, 'guard.cjs')]);
const { loadApplication } = require('./runtime.cjs');
const { hashPassword } = require('../../lib/auth-password');
const { createAnalyzers } = require('../../lib/analyzers');
const memory = require('../../lib/memory');
let app,
  cookie = '',
  writerCalls = 0,
  providerAttempts = 0;
const reply = 'Réponse synthétique QA — aucun fournisseur réel.';
function reset(streaming) {
  cookie = '';
  writerCalls = 0;
  providerAttempts = 0;
  app = loadApplication({
    env: { ENABLE_CHAT_STREAMING: streaming ? 'true' : 'false' },
    seed: {
      users: {
        u_qa: {
          authVersion: 0,
          email: 'qa-chat@example.test',
          country: 'FR',
          passwordHash: hashPassword('Synthetic-QA-only-123!')
        }
      }
    },
    overrides: {
      './lib/mistral-transport': {
        createMistralTransport: () => ({
          complete: async () => {
            providerAttempts++;
            throw new Error('QA unexpected provider request');
          },
          stream: async () => {
            providerAttempts++;
            throw new Error('QA unexpected provider stream');
          }
        })
      },
      './lib/analyzers': {
        createAnalyzers: (o) => ({
          ...createAnalyzers(o),
          // Fixed safety signals select a bounded existing route, not a clinical test.
          analyzeImminentMajorHarmRisk: async () => ({ harmRiskLevel: 'H0' }),
          analyzeSuicideRisk: async () => ({ suicideLevel: 'N2' })
        })
      },
      './lib/writer': {
        createWriter: () => ({
          generateReply: async ({ onTokenCallback }) => {
            writerCalls++;
            if (onTokenCallback) {
              await onTokenCallback('Réponse synthétique QA — ');
              await onTokenCallback('aucun fournisseur réel.');
            }
            return { reply };
          }
        })
      },
      './lib/memory': {
        ...memory,
        createMemoryHelpers: (o) => ({
          ...memory.createMemoryHelpers(o),
          updateMemory: async () => ({
            memoryText: 'Mémoire synthétique QA',
            source: 'synthetic'
          }),
          updateIntersessionMemory: async () => 'Synthèse synthétique QA'
        })
      }
    }
  });
}
let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  chain = chain.then(async () => {
    const { id, op, streaming, request } = JSON.parse(line);
    try {
      let result;
      if (op === 'reset') {
        reset(streaming);
        result = { ready: true };
      } else if (op === 'disable-streaming') {
        app.evaluate('appConfig.enableChatStreaming = false');
        result = { streaming: false };
      } else if (op === 'inspect') {
        assert.throws(() =>
          require('https').get('https://synthetic.example.test')
        );
        assert.throws(() =>
          require('net').connect(443, 'synthetic.example.test')
        );
        assert.throws(() => require('firebase-admin'));
        assert.throws(() => require('nodemailer'));
        assert(app.blocked.includes('listen'));
        assert.equal(providerAttempts, 0);
        result = {
          writerCalls,
          providerCalls: 0,
          providerAttempts,
          externalPersistence: false,
          blocked: app.blocked,
          database: app.db.data,
          operations: app.db.operations,
          egressGuardsVerified: true
        };
      } else if (op === 'discard') {
        app = null;
        cookie = '';
        result = { discarded: true };
      } else {
        // These routes are never part of the harness, including on the double.
        assert(
          !/register|reset|close|admin|pros/.test(request.url) ||
            request.url === '/api/admin/session'
        );
        result = await app.request(request.method, request.url, {
          cookie,
          body: request.body || {},
          headers: request.headers || {}
        });
        if (request.url === '/api/auth/login' && result.statusCode === 200)
          cookie = result.headers['set-cookie'].split(';')[0];
        if (request.url === '/api/auth/logout') cookie = '';
        // Synthetic session tokens stay inside this short-lived guarded worker.
        delete result.headers['set-cookie'];
        if (
          !String(result.headers['content-type']).includes('text/event-stream')
        )
          delete result.wire;
      }
      process.stdout.write(JSON.stringify({ id, result }) + '\n');
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id, error: String(error.stack) }) + '\n'
      );
    }
  });
});
