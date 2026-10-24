'use strict';
/* global __dirname, __filename */
// Chromium renders the real account page. Its API broker runs the real routes
// under the existing M0 guard, with an in-memory database and no listening socket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline');
const console = require('node:console');
const { URL } = require('node:url');
const root = path.resolve(__dirname, '../..');
if (process.argv.includes('--api-worker')) {
  assert(require.cache[path.join(__dirname, 'guard.cjs')]);
  const { loadApplication } = require('./runtime.cjs');
  let app, cookie;
  const input = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  input.on('line', (line) => {
    chain = chain.then(async () => {
      const { id, op, scenario, request } = JSON.parse(line);
      try {
        let result;
        if (op === 'reset') {
          app = loadApplication({
            seed: {
              users: {
                u_synthetic: {
                  authVersion: 0,
                  email: 'synthetic-user@example.test',
                  country: 'FR'
                }
              },
              professionalIdentities: {
                p_synthetic: {
                  active: true,
                  roles: ['practitioner'],
                  displayName: 'Praticien synthétique'
                }
              },
              practitionerAssignments:
                scenario === 'zero'
                  ? {}
                  : { p_synthetic: { u_synthetic: { active: true } } },
              conversations: {
                c_synthetic: {
                  userId: 'u_synthetic',
                  title: 'Conversation synthétique publique',
                  updatedAt: Date.now()
                },
                c_private: {
                  userId: 'u_synthetic',
                  title: 'PRIVATE_SENTINEL',
                  isPrivate: true
                },
                c_foreign: { userId: 'u_foreign', title: 'FOREIGN_SENTINEL' }
              }
            }
          });
          cookie =
            'userSessionId=' +
            app.evaluate("buildUserSessionToken('u_synthetic',0)");
          result = { ready: true };
        } else if (op === 'state') {
          result = {
            grants: app.db.data.contentGrants || {},
            operations: app.db.operations,
            blocked: app.blocked
          };
        } else if (op === 'expire') {
          app.db.data.contentGrants.u_synthetic.p_synthetic.endsAt =
            Date.now() - 1;
          result = { expired: true };
        } else if (op === 'unassign') {
          app.db.data.practitionerAssignments.p_synthetic.u_synthetic.active = false;
          result = { unassigned: true };
        } else {
          result = await app.request(request.method, request.url, {
            cookie,
            body: request.body || {}
          });
        }
        process.stdout.write(JSON.stringify({ id, result }) + '\n');
      } catch (error) {
        process.stdout.write(
          JSON.stringify({ id, error: String(error.stack) }) + '\n'
        );
      }
    });
  });
} else {
  const { spawn } = require('node:child_process');
  const { chromium } = require('playwright');
  const output = path.resolve(
    process.env.CONSENT_OUTPUT || '/tmp/consent-renders'
  );
  fs.mkdirSync(output, { recursive: true });
  const child = spawn(process.execPath, [__filename, '--api-worker'], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      NODE_OPTIONS: '--require=' + path.join(__dirname, 'guard.cjs')
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let sequence = 0;
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const data = JSON.parse(line),
      waiter = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data.result);
  });
  const rpc = (data) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
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
          isolation: 'guarded M0 API worker; route interception; env-i parent'
        })
      );
      for (const [name, viewport] of [
        ['desktop', { width: 1365, height: 900 }],
        ['mobile', { width: 390, height: 844 }]
      ]) {
        await rpc({ op: 'reset', scenario: 'zero' });
        const context = await browser.newContext({
          viewport,
          locale: 'fr-FR',
          timezoneId: 'Europe/Paris',
          serviceWorkers: 'block'
        });
        const calls = [],
          errors = [];
        let refusal = false;
        await context.route('**/*', async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          if (url.origin !== 'http://synthetic.example.test') {
            errors.push('external ' + url.origin);
            return route.abort();
          }
          if (url.pathname.startsWith('/api/')) {
            const body = req.postDataJSON();
            let result;
            if (
              refusal &&
              req.method() === 'PUT' &&
              url.pathname.includes('/content-grants/')
            ) {
              refusal = false;
              result = {
                statusCode: 403,
                body: { error: 'Synthetic refusal' }
              };
            } else
              result = await rpc({
                op: 'request',
                request: {
                  method: req.method(),
                  url: url.pathname + url.search,
                  body
                }
              });
            calls.push({
              method: req.method(),
              path: url.pathname,
              status: result.statusCode,
              body: req.method() === 'PUT' ? body : undefined
            });
            return route.fulfill({
              status: result.statusCode,
              contentType: 'application/json',
              body: JSON.stringify(result.body || {})
            });
          }
          const file = path.resolve(root, 'public', '.' + url.pathname);
          if (
            !file.startsWith(path.join(root, 'public') + path.sep) ||
            !fs.existsSync(file) ||
            !fs.statSync(file).isFile()
          )
            return route.fulfill({ status: 404, body: '' });
          return route.fulfill({
            contentType: file.endsWith('.js')
              ? 'application/javascript'
              : file.endsWith('.css')
                ? 'text/css'
                : 'text/html',
            body: fs.readFileSync(file)
          });
        });
        const page = await context.newPage();
        await page.clock.install();
        page.on('pageerror', (e) => errors.push(String(e)));
        const panel = () =>
          page.locator('section').filter({
            has: page.getByRole('heading', {
              name: 'Accès de mon praticien',
              exact: true
            })
          });
        const status = () => panel().getByRole('status');
        const shot = (label) =>
          panel().screenshot({
            path: path.join(output, name + '-' + label + '.png')
          });
        const load = async () => {
          await page.goto('http://synthetic.example.test/account.html');
          await panel().waitFor();
        };
        await load();
        await status().filter({ hasText: 'Aucun praticien affecté' }).waitFor();
        assert(
          await panel()
            .getByRole('button', { name: 'Autoriser', exact: true })
            .isDisabled()
        );
        await shot('zero');
        await rpc({ op: 'reset', scenario: 'one' });
        await load();
        await status().filter({ hasText: 'Vérifiez' }).waitFor();
        assert.equal(
          await panel()
            .getByLabel('Praticien affecté', { exact: true })
            .inputValue(),
          'p_synthetic'
        );
        assert(
          (await panel().innerText()).includes(
            'Aucune autorisation enregistrée'
          )
        );
        assert(!(await panel().innerText()).includes('PRIVATE_SENTINEL'));
        assert(!(await panel().innerText()).includes('FOREIGN_SENTINEL'));
        const authorize = () =>
          panel().getByRole('button', { name: 'Autoriser', exact: true });
        await authorize().click();
        await status().filter({ hasText: 'Choisissez une date' }).waitFor();
        const expiry = new Date(
          Math.ceil((Date.now() + 3600000) / 60000) * 60000
        );
        const local = new Date(expiry.getTime() + 2 * 3600000)
          .toISOString()
          .slice(0, 16);
        await panel()
          .getByLabel('Fin de l’autorisation en heure locale', { exact: true })
          .fill(local);
        await authorize().click();
        await status().filter({ hasText: 'Autorisation refusée' }).waitFor();
        await panel()
          .getByRole('checkbox', { name: /Conversation synthétique publique/ })
          .check();
        await panel()
          .getByRole('checkbox', {
            name: 'Autoriser aussi la synthèse inter-session'
          })
          .check();
        await shot('selected');
        const scopeBounds = await panel()
          .getByLabel('Portée de l’autorisation', { exact: true })
          .boundingBox();
        const panelBounds = await panel().boundingBox();
        console.log(
          JSON.stringify({ viewport: name, scopeBounds, panelBounds })
        );
        assert(
          scopeBounds.x + scopeBounds.width <=
            panelBounds.x + panelBounds.width,
          'the authorization scope must fit its mobile card'
        );
        await authorize().click();
        await status()
          .filter({ hasText: 'Autorisation enregistrée' })
          .waitFor();
        const state = await rpc({ op: 'state' });
        assert.equal(state.grants.u_synthetic.p_synthetic.active, true);
        assert.deepEqual(state.grants.u_synthetic.p_synthetic.conversationIds, [
          'c_synthetic'
        ]);
        assert.equal(
          state.grants.u_synthetic.p_synthetic.endsAt,
          expiry.getTime()
        );
        assert.equal(
          state.grants.u_synthetic.p_synthetic.allowIntersessionSummary,
          true
        );
        await shot('active');
        await load();
        await panel()
          .locator('[data-grant-current]')
          .filter({ hasText: 'Autorisation active' })
          .waitFor();
        assert(
          await panel()
            .getByRole('checkbox', {
              name: /Conversation synthétique publique/
            })
            .isChecked()
        );
        refusal = true;
        await authorize().click();
        await status().filter({ hasText: 'Autorisation refusée' }).waitFor();
        assert.equal(
          (await rpc({ op: 'state' })).grants.u_synthetic.p_synthetic.version,
          1
        );
        await shot('refused');
        await panel()
          .getByRole('button', { name: 'Révoquer', exact: true })
          .click();
        await status().filter({ hasText: 'Accès révoqué' }).waitFor();
        assert.equal(
          (await rpc({ op: 'state' })).grants.u_synthetic.p_synthetic.active,
          false
        );
        await load();
        await panel()
          .locator('[data-grant-current]')
          .filter({ hasText: 'Autorisation révoquée' })
          .waitFor();
        await shot('revoked');
        await authorize().click();
        await status()
          .filter({ hasText: 'Autorisation enregistrée' })
          .waitFor();
        await panel()
          .getByLabel('Portée de l’autorisation', { exact: true })
          .selectOption('accompaniment_period');
        await panel()
          .getByRole('checkbox', {
            name: 'Autoriser aussi la synthèse inter-session'
          })
          .uncheck();
        await authorize().click();
        await status()
          .filter({ hasText: 'Autorisation enregistrée' })
          .waitFor();
        const period = (await rpc({ op: 'state' })).grants.u_synthetic
          .p_synthetic;
        assert.equal(period.scope, 'accompaniment_period');
        assert.deepEqual(period.conversationIds, []);
        assert.equal(period.allowIntersessionSummary, false);
        await load();
        await panel()
          .locator('[data-grant-current]')
          .filter({ hasText: 'historique et futures conversations publiques' })
          .waitFor();
        assert.equal(
          await panel()
            .getByLabel('Portée de l’autorisation', { exact: true })
            .inputValue(),
          'accompaniment_period'
        );
        assert(
          await panel()
            .locator('fieldset')
            .evaluate((el) => el.disabled)
        );
        await shot('period-restored');
        await panel()
          .getByLabel('Portée de l’autorisation', { exact: true })
          .selectOption('conversation_specific');
        // Expiry must update only the durable receipt, preserving unsaved edits.
        await panel()
          .getByRole('checkbox', { name: /Conversation synthétique publique/ })
          .uncheck();
        await panel()
          .getByRole('checkbox', {
            name: 'Autoriser aussi la synthèse inter-session'
          })
          .uncheck();
        const editedEnd = await panel()
          .getByLabel('Fin de l’autorisation en heure locale', { exact: true })
          .inputValue();
        await rpc({ op: 'expire' });
        await page.clock.fastForward(3600000 + 60001);
        await shot('expiry-observed');
        assert(
          (await panel().locator('[data-grant-current]').innerText()).includes(
            'Autorisation expirée'
          ),
          'the visible active authorization must expire without requiring a reload'
        );
        assert.equal(
          await panel()
            .getByRole('checkbox', {
              name: /Conversation synthétique publique/
            })
            .isChecked(),
          false
        );
        assert.equal(
          await panel()
            .getByRole('checkbox', {
              name: 'Autoriser aussi la synthèse inter-session'
            })
            .isChecked(),
          false
        );
        assert.equal(
          await panel()
            .getByLabel('Fin de l’autorisation en heure locale', {
              exact: true
            })
            .inputValue(),
          editedEnd
        );
        await shot('expired-live');
        await load();
        await panel()
          .locator('[data-grant-current]')
          .filter({ hasText: 'Autorisation expirée' })
          .waitFor();
        await shot('expired');
        await rpc({ op: 'unassign' });
        await load();
        await panel()
          .getByLabel('Praticien affecté', { exact: true })
          .getByRole('option', {
            name: 'Autorisation existante sans affectation active'
          })
          .waitFor({ state: 'attached' });
        assert(await authorize().isDisabled());
        assert.equal(
          await panel()
            .getByRole('button', { name: 'Révoquer', exact: true })
            .isDisabled(),
          false
        );
        await shot('unassigned');
        assert.deepEqual(errors, []);
        const final = await rpc({ op: 'state' });
        assert(final.blocked.includes('listen'));
        console.log(
          JSON.stringify({
            viewport: name,
            calls,
            scenarios: [
              'zero',
              'one',
              'invalid date',
              'empty selection refusal',
              'explicit selection/summary',
              'authorization',
              'reload persistence',
              '403 no mutation',
              'revocation',
              'expiry reload',
              'unassigned blocked'
            ],
            externalNetwork: false
          })
        );
        await context.close();
      }
    } finally {
      await browser?.close();
      child.kill();
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
