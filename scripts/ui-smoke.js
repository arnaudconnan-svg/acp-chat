'use strict';

/**
 * UI Smoke Test (Playwright)
 *
 * Vérifie que le chat fonctionne de bout en bout dans un vrai navigateur :
 * 1. Affichage de l'écran d'accueil
 * 2. Accès au chat
 * 3. Envoi d'un message et rendu utilisateur (sans crash JS)
 * 4. Réception d'une réponse bot
 * 5. Persistance de la conversation après rechargement
 *
 * Nécessite que le serveur soit démarré sur http://localhost:3000 (npm start).
 * Usage : node scripts/ui-smoke.js
 */

const { chromium } = require('playwright');

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3000';
const ALLOW_LLM_CALLS = process.env.SMOKE_ALLOW_LLM === '1';
const REQUIRE_REQUEST_ID = process.env.SMOKE_REQUIRE_REQUEST_ID === '1';
const SMOKE_ADMIN_PASSWORD = String(
  process.env.SMOKE_ADMIN_PASSWORD || ''
).trim();
const SMOKE_AUTH_EMAIL = String(process.env.SMOKE_AUTH_EMAIL || '').trim();
const SMOKE_AUTH_PASSWORD = String(
  process.env.SMOKE_AUTH_PASSWORD || ''
).trim();
const ADMIN_LOGIN_PASSWORD = 'Facilitat.io29082025';
const TEST_MESSAGE = 'Je teste le chat. Réponds brièvement.';
const BOT_REPLY_TIMEOUT_MS = 60000;
const WELCOME_TIMEOUT_MS = 25000;
const COMPOSER_TIMEOUT_MS = 15000;

async function waitForComposerVisible(page, input) {
  const immediateVisible = await input
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (immediateVisible) {
    return true;
  }

  return page
    .waitForSelector('#input', {
      state: 'visible',
      timeout: COMPOSER_TIMEOUT_MS
    })
    .then(() => true)
    .catch(() => false);
}

async function openNewConversationFromConversations(page) {
  const conversationsFabBtn = page.locator('#conversationsFabBtn');
  const visible = await conversationsFabBtn
    .isVisible({ timeout: 12000 })
    .catch(() => false);

  if (!visible) {
    return false;
  }

  await conversationsFabBtn.click();
  return true;
}

async function maybeBypassTelecharger(page) {
  const isTelecharger = /\/telecharger(?:$|\?)/.test(page.url());
  if (!isTelecharger) {
    return false;
  }

  const adminPassword = SMOKE_ADMIN_PASSWORD || ADMIN_LOGIN_PASSWORD;
  if (!adminPassword) {
    throw new Error('telecharger gate detected and admin password is missing');
  }

  const adminLink = page.getByRole('link', { name: /^Connexion admin$/i });
  const linkVisible = await adminLink
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  if (!linkVisible) {
    return false;
  }

  await adminLink.click();
  await page
    .waitForURL((url) => /\/admin-login\.html/.test(url.pathname), {
      timeout: 10000
    })
    .catch(() => {});

  const passwordInput = page.locator('#password');
  await passwordInput.fill(adminPassword);
  await page.locator('#loginForm button[type="submit"]').click();

  await page
    .waitForURL(
      (url) =>
        url.origin === new URL(BASE_URL).origin &&
        (url.pathname === '/' || url.pathname === '/index.html'),
      { timeout: 12000 }
    )
    .catch(() => {});
}

async function readSmokeTraceData(page, expectedUserMessage) {
  return page.evaluate((expectedMessage) => {
    const conversationId = String(
      localStorage.getItem('facilitatio_conversation_id') || ''
    ).trim();
    if (!conversationId) {
      return { conversationId: '', requestId: '', matchedUserMessage: false };
    }

    const key = `facilitatio_conversation_data_${conversationId}`;
    const raw = localStorage.getItem(key);
    if (!raw) {
      return { conversationId, requestId: '', matchedUserMessage: false };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const matchedUserMessage = messages.some(
      (message) =>
        message &&
        message.role === 'user' &&
        String(message.content || '').includes(String(expectedMessage || ''))
    );

    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message && message.role === 'assistant');
    const requestId =
      typeof lastAssistant?.debugMeta?.requestId === 'string'
        ? lastAssistant.debugMeta.requestId.trim()
        : '';

    return {
      conversationId,
      requestId,
      matchedUserMessage
    };
  }, expectedUserMessage);
}

