'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { JSDOM } = require('jsdom');
const { hashPassword } = require('../../lib/auth-password');
const { loadApplication } = require('./runtime.cjs');
assert(require.cache[path.resolve('scripts/synthetic/guard.cjs')]);
(async () => {
  const app = loadApplication({
    seed: {
      professionalIdentities: {
        synthetic_admin: {
          email: 'synthetic-admin@example.test',
          passwordHash: hashPassword('Synthetic-only-123!'),
          active: true,
          roles: ['administrator'],
          authorizationVersion: 1
        }
      }
    }
  });
  const login = async () =>
    (
      await app.request('post', '/api/pros/login', {
        body: {
          email: 'synthetic-admin@example.test',
          password: 'Synthetic-only-123!'
        }
      })
    ).headers['set-cookie'].split(';')[0];
  const first = await login(),
    second = await login();
  const probe = async (cookie) =>
    (await app.request('get', '/api/admin/session', { cookie })).body;
  const a = await probe(first),
    b = await probe(first),
    c = await probe(second);
  assert.equal(a.authenticated, true);
  assert.equal(a.reviewContext, b.reviewContext);
  assert.notEqual(a.reviewContext, c.reviewContext);
  assert.equal(a.reviewContext.length, 64);
  assert(!a.reviewContext.includes('synthetic_admin'));
  await app.request('post', '/api/admin/logout', { cookie: first });
  assert.equal((await probe(first)).reviewContext, undefined);
  const dom = new JSDOM('<main id="synthetic"></main>', {
      url: 'https://synthetic.example.test/admin.html',
      runScripts: 'outside-only'
    }),
    w = dom.window;
  w.Headers = globalThis.Headers;
  w.AbortController = globalThis.AbortController;
  const requests = [];
  let delayed = false,
    release;
  w.fetch = async (url, options = {}) => {
    if (url === '/api/admin/session')
      return new globalThis.Response(
        JSON.stringify({
          authenticated: true,
          reviewContext: 'synthetic-context'
        })
      );
    requests.push(options.headers);
    const response = new globalThis.Response('{}');
    if (delayed)
      response.json = () =>
        new Promise((resolve) => {
          release = () => resolve({ userLabel: 'SYNTHETIC IDENTITY' });
        });
    return response;
  };
  w.eval(
    fs.readFileSync(path.resolve('public/js/professional-review.js'), 'utf8')
  );
  await w.fetch('/api/admin/session');
  const waiting = w.fetch('/api/admin/conversations');
  await new Promise((resolve) => w.setTimeout(resolve, 0));
  const selectors = w.document.querySelectorAll('select');
  selectors[0].value = 'support_incident';
  selectors[0].dispatchEvent(new w.Event('change'));
  await waiting;
  assert.equal(requests.at(-1).get('x-access-reason'), 'support_incident');
  selectors[1].value = 'identity_verification';
  selectors[1].dispatchEvent(new w.Event('change'));
  delayed = true;
  const response = await w.fetch('/api/admin/conversations');
  const reading = response.json();
  selectors[1].value = '';
  selectors[1].dispatchEvent(new w.Event('change'));
  release();
  await assert.rejects(reading, (error) => error.name === 'AbortError');
  delayed = false;
  await w.fetch('/api/admin/conversations', {
    headers: { 'x-identity-unmask-reason': 'identity_verification' }
  });
  assert.equal(requests.at(-1).get('x-identity-unmask-reason'), null);
  selectors[0].value = 'security_review';
  selectors[0].dispatchEvent(new w.Event('change'));
  await w.fetch('/api/admin/conversations');
  assert.equal(requests.at(-1).get('x-access-reason'), 'security_review');
  const saved = w.sessionStorage.getItem('facilitatio:admin-review:v1');
  assert(saved.includes('security_review'));
  assert(!saved.includes('SYNTHETIC IDENTITY'));
  await w.fetch('/api/admin/logout', { method: 'POST' });
  assert.equal(w.sessionStorage.getItem('facilitatio:admin-review:v1'), null);
  dom.window.close();
  process.stdout.write(
    '[PASS] synthetic session binding/revocation; per-request audit reason; guarded deferred JSON body; caller unmask header removed; reason edit/logout cleanup\n'
  );
})().catch((error) => {
  process.stderr.write(String(error.stack) + '\n');
  process.exitCode = 1;
});
