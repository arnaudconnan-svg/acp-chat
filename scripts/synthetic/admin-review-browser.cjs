'use strict';
const assert = require('node:assert/strict');
const process = require('node:process');
const { URL } = require('node:url');
const console = require('node:console');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve('.');
const output = path.resolve(
  process.env.ADMIN_REVIEW_OUTPUT || '/tmp/admin-review-renders'
);
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    for (const [name, viewport] of [
      ['desktop', { width: 1365, height: 900 }],
      ['mobile', { width: 390, height: 844 }]
    ]) {
      const context = await browser.newContext({ viewport });
      const calls = [],
        errors = [];
      let hold = null,
        release,
        fault = null,
        session = 'synthetic-session-A';
      await context.route('**/*', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== 'http://synthetic.example.test') {
          errors.push('external request blocked');
          return route.abort();
        }
        if (url.pathname === '/index.html')
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Déconnexion synthétique</title>'
          });
        const json = (data, status = 200) =>
          route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(data)
          });
        if (url.pathname === '/api/auth/session')
          return json({ authenticated: false });
        if (url.pathname === '/api/admin/session')
          return json({
            authenticated: true,
            reviewContext: session,
            canUseAdminUi: true,
            canAccessAdminConversations: true,
            canAccessSupportCases: true
          });
        if (url.pathname === '/api/admin/logout')
          return json({ success: true });
        if (url.pathname.startsWith('/api/admin/')) {
          const headers = request.headers(),
            revealed = !!headers['x-identity-unmask-reason'];
          calls.push({
            path: url.pathname,
            reason: headers['x-access-reason'],
            unmask: headers['x-identity-unmask-reason'] || null
          });
          if (!headers['x-access-reason']) errors.push('missing audit reason');
          if (revealed && hold) await hold;
          if (fault && revealed) {
            const code = fault;
            fault = null;
            if (code === 'network') return route.abort('failed');
            return json({ error: 'Synthetic refusal' }, code);
          }
          const identity = revealed
            ? {
                userLabel: 'SYNTHETIC ALICE',
                userEmail: 'synthetic-alice@example.test',
                userId: 'u_synthetic'
              }
            : { userLabel: 'Participant synthétique' };
          try {
            if (url.pathname.endsWith('/branches')) return json(null);
            if (url.pathname.endsWith('/messages'))
              return json([
                {
                  id: 'm_synthetic',
                  role: 'user',
                  content: 'Échange de démonstration — données synthétiques.',
                  timestamp: 1792587600000,
                  ...identity
                }
              ]);
            if (url.pathname.includes('/intersession-memory/')) return json({});
            if (url.pathname === '/api/admin/conversations')
              return json([
                {
                  id: 'c_synthetic',
                  title: 'Conversation synthétique',
                  createdAt: 1792587600000,
                  updatedAt: 1792587600000,
                  messageCount: 1,
                  ...identity
                }
              ]);
            errors.push('unexpected API ' + url.pathname);
            return json({}, 404);
          } catch {
            /* A deliberately aborted old response may no longer be fulfillable. */
          }
        }
        const allowed =
          url.pathname === '/admin.html' ||
          url.pathname === '/pros.html' ||
          (url.pathname.startsWith('/js/') && !url.pathname.includes('..'));
        if (!allowed) return route.fulfill({ status: 404, body: '' });
        const file = path.join(root, 'public', url.pathname);
        if (!fs.existsSync(file))
          return route.fulfill({ status: 404, body: '' });
        return route.fulfill({
          contentType: file.endsWith('.js')
            ? 'application/javascript'
            : 'text/html',
          body: fs.readFileSync(file)
        });
      });
      const page = await context.newPage();
      await page.clock.install();
      const access = () =>
        page.getByLabel('Motif administrateur', { exact: true });
      const identity = () =>
        page.getByLabel('Motif de levée de pseudonymisation', { exact: true });
      const masked = async () => {
        await page
          .locator('#list')
          .getByText('Participant synthétique', { exact: false })
          .first()
          .waitFor();
        assert(
          !(await page.locator('body').innerText()).includes('SYNTHETIC ALICE')
        );
      };
      const noIdentity = async () => {
        const html = await page.locator('body').innerHTML();
        for (const marker of [
          'SYNTHETIC ALICE',
          'synthetic-alice@example.test',
          'u_synthetic'
        ])
          assert(!html.includes(marker));
        const storage = await page.evaluate(() =>
          JSON.stringify([
            Object.entries(globalThis.sessionStorage),
            Object.entries(globalThis.localStorage)
          ])
        );
        assert(!storage.includes('SYNTHETIC ALICE'));
        assert(!storage.includes('u_synthetic'));
      };
      const shot = (label) =>
        page.screenshot({
          path: path.join(output, name + '-' + label + '.png'),
          fullPage: true
        });
      await page.goto('http://synthetic.example.test/admin.html');
      await access().selectOption('support_incident');
      await masked();
      await shot('list-masked');
      await identity().selectOption('identity_verification');
      await page
        .getByText('SYNTHETIC ALICE', { exact: false })
        .first()
        .waitFor();
      await shot('list-revealed');
      await page.locator('.admin-conversation-open-btn').first().click();
      await page.waitForURL('**/admin.html?c=c_synthetic');
      await page
        .getByText('Échange de démonstration — données synthétiques.', {
          exact: false
        })
        .first()
        .waitFor();
      assert.equal(await access().inputValue(), 'support_incident');
      assert.equal(await identity().inputValue(), '');
      await access().selectOption('security_review');
      await page
        .getByText('Échange de démonstration — données synthétiques.', {
          exact: false
        })
        .first()
        .waitFor();
      await shot('conversation-reason');
      await identity().selectOption('identity_verification');
      await page
        .getByText('SYNTHETIC ALICE', { exact: false })
        .first()
        .waitFor();
      await identity().selectOption('');
      assert(
        !(await page.locator('body').innerText()).includes('SYNTHETIC ALICE')
      );
      await page.goto('http://synthetic.example.test/admin.html');
      await masked();
      assert.equal(await access().inputValue(), 'security_review');
      hold = new Promise((resolve) => {
        release = resolve;
      });
      await identity().selectOption('identity_verification');
      await page.waitForFunction(() =>
        globalThis.document
          .querySelector('#list')
          .textContent.includes('Chargement')
      );
      await identity().selectOption('');
      await masked();
      release();
      hold = null;
      await page.waitForTimeout(100);
      await masked();
      await noIdentity();
      await shot('race-remasked');
      await page.reload();
      await masked();
      assert.equal(await identity().inputValue(), '');
      for (const code of [401, 403, 500, 'network']) {
        fault = code;
        await identity().selectOption('identity_verification');
        await page.waitForFunction(
          () =>
            globalThis.document.querySelector(
              '[aria-label="Motif de levée de pseudonymisation"]'
            ).value === ''
        );
        assert(
          !(await page.locator('body').innerText()).includes('SYNTHETIC ALICE')
        );
        if (code === 401 || code === 403) {
          await access().selectOption('user_request');
          await masked();
        }
      }
      await page
        .getByRole('button', { name: 'Réinitialiser le motif' })
        .click();
      assert.equal(await access().inputValue(), '');
      assert.equal(
        await page.evaluate(() =>
          globalThis.sessionStorage.getItem('facilitatio:admin-review:v1')
        ),
        null
      );
      await access().selectOption('security_review');
      await masked();
      await page.reload();
      await masked();
      assert.equal(await access().inputValue(), 'security_review');
      session = 'synthetic-session-B';
      await page.reload();
      await access().waitFor();
      assert.equal(await access().inputValue(), '');
      await access().selectOption('user_request');
      await masked();
      await page.goto('http://synthetic.example.test/pros.html');
      await page.getByRole('button', { name: /déconnexion/i }).click();
      await page.waitForURL('**/index.html');
      assert.equal(
        await page.evaluate(() =>
          globalThis.sessionStorage.getItem('facilitatio:admin-review:v1')
        ),
        null
      );
      await page.goto('http://synthetic.example.test/admin.html');
      await access().selectOption('support_incident');
      await masked();
      await page.clock.fastForward(10 * 60 * 1000 + 1);
      assert.equal(await access().inputValue(), '');
      assert.equal(
        await page.evaluate(() =>
          globalThis.sessionStorage.getItem('facilitatio:admin-review:v1')
        ),
        null
      );
      assert(
        !(await page.locator('body').innerText()).includes('SYNTHETIC ALICE')
      );
      await shot('expired');
      assert.deepEqual(errors, []);
      assert(
        calls.some(
          (c) => c.reason === 'security_review' && c.path.endsWith('/messages')
        )
      );
      assert(calls.some((c) => c.unmask));
      console.log(
        JSON.stringify({
          viewport: name,
          scenarios: [
            'list/reveal/refresh',
            'navigation/reason reuse/edit',
            'conversation/remask',
            'late response race',
            'reload masked',
            '401/403/500/network fail closed',
            'reset',
            'changed session',
            'logout from professional space',
            '10 minute expiry'
          ],
          requests: calls,
          externalNetwork: false
        })
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
