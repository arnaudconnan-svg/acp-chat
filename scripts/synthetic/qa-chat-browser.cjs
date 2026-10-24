'use strict';
/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const console = require('node:console');
const readline = require('node:readline');
const { URL } = require('node:url');
const { Buffer } = require('node:buffer');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const output = path.resolve(
  process.env.QA_CHAT_OUTPUT || '/tmp/qa-chat-renders'
);
const origin = 'http://synthetic.example.test';
fs.mkdirSync(output, { recursive: true });
function responseBody(result) {
  const wire = Buffer.from(result.wire),
    split = wire.indexOf('\r\n\r\n');
  let body = wire.subarray(split + 4);
  if (!String(result.headers['transfer-encoding']).includes('chunked'))
    return body;
  const chunks = [];
  while (body.length) {
    const end = body.indexOf('\r\n'),
      size = parseInt(body.subarray(0, end).toString(), 16);
    if (!size) break;
    assert(Number.isFinite(size) && end >= 0);
    chunks.push(body.subarray(end + 2, end + 2 + size));
    body = body.subarray(end + 2 + size + 2);
  }
  return Buffer.concat(chunks);
}
const child = spawn(
  process.execPath,
  [path.join(__dirname, 'qa-chat-worker.cjs')],
  {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      NODE_OPTIONS: '--require=' + path.join(__dirname, 'guard.cjs')
    },
    stdio: ['pipe', 'pipe', 'inherit']
  }
);
let seq = 0;
const pending = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const data = JSON.parse(line),
    waiter = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) waiter.reject(new Error(data.error));
  else waiter.resolve(data.result);
});
child.on('exit', () => {
  for (const p of pending.values()) p.reject(new Error('QA worker exited'));
  pending.clear();
});
const rpc = (data) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, ...data }) + '\n');
  });
