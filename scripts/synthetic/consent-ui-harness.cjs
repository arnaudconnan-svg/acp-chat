'use strict';
const assert = require('assert/strict'),
  fs = require('fs'),
  path = require('path');
const { JSDOM } = require('jsdom');
const { loadApplication } = require('./runtime.cjs');
let done = false;
process.on('beforeExit', () => {
  if (!done) process.exitCode = 1;
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  const expires = Date.now() + 3600000;
  const app = loadApplication({
    seed: {
      users: { u_A: { authVersion: 0 }, u_B: { authVersion: 0 } },
      professionalIdentities: {
        p: { active: true, roles: ['practitioner'] },
        unassigned: { active: true, roles: ['practitioner'] }
      },
      practitionerAssignments: { p: { u_A: { active: true } } },
      contentGrants: {
        u_A: {
          p: {
            id: 'grant_A',
            version: 1,
            active: true,
            scope: 'conversation_specific',
            conversationIds: ['c_A'],
            startsAt: 0,
            endsAt: expires,
            allowIntersessionSummary: true
          }
        }
      },
      conversations: {
        c_A: {
          userId: 'u_A',
          title: 'Projet personnel',
          updatedAt: '2026-10-01T12:00:00Z'
        },
        c_B: { userId: 'u_B', title: 'FOREIGN_TITLE' },
        c_private: { userId: 'u_A', title: 'PRIVATE_TITLE', isPrivate: true },
        c_removed: { userId: 'u_A', deletedAt: 1 }
      }
    }
  });
  const cookie =
    'userSessionId=' + app.evaluate("buildUserSessionToken('u_A',0)");
  const dom = new JSDOM('<main></main>', {
      url: 'https://synthetic.example.test',
      runScripts: 'outside-only'
    }),
    w = dom.window;
  let saved;
  w.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') saved = JSON.parse(options.body);
    const r = await app.request(options.method || 'get', url, {
      cookie,
      body: options.body ? JSON.parse(options.body) : {}
    });
    return new Response(JSON.stringify(r.body), { status: r.statusCode });
  };
  w.eval(
    fs.readFileSync(
      path.join(__dirname, '../../public/js/content-grants.js'),
      'utf8'
    )
  );
  const panel = w.FacilitatContentGrants.mount(
    w.document.querySelector('main')
  );
  for (let i = 0; i < 30 && panel.querySelector('button').disabled; i++)
    await tick();
  const text = panel.textContent;
  assert(text.includes('Projet personnel'));
  assert(!text.includes('FOREIGN_TITLE'));
  assert(!text.includes('PRIVATE_TITLE'));
  assert(text.includes('Autorisation active'));
  assert(text.includes('Synthèse inter-session : oui'));
  assert.equal(panel.querySelector('input[type=checkbox]').checked, true);
  const end = panel.querySelector('input[type=datetime-local]');
  assert.equal(
    new Date(end.value).getTime(),
    expires,
    'visible local instant equals durable expiry including milliseconds'
  );
  assert.equal(
    panel.querySelector('input[type=text]'),
    null,
    'no raw identifier input'
  );
  await panel.querySelector('button').onclick();
  assert.equal(saved.endsAt, expires);
  assert.deepEqual(saved.conversationIds, ['c_A']);
  assert.equal(saved.allowIntersessionSummary, true);
  await panel.querySelectorAll('button')[1].onclick();
  assert.equal(app.db.data.contentGrants.u_A.p.active, false);
  assert(panel.textContent.includes('révoqu'));
  const deniedBefore = structuredClone(app.db.data);
  for (const body of [
    {
      scope: 'conversation_specific',
      conversationIds: ['c_B'],
      endsAt: expires
    },
    {
      scope: 'conversation_specific',
      conversationIds: ['c_private'],
      endsAt: expires
    }
  ]) {
    const r = await app.request('put', '/api/account/content-grants/p', {
      cookie,
      body
    });
    assert.equal(r.statusCode, 403);
    assert.deepEqual(app.db.data, deniedBefore);
  }
  assert.equal(
    (
      await app.request('put', '/api/account/content-grants/unassigned', {
        cookie,
        body: {
          scope: 'accompaniment_period',
          conversationIds: [],
          endsAt: expires
        }
      })
    ).statusCode,
    403
  );
  // The admin UI supplies only predefined codes, with a distinct unmask selector.
  const pro = new JSDOM('<main></main>', {
      url: 'https://synthetic.example.test',
      runScripts: 'outside-only'
    }),
    v = pro.window;
  v.Headers = Headers;
  let headers;
  v.fetch = async (input, options) => {
    headers = options.headers;
    return new Response('{}');
  };
  v.eval(
    fs.readFileSync(
      path.join(__dirname, '../../public/js/professional-review.js'),
      'utf8'
    )
  );
  let completed = false;
  const pending = v.fetch('/api/admin/users').then(() => (completed = true));
  await tick();
  assert.equal(completed, false);
  const selectors = v.document.querySelectorAll('select');
  selectors[0].value = 'security_review';
  selectors[0].dispatchEvent(new v.Event('change'));
  await pending;
  assert.equal(headers.get('x-access-reason'), 'security_review');
  assert.equal(headers.get('x-identity-unmask-reason'), null);
  selectors[1].value = 'identity_verification';
  selectors[1].dispatchEvent(new v.Event('change'));
  await v.fetch('/api/admin/users');
  assert.equal(
    headers.get('x-identity-unmask-reason'),
    'identity_verification'
  );
  dom.window.close();
  pro.window.close();
  done = true;
  console.log(
    '[PASS] CJ4 consent DOM through real APIs: readable owned public choices, restored scope/date/summary, exact local expiry and revocation; distinct admin reasons'
  );
})().catch((error) => {
  done = true;
  console.error(error);
  process.exitCode = 1;
});
