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
const TEST_MESSAGE = "Je teste le chat. Réponds brièvement.";
const BOT_REPLY_TIMEOUT_MS = 60000;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
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
    // 1. Welcome screen
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
    const enterBtn = page.locator("#welcomeEnterBtn");
    const enterVisible = await enterBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (enterVisible) {
      pass("welcome screen visible");
    } else {
      fail("welcome screen visible", "#welcomeEnterBtn not found");
    }

    // 2. Enter chat
    if (enterVisible) {
      await enterBtn.click();
      await page.waitForSelector("#input", { state: "visible", timeout: 5000 });
      pass("chat input visible after enter");
    } else {
      fail("chat input visible after enter", "skipped (welcome screen missing)");
    }

    // 3. Send message — user bubble must appear without JS crash
    await page.fill("#input", TEST_MESSAGE);
    await page.click("#sendBtn");

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

    // 5. Bot reply
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

    // 6. Conversation persists after full page reload
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForTimeout(800); // let hydration complete

    const userBubbleAfterReload = await page.locator(".message.user .bubble").first();
    const reloadedText = await userBubbleAfterReload.textContent({ timeout: 5000 }).catch(() => null);
    if (reloadedText && reloadedText.includes(TEST_MESSAGE)) {
      pass("conversation persists after reload");
    } else {
      fail("conversation persists after reload", `expected user message not found after reload (got: "${reloadedText}")`);
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