(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox']
    });
    console.log(
      JSON.stringify({
        node: process.version,
        chromium: browser.version(),
        mocked: [
          'safety signals H0/N2',
          'writer/tokens',
          'memory',
          'disabled progress SSE',
          'injected transport failures'
        ],
        real: [
          'index.html/auth.html/assets',
          'login/session/logout and human-support consent routes',
          'chat/stream and chat JSON routes',
          'M0 in-memory runtime'
        ],
        providerCalls: 0
      })
    );
    for (const [name, viewport] of [
      ['desktop', { width: 1365, height: 900 }],
      ['mobile', { width: 390, height: 844 }]
    ]) {
      await rpc({ op: 'reset', streaming: true });
      const context = await browser.newContext({
        viewport,
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        serviceWorkers: 'block'
      });
      const calls = [],
        blocked = [],
        errors = [];
      let fault = null;
      await context.route('**/*', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== origin) {
          blocked.push(url.origin);
          return route.abort('blockedbyclient');
        }
        if (url.pathname === '/chat/progress') {
          calls.push({ path: url.pathname, mock: 'empty progress SSE' });
          return route.fulfill({ contentType: 'text/event-stream', body: '' });
        }
        if (
          url.pathname.startsWith('/api/') ||
          url.pathname.startsWith('/chat') ||
          url.pathname === '/health'
        ) {
          if (fault && ['/chat', '/chat/stream'].includes(url.pathname)) {
            const status = fault;
            fault = null;
            calls.push({
              path: url.pathname,
              status,
              mock: 'injected failure'
            });
            if (status === 'network') return route.abort('failed');
            return route.fulfill({
              status,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Synthetic QA refusal' })
            });
          }
          const result = await rpc({
            op: 'request',
            request: {
              method: req.method(),
              url: url.pathname + url.search,
              body: req.postDataJSON(),
              headers: Object.fromEntries(
                Object.entries(req.headers()).filter(([key]) =>
                  [
                    'x-client-identity',
                    'x-request-id',
                    'content-type',
                    'accept'
                  ].includes(key)
                )
              )
            }
          });
          const type = String(
            result.headers['content-type'] || 'application/json'
          );
          const body = type.includes('text/event-stream')
            ? responseBody(result)
            : JSON.stringify(result.body || {});
          calls.push({
            method: req.method(),
            path: url.pathname,
            status: result.statusCode,
            contentType: type,
            private: req.postDataJSON()?.isPrivateConversation
          });
          if (
            url.pathname === '/chat/stream' &&
            type.includes('text/event-stream')
          ) {
            const text = body.toString();
            assert(
              text.includes('event: token') && text.includes('event: result')
            );
            fs.writeFileSync(path.join(output, name + '-stream.sse'), body);
          }
          return route.fulfill({
            status: result.statusCode,
            contentType: type,
            body
          });
        }
        const pathname =
          url.pathname === '/'
            ? '/index.html'
            : url.pathname === '/telecharger'
              ? '/telecharger.html'
              : url.pathname;
        const file = path.resolve(root, 'public', '.' + pathname);
        if (
          !file.startsWith(path.join(root, 'public') + path.sep) ||
          !fs.existsSync(file) ||
          !fs.statSync(file).isFile()
        )
          return route.fulfill({ status: 404, body: '' });
        const ext = path.extname(file);
        return route.fulfill({
          contentType:
            {
              '.js': 'application/javascript',
              '.html': 'text/html',
              '.css': 'text/css',
              '.png': 'image/png',
              '.webp': 'image/webp',
              '.svg': 'image/svg+xml',
              '.woff2': 'font/woff2'
            }[ext] || 'application/octet-stream',
          body: fs.readFileSync(file)
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', (e) => errors.push(String(e)));
      const shot = (label) =>
        page.screenshot({
          path: path.join(output, name + '-' + label + '.png'),
          fullPage: true,
          animations: 'disabled'
        });
      const request = (method, url, body) =>
        rpc({ op: 'request', request: { method, url, body } });
      assert.equal(
        (
          await request('POST', '/chat', {
            message: 'SYNTHETIC',
            conversationId: 'c_qa'
          })
        ).statusCode,
        401
      );
      await page.goto(origin + '/launch-bridge.html?launch=new-private');
      await page.waitForURL('**/auth.html?**');
      await page.locator('#loginEmail').fill('qa-chat@example.test');
      await page.locator('#loginPassword').fill('wrong-synthetic-password');
      await page.locator('#loginBtn').click();
      await page
        .locator('#loginNotice')
        .filter({ hasText: 'incorrect' })
        .waitFor();
      await shot('auth-denied');
      await page.locator('#loginPassword').fill('Synthetic-QA-only-123!');
      await page.locator('#loginBtn').click();
      await page.waitForURL(
        (url) =>
          url.pathname === '/' &&
          url.searchParams.get('launch') === 'new-private'
      );
      await page.locator('#chatScreen.active').waitFor();
      const conflict = await rpc({
        op: 'request',
        request: {
          method: 'GET',
          url: '/api/account/conversations',
          headers: { 'x-client-identity': 'u_other_synthetic' }
        }
      });
      assert.equal(
        conflict.statusCode,
        409,
        'real API rejects a foreign client identity'
      );
      if (await page.locator('#sessionInfoContinueBtn').isVisible())
        await page.locator('#sessionInfoContinueBtn').click();
      const send = async (message) => {
        await page.locator('#input').fill(message);
        await page.locator('#sendBtn').click();
      };
      await send('Message de démonstration QA synthétique.');
      await page
        .locator('#chat')
        .getByText('Réponse synthétique QA — aucun fournisseur réel.', {
          exact: true
        })
        .last()
        .waitFor();
      await page.locator('#sendBtn[aria-label="Envoyer"]').waitFor();
      await shot('stream-response');
      const snapshot = await rpc({ op: 'inspect' });
      assert.equal(
        snapshot.database.messages,
        undefined,
        'private chat cannot persist messages even in the double'
      );
      assert.equal(snapshot.database.conversations, undefined);
      assert.equal(snapshot.providerCalls, 0);
      assert(snapshot.writerCalls > 0 && snapshot.egressGuardsVerified);
      // Use the real UI entry, checkbox and actual consent/refusal API.
      await page
        .getByRole('button', { name: "Plus d'options", exact: true })
        .last()
        .click();
      await page
        .getByRole('button', {
          name: 'Demander à en parler avec un professionnel humain'
        })
        .click();
      assert(await page.locator('#humanSupportSubmitBtn').isDisabled());
      assert.equal(
        (
          await request('POST', '/api/human-support/request', {
            consent: false,
            requestType: 'human_support'
          })
        ).statusCode,
        400
      );
      await shot('consent-required');
      await page.locator('#humanSupportConsent').check();
      await page.locator('#humanSupportSubmitBtn').click();
      await page
        .getByText(
          "La transmission n'a pas pu être confirmée. Rien n'est annoncé comme envoyé.",
          { exact: true }
        )
        .waitFor();
      await shot('relay-unavailable');
      assert(
        calls.some(
          (c) => c.path === '/api/human-support/request' && c.status === 503
        )
      );
      await page.locator('#humanSupportCancelBtn').click();
      for (const status of [503, 'network']) {
        fault = status;
        const count = calls.length;
        await send('Message synthétique — erreur injectée ' + status);
        await page.waitForFunction(
          () =>
            globalThis.document
              .querySelector('#sendBtn')
              .getAttribute('aria-label') === 'Envoyer'
        );
        assert(calls.slice(count).some((c) => c.mock === 'injected failure'));
        const errorText =
          status === 'network'
            ? 'Le service Facilitat.io est momentanément inaccessible. Un nouvel essai sera possible dans quelques instants.'
            : 'Le service Facilitat.io ne répond pas pour le moment. Un nouvel essai sera possible dans quelques instants.';
        await page
          .locator('#chat')
          .getByText(errorText, { exact: true })
          .last()
          .waitFor();
        assert(
          !calls.slice(count).some((c) => c.path === '/chat'),
          'ambiguous failures must not resend through JSON'
        );
        await shot('failure-' + status);
      }
      await rpc({ op: 'disable-streaming' });
      const beforeClassic = calls.length;
      const beforeReplies = await page
        .locator('#chat')
        .getByText('Réponse synthétique QA — aucun fournisseur réel.', {
          exact: true
        })
        .count();
      await send('Message synthétique — repli JSON explicite.');
      await page
        .locator('#chat')
        .getByText('Réponse synthétique QA — aucun fournisseur réel.', {
          exact: true
        })
        .nth(beforeReplies)
        .waitFor();
      await page.locator('#sendBtn[aria-label="Envoyer"]').waitFor();
      assert(
        calls
          .slice(beforeClassic)
          .some((c) => c.path === '/chat/stream' && c.status === 405)
      );
      assert(
        calls
          .slice(beforeClassic)
          .some((c) => c.path === '/chat' && c.status === 200)
      );
      await shot('json-fallback');
      const egressDenied = await page.evaluate(async () => {
        try {
          await globalThis.fetch('https://egress-probe.example.test/denied');
          return false;
        } catch {
          return true;
        }
      });
      assert(
        egressDenied && blocked.includes('https://egress-probe.example.test')
      );
      await request('POST', '/api/auth/logout');
      const beforeRevoked = calls.length;
      await send('Message synthétique — session révoquée.');
      await page.waitForFunction(
        () =>
          globalThis.document.body.style.visibility === 'hidden' &&
          globalThis.FacilitatIdentityStorage.identity === null
      );
      assert(calls.slice(beforeRevoked).some((c) => c.status === 401));
      const beforeBlocked = calls.length;
      assert(
        await page.evaluate(async () => {
          try {
            await globalThis.fetch('/chat', { method: 'POST', body: '{}' });
            return false;
          } catch (e) {
            return e.name === 'AbortError';
          }
        })
      );
      assert.equal(
        calls.length,
        beforeBlocked,
        'invalidated identity must prevent future user requests'
      );
      await shot('auth-invalidated');
      await page.goto(origin + '/launch-bridge.html?launch=new-private');
      await page.waitForURL('**/auth.html?**');
      await page.locator('#loginEmail').waitFor();
      await shot('auth-required-again');
      assert.equal(
        (
          await request('POST', '/chat', {
            message: 'SYNTHETIC',
            conversationId: 'c_qa'
          })
        ).statusCode,
        401
      );
      const final = await rpc({ op: 'inspect' });
      assert.equal(final.database.messages, undefined);
      assert.equal(final.database.conversations, undefined);
      assert.deepEqual(errors, []);
      assert(calls.filter((c) => c.path === '/api/auth/login').length <= 6);
      console.log(
        JSON.stringify({
          viewport: name,
          calls,
          blocked,
          writerCalls: final.writerCalls,
          providerCalls: 0,
          privatePersistence: false,
          scenarios: [
            'auth required/invalid/valid/logout',
            'real private chat SSE parser',
            'real 405 streaming_disabled to JSON fallback',
            'consent required/503 unavailable',
            '503/network failures; real revoked-session 401 clears identity and blocks future requests',
            'egress denied'
          ]
        })
      );
      await context.close();
      const fresh = await browser.newContext();
      assert.deepEqual((await fresh.storageState()).origins, []);
      await fresh.close();
      assert((await rpc({ op: 'discard' })).discarded);
    }
  } finally {
    await browser?.close();
    child.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
