'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'auth.html'),
  'utf8'
);
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
async function load(url, fetchImpl) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = fetchImpl;
      window.scrollTo = () => {};
    }
  });
  await tick();
  return dom;
}
function token() {
  return `u_${'a'.repeat(24)}.${'B'.repeat(43)}`;
}

async function main() {
  for (const fragment of [
    '#reset=',
    '#reset=%E0%A4%A',
    `#reset=${token()}&extra=1`
  ]) {
    const dom = await load(
      `https://beta.facilitat.io/auth.html${fragment}`,
      async () => {
        throw new Error('unexpected fetch');
      }
    );
    const { document, location } = dom.window;
    assert.strictEqual(
      location.hash,
      '',
      'reset fragments must always be purged'
    );
    assert.notStrictEqual(
      document.getElementById('resetForm').style.display,
      'none'
    );
    assert.match(
      document.getElementById('resetNotice').textContent,
      /invalide|incomplet/
    );
    assert.notStrictEqual(
      document.getElementById('resetActions').style.display,
      'none'
    );
    dom.window.close();
  }

  for (const scenario of [
    {
      status: 410,
      body: { error: 'Ce lien de réinitialisation a expiré.' },
      expected: /expiré/,
      actions: true
    },
    {
      status: 400,
      body: {
        error: 'Ce lien de réinitialisation est invalide ou a déjà été utilisé.'
      },
      expected: /invalide/,
      actions: true
    },
    { status: 200, body: { success: true }, expected: /modifié/, actions: true }
  ]) {
    const dom = await load(
      `https://beta.facilitat.io/auth.html?next=%2Faccount.html#reset=${token()}`,
      async (url) => {
        assert.strictEqual(url, '/api/auth/reset-password');
        return response(scenario.status, scenario.body);
      }
    );
    const { document } = dom.window;
    document.getElementById('resetPassword').value = 'NouveauMot2';
    document.getElementById('resetPassword2').value = 'NouveauMot2';
    await dom.window.handleResetPassword({ preventDefault() {} });
    assert.match(
      document.getElementById('resetNotice').textContent,
      scenario.expected
    );
    assert.strictEqual(
      document.getElementById('resetActions').style.display !== 'none',
      scenario.actions
    );
    if (scenario.status === 200) {
      assert.strictEqual(document.getElementById('resetPassword').value, '');
      assert.strictEqual(document.getElementById('resetPassword2').value, '');
    }
    dom.window.close();
  }

  const networkDom = await load(
    `https://beta.facilitat.io/auth.html#reset=${token()}`,
    async () => {
      throw new Error('offline');
    }
  );
  networkDom.window.document.getElementById('resetPassword').value =
    'NouveauMot2';
  networkDom.window.document.getElementById('resetPassword2').value =
    'NouveauMot2';
  await networkDom.window.handleResetPassword({ preventDefault() {} });
  assert.match(
    networkDom.window.document.getElementById('resetNotice').textContent,
    /ne répond pas/
  );
  networkDom.window.close();

  let resolveSession;
  const sessionPromise = new Promise((resolve) => {
    resolveSession = resolve;
  });
  const guardDom = await load(
    'https://beta.facilitat.io/auth.html?next=%2Faccount.html',
    async (url) => {
      if (url === '/api/auth/session') {
        await sessionPromise;
        return response(200, { authenticated: true });
      }
      throw new Error('unexpected fetch');
    }
  );
  guardDom.window.showRecoveryRequest();
  resolveSession();
  await tick();
  assert.notStrictEqual(
    guardDom.window.document.getElementById('forgotForm').style.display,
    'none',
    'late session response must not redirect recovery'
  );
  assert.strictEqual(
    guardDom.window.FacilitatAuth.getRedirectTarget(),
    '/account.html'
  );
  guardDom.window.history.replaceState(
    {},
    '',
    '/auth.html?next=https%3A%2F%2Fevil.test%2Fsteal'
  );
  assert.strictEqual(
    guardDom.window.FacilitatAuth.getRedirectTarget(),
    '/?screen=conversationsScreen'
  );
  guardDom.window.showTab('login');
  guardDom.window.document.getElementById('loginEmail').value =
    'personne@example.test';
  guardDom.window.document.getElementById('loginPassword').value =
    'NouveauMot2';
  await tick(100);
  assert.strictEqual(
    guardDom.window.document.getElementById('loginNotice').textContent,
    '',
    'autofill must stay suppressed after recovery'
  );
  guardDom.window.close();

  console.log(
    '[PASS] password reset frontend DOM: fragments, outcomes, session race, redirects and autofill'
  );
}
main().catch((error) => {
  console.error('[FAIL] password reset frontend harness:', error);
  process.exit(1);
});
