"use strict";

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

const { chromium } = require("playwright");

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const ALLOW_LLM_CALLS = process.env.SMOKE_ALLOW_LLM === "1";
const TEST_MESSAGE = "Je teste le chat. Réponds brièvement.";
const BOT_REPLY_TIMEOUT_MS = 60000;
const WELCOME_TIMEOUT_MS = 15000;
const COMPOSER_TIMEOUT_MS = 15000;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", msg => {
    if (msg.type() === "error" || msg.text().includes("[SEND][") && msg.text().includes("FAILED")) {
      consoleErrors.push(msg.text());
    }
  });

  const checks = [];

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
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
    const enterBtn = page.locator("#welcomeEnterBtn");
    const enterRoleBtn = page.getByRole("button", { name: /^Entrer$/i });
    const newSessionBtn = page.getByRole("button", { name: /^Nouvelle session$/i });
    const input = page.locator("#input");

    let enterVisible = await enterBtn.isVisible({ timeout: WELCOME_TIMEOUT_MS }).catch(() => false);
    if (!enterVisible) {
      enterVisible = await enterRoleBtn.isVisible({ timeout: 2000 }).catch(() => false);
    }

    let composerVisible = await input.isVisible({ timeout: 2000 }).catch(() => false);

    if (enterVisible) {
      pass("welcome screen visible");
      
      // Check that welcome screen is not actually scrollable.
      // A larger inner content can legitimately be clipped by overflow:hidden.
      const scrollCheck = await page.evaluate(() => {
        const screen = document.getElementById("welcomeScreen");
        if (!screen) {
          return { isMissing: true };
        }

        const style = window.getComputedStyle(screen);
        const overflowY = String(style.overflowY || "").toLowerCase();
        const overflow = String(style.overflow || "").toLowerCase();
        const allowsScroll = /(auto|scroll)/.test(overflowY) || /(auto|scroll)/.test(overflow);
        const clipped = /(hidden|clip)/.test(overflowY) || /(hidden|clip)/.test(overflow);

        return {
          isMissing: false,
          allowsScroll,
          clipped,
          overflowY,
          overflow,
          heightDelta: screen.scrollHeight - screen.clientHeight
        };
      });
      if (scrollCheck.isMissing) {
        fail("welcome screen scrollable check", "#welcomeScreen not found");
      } else if (scrollCheck.allowsScroll) {
        fail(
          "welcome screen scrollable check",
          `unexpected scrollable overflow (overflow=${scrollCheck.overflow}, overflowY=${scrollCheck.overflowY}, delta=${scrollCheck.heightDelta})`
        );
      } else {
        pass("welcome screen not scrollable");
      }
    } else if (composerVisible) {
      pass("chat already open");
    } else {
      fail("welcome screen visible", "neither #welcomeEnterBtn nor #input was visible");
    }

    // 2. Enter chat
    if (enterVisible && !composerVisible) {
      await page.evaluate(() => {
        const button = document.getElementById("welcomeEnterBtn");
        if (button) button.click();
      });
      await page.waitForTimeout(1000);

      const newSessionVisible = await newSessionBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (newSessionVisible) {
        await page.evaluate(() => {
          const button = document.getElementById("conversationsFabBtn");
          if (button) button.click();
        });
      } else {
        await page.evaluate(() => {
          if (typeof window.startFreshSession === "function") {
            window.startFreshSession();
          }
        });
      }

      await page.waitForTimeout(1200);
      composerVisible = await input.isVisible({ timeout: COMPOSER_TIMEOUT_MS }).catch(() => false);
      if (!composerVisible) {
        composerVisible = await page.waitForSelector("#input", { state: "visible", timeout: COMPOSER_TIMEOUT_MS }).then(() => true).catch(() => false);
      }
      if (!composerVisible) {
        throw new Error("chat composer did not become visible after entering");
      }
      pass("chat input visible after enter");
    } else if (composerVisible) {
      pass("chat input visible after enter");
    } else {
      fail("chat input visible after enter", "composer still hidden");
    }

    // 3. Send message — user bubble must appear without JS crash
    await input.fill(TEST_MESSAGE);
    await page.locator("#sendBtn").click();

    let userBubble;
    try {
      userBubble = await page.waitForSelector(".message.user .bubble", { timeout: 5000 });
    } catch {
      userBubble = null;
    }

    if (userBubble) {
      const text = await userBubble.textContent();
      if (text && text.includes(TEST_MESSAGE)) {
        pass("user message rendered");
      } else {
        fail("user message rendered", `bubble text was: "${text}"`);
      }
    } else {
      fail("user message rendered", ".message.user .bubble not found within 5s");
    }

    // 4. Check no JS send errors up to this point
    const sendErrors = consoleErrors.filter(e => e.includes("[SEND][") && e.includes("FAILED"));
    if (sendErrors.length === 0) {
      pass("no send crash errors in console");
    } else {
      fail("no send crash errors in console", sendErrors.join("; "));
    }

    // 5. Bot reply, opt-in because it may call the LLM provider
    if (ALLOW_LLM_CALLS) {
      let botBubble;
      try {
        botBubble = await page.waitForSelector(".message.bot .bubble", { timeout: BOT_REPLY_TIMEOUT_MS });
      } catch {
        botBubble = null;
      }

      if (botBubble) {
        const text = await botBubble.textContent();
        if (text && text.trim().length > 0) {
          pass("bot reply received");
        } else {
          fail("bot reply received", "bubble was empty");
        }
      } else {
        fail("bot reply received", `.message.bot .bubble not found within ${BOT_REPLY_TIMEOUT_MS / 1000}s`);
      }
    } else {
      pass("bot reply skipped (SMOKE_ALLOW_LLM not set)");
    }

    // 6. Conversation persists after full page reload when the live LLM path is exercised
    if (ALLOW_LLM_CALLS) {
      const conversationIdBeforeReload = await page.evaluate(() => localStorage.getItem("facilitatio_conversation_id"));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(800); // let hydration complete

      const storedConversationData = conversationIdBeforeReload
        ? await page.evaluate(conversationId => {
            const raw = localStorage.getItem(`facilitatio_conversation_data_${conversationId}`);
            if (!raw) return null;
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          }, conversationIdBeforeReload)
        : null;

      const persistedMessages = Array.isArray(storedConversationData?.messages) ? storedConversationData.messages : [];
      const persistedUserMessage = persistedMessages.find(message => message && message.role === "user" && String(message.content || "").includes(TEST_MESSAGE));

      if (persistedUserMessage) {
        pass("conversation persists after reload");
      } else {
        fail("conversation persists after reload", "expected user message not found in localStorage after reload");
      }
    } else {
      pass("conversation persistence skipped (SMOKE_ALLOW_LLM not set)");
    }

  } catch (err) {
    fail("unexpected error", err.message);
  } finally {
    await browser.close();
  }

  // Summary
  const total = checks.length;
  const passed = checks.filter(c => c.ok).length;
  const failed = checks.filter(c => !c.ok);

  console.log("");
  if (failed.length === 0) {
    console.log(`ui-smoke: ${passed}/${total} passed`);
  } else {
    console.log(`ui-smoke: ${passed}/${total} passed, ${failed.length} FAILED`);
    failed.forEach(c => console.error(`  FAIL: ${c.name} — ${c.reason}`));
    process.exit(1);
  }
}

run().catch(err => {
  console.error("ui-smoke: fatal error:", err);
  process.exit(1);
});