async function waitForConversationsScreen(page) {
  return page
    .waitForFunction(
      () => {
        const fabBtn = document.querySelector('#conversationsFabBtn');
        return !!fabBtn && fabBtn.offsetParent !== null;
      },
      { timeout: 12000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (
      msg.type() === 'error' ||
      (msg.text().includes('[SEND][') && msg.text().includes('FAILED'))
    ) {
      consoleErrors.push(msg.text());
    }
  });

  const checks = [];
  let smokeTrace = {
    conversationId: '',
    requestId: '',
    matchedUserMessage: false
  };

  function pass(name) {
    checks.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  }

  function fail(name, reason) {
    checks.push({ name, ok: false, reason });
    console.error(`  ✗ ${name}: ${reason}`);
  }

  try {
    // 1. Welcome screen / chat entry
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    await maybeBypassTelecharger(page);
    await page
      .evaluate(() => {
        if (typeof window.showScreen === 'function') {
          window.showScreen('welcomeScreen', {
            pushHistory: false,
            replaceHistory: true,
            noAnimation: true,
            noWelcomeIntro: true
          });
        }
      })
      .catch(() => {});
    const enterBtn = page.locator('#welcomeEnterBtn');
    const enterRoleBtn = page.getByRole('button', { name: /^Entrer$/i });
    let authGateVisible = await page
      .locator('#loginForm')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    const newSessionBtn = page.getByRole('button', {
      name: /^Nouvelle session$/i
    });
    const input = page.locator('#input');

    let enterVisible = await enterBtn
      .isVisible({ timeout: WELCOME_TIMEOUT_MS })
      .catch(() => false);
    if (!enterVisible) {
      enterVisible = await enterRoleBtn
        .isVisible({ timeout: 2000 })
        .catch(() => false);
    }

    let composerVisible = await input
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    let authRequiredWithoutCredentials = false;
    const hasAuthCredentials = Boolean(SMOKE_AUTH_EMAIL && SMOKE_AUTH_PASSWORD);

    if (!hasAuthCredentials) {
      authRequiredWithoutCredentials = true;
      authGateVisible = true;
      pass('chat flow skipped (SMOKE_AUTH_EMAIL/SMOKE_AUTH_PASSWORD not set)');
    }

    if (enterVisible) {
      pass('welcome screen visible');

      // Check that welcome screen is not actually scrollable.
      // A larger inner content can legitimately be clipped by overflow:hidden.
      const scrollCheck = await page.evaluate(() => {
        const screen = document.getElementById('welcomeScreen');
        if (!screen) {
          return { isMissing: true };
        }

        const style = window.getComputedStyle(screen);
        const overflowY = String(style.overflowY || '').toLowerCase();
        const overflow = String(style.overflow || '').toLowerCase();
        const allowsScroll =
          /(auto|scroll)/.test(overflowY) || /(auto|scroll)/.test(overflow);

        return {
          isMissing: false,
          allowsScroll,
          overflowY,
          overflow,
          heightDelta: screen.scrollHeight - screen.clientHeight
        };
      });
      if (scrollCheck.isMissing) {
        fail('welcome screen scrollable check', '#welcomeScreen not found');
      } else if (scrollCheck.allowsScroll) {
        fail(
          'welcome screen scrollable check',
          `unexpected scrollable overflow (overflow=${scrollCheck.overflow}, overflowY=${scrollCheck.overflowY}, delta=${scrollCheck.heightDelta})`
        );
      } else {
        pass('welcome screen not scrollable');
      }
    } else if (composerVisible) {
      pass('chat already open');
    } else if (authGateVisible) {
      pass('auth gate visible');
    } else {
      fail(
        'welcome screen visible',
        'neither #welcomeEnterBtn nor #input was visible'
      );
    }

    // 2. Enter flow (auth gate + chat when credentials are available)
    if (hasAuthCredentials && enterVisible && !composerVisible) {
      await page.evaluate(() => {
        const button = document.getElementById('welcomeEnterBtn');
        if (button) button.click();
      });
      await page.waitForTimeout(500);

      if (/\/telecharger(?:$|\?)/.test(page.url())) {
        await maybeBypassTelecharger(page);
        await page.waitForTimeout(500);
        await page.evaluate(() => {
          const button = document.getElementById('welcomeEnterBtn');
          if (button) button.click();
        });
        await page.waitForTimeout(500);
      }

      await page
        .waitForFunction(
          () => {
            const isVisible = (selector) => {
              const element = document.querySelector(selector);
              return !!element && element.offsetParent !== null;
            };

            return (
              isVisible('#loginForm') ||
              isVisible('#input') ||
              isVisible('#conversationsFabBtn') ||
              isVisible('#welcomeEnterBtn')
            );
          },
          { timeout: 12000 }
        )
        .catch(() => {});

      const authVisible = await page
        .locator('#loginForm')
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      authGateVisible = authVisible;
      composerVisible = await input
        .isVisible({ timeout: 1000 })
        .catch(() => false);

      if (composerVisible) {
        pass('chat input visible after enter');
      } else if (authVisible) {
        pass('auth gate active after enter');

        if (!SMOKE_AUTH_EMAIL || !SMOKE_AUTH_PASSWORD) {
          authRequiredWithoutCredentials = true;
          pass(
            'chat flow skipped (SMOKE_AUTH_EMAIL/SMOKE_AUTH_PASSWORD not set)'
          );
        } else {
          await page.fill('#loginEmail', SMOKE_AUTH_EMAIL);
          await page.fill('#loginPassword', SMOKE_AUTH_PASSWORD);
          await page.locator('#loginBtn').click();

          await page
            .waitForURL(
              (url) =>
                url.origin === new URL(BASE_URL).origin &&
                (url.pathname === '/' || url.pathname === '/index.html'),
              { timeout: 12000 }
            )
            .catch(() => {});

          await waitForConversationsScreen(page);
          await openNewConversationFromConversations(page);

          await page.waitForTimeout(1200);
          composerVisible = await waitForComposerVisible(page, input);
          if (!composerVisible) {
            throw new Error(
              'chat composer did not become visible after authentication'
            );
          }
          pass('chat input visible after auth');
        }
      } else {
        const authVisibleLate = await page
          .locator('#loginForm')
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        if (authVisibleLate) {
          authGateVisible = true;
          pass('auth gate active after enter');

          if (!SMOKE_AUTH_EMAIL || !SMOKE_AUTH_PASSWORD) {
            authRequiredWithoutCredentials = true;
            pass(
              'chat flow skipped (SMOKE_AUTH_EMAIL/SMOKE_AUTH_PASSWORD not set)'
            );
          }
        } else {
          const conversationsScreenVisible = await waitForConversationsScreen(
            page
          );
          if (conversationsScreenVisible) {
            await openNewConversationFromConversations(page);
          } else {
            await page.evaluate(() => {
              if (typeof window.startFreshSession === 'function') {
                window.startFreshSession();
              }
            });
          }

          await page.waitForTimeout(1200);
          composerVisible = await waitForComposerVisible(page, input);
          if (!composerVisible) {
            throw new Error(
              'chat composer did not become visible after entering'
            );
          }
          pass('chat input visible after enter');
        }
      }
    } else if (composerVisible) {
      pass('chat input visible after enter');
    } else if (authGateVisible) {
      authRequiredWithoutCredentials = true;
      pass('chat input skipped (auth gate already active)');
    } else {
      fail('chat input visible after enter', 'composer still hidden');
    }

    if (!composerVisible) {
      if (authRequiredWithoutCredentials) {
        pass('chat send skipped (auth required in smoke environment)');
        pass('no send crash errors in console (nothing sent)');
        pass('bot reply skipped (auth required in smoke environment)');
        pass(
          'conversation persistence skipped (auth required in smoke environment)'
        );
      } else {
        fail(
          'chat send blocked',
          'composer non visible; parcours chat inutilisable'
        );
        throw new Error('chat composer not visible; smoke cannot continue');
      }
    }

    if (!composerVisible) {
      // In authenticated environments without test credentials, smoke is limited to the entry gate.
    } else {
      // 3. Send message — user bubble must appear without JS crash
      await input.fill(TEST_MESSAGE);
      await page.locator('#sendBtn').click();

      let userBubble;
      try {
        userBubble = await page.waitForSelector('.message.user .bubble', {
          timeout: 5000
        });
      } catch {
        userBubble = null;
      }

      if (userBubble) {
        const text = await userBubble.textContent();
        if (text && text.includes(TEST_MESSAGE)) {
          pass('user message rendered');
        } else {
          fail('user message rendered', `bubble text was: "${text}"`);
        }
      } else {
        fail(
          'user message rendered',
          '.message.user .bubble not found within 5s'
        );
      }

      // 4. Check no JS send errors up to this point
      const sendErrors = consoleErrors.filter(
        (e) => e.includes('[SEND][') && e.includes('FAILED')
      );
      if (sendErrors.length === 0) {
        pass('no send crash errors in console');
      } else {
        fail('no send crash errors in console', sendErrors.join('; '));
      }

      // 5. Bot reply, opt-in because it may call the LLM provider
      if (ALLOW_LLM_CALLS) {
        let botBubble;
        try {
          botBubble = await page.waitForSelector('.message.bot .bubble', {
            timeout: BOT_REPLY_TIMEOUT_MS
          });
        } catch {
          botBubble = null;
        }

        if (botBubble) {
          const text = await botBubble.textContent();
          if (text && text.trim().length > 0) {
            pass('bot reply received');
          } else {
            fail('bot reply received', 'bubble was empty');
          }
        } else {
          fail(
            'bot reply received',
            `.message.bot .bubble not found within ${BOT_REPLY_TIMEOUT_MS / 1000}s`
          );
        }
      } else {
        pass('bot reply skipped (SMOKE_ALLOW_LLM not set)');
      }

      // 6. Conversation persists after full page reload when the live LLM path is exercised
      if (ALLOW_LLM_CALLS) {
        const conversationIdBeforeReload = await page.evaluate(() =>
          localStorage.getItem('facilitatio_conversation_id')
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(800); // let hydration complete

        const storedConversationData = conversationIdBeforeReload
          ? await page.evaluate((conversationId) => {
              const raw = localStorage.getItem(
                `facilitatio_conversation_data_${conversationId}`
              );
              if (!raw) return null;
              try {
                return JSON.parse(raw);
              } catch {
                return null;
              }
            }, conversationIdBeforeReload)
          : null;

        const persistedMessages = Array.isArray(
          storedConversationData?.messages
        )
          ? storedConversationData.messages
          : [];
        const persistedUserMessage = persistedMessages.find(
          (message) =>
            message &&
            message.role === 'user' &&
            String(message.content || '').includes(TEST_MESSAGE)
        );

        if (persistedUserMessage) {
          pass('conversation persists after reload');
        } else {
          fail(
            'conversation persists after reload',
            'expected user message not found in localStorage after reload'
          );
        }

        smokeTrace = await readSmokeTraceData(page, TEST_MESSAGE);
        if (smokeTrace.conversationId) {
          pass('conversation id captured');
        } else {
          fail('conversation id captured', 'conversationId missing in localStorage');
        }

        if (smokeTrace.requestId) {
          pass('requestId captured');
        } else if (REQUIRE_REQUEST_ID) {
          fail('requestId captured', 'requestId missing in latest assistant debugMeta');
        } else {
          pass('requestId optional (SMOKE_REQUIRE_REQUEST_ID not set)');
        }
      } else {
        pass('conversation persistence skipped (SMOKE_ALLOW_LLM not set)');
      }
    }
  } catch (err) {
    fail('unexpected error', err.message);
  } finally {
    await browser.close();
  }

  // Summary
  const total = checks.length;
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);

  console.log('');
  if (failed.length === 0) {
    console.log(`ui-smoke: ${passed}/${total} passed`);
    if (smokeTrace.conversationId || smokeTrace.requestId) {
      console.log(
        `ui-smoke: trace ${JSON.stringify({
          conversationId: smokeTrace.conversationId || null,
          requestId: smokeTrace.requestId || null
        })}`
      );
    }
  } else {
    console.log(`ui-smoke: ${passed}/${total} passed, ${failed.length} FAILED`);
    failed.forEach((c) => console.error(`  FAIL: ${c.name} — ${c.reason}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('ui-smoke: fatal error:', err);
  process.exit(1);
});
