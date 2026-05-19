#!/usr/bin/env node

/**
 * Phase 2: Full cloning of /chat endpoint to /chat/stream with SSE adaptation.
 * Strategy: Extract /chat logic, duplicate it, adapt response output only.
 */

const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");
const content = fs.readFileSync(serverPath, "utf8");

// 1. Extract /chat endpoint
const chatMarker = 'app.post("/chat", async (req, res) => {';
const chatStart = content.indexOf(chatMarker);
if (chatStart === -1) throw new Error("Could not find /chat endpoint");

// Find closing brace by counting
let depth = 0;
let inStr = false, strChar = null, escaped = false;
let chatEnd = -1;

for (let i = chatStart + chatMarker.length; i < content.length; i++) {
  const char = content[i];
  
  if (escaped) { escaped = false; continue; }
  if (char === "\\") { escaped = true; continue; }
  
  if (!inStr && (char === '"' || char === "'" || char === "`")) {
    inStr = true;
    strChar = char;
  } else if (inStr && char === strChar) {
    inStr = false;
  }
  
  if (!inStr) {
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0 && content[i+1] === ")" && content[i+2] === ";") {
        chatEnd = i + 3;
        break;
      }
    }
  }
}

if (chatEnd === -1) throw new Error("Could not find end of /chat");

const chatEndpoint = content.substring(chatStart, chatEnd);
console.log(`[1] Extracted /chat: ${chatStart}-${chatEnd} (${chatEnd - chatStart} bytes)`);

// 2. Find /chat/stream stub
const streamMarker = 'app.post("/chat/stream", async (req, res) => {';
const streamStart = content.indexOf(streamMarker);
if (streamStart === -1) throw new Error("Could not find /chat/stream stub");

// Find app.listen
const listenMarker = "app.listen(port, () => {";
const listenStart = content.indexOf(listenMarker);
if (listenStart === -1) throw new Error("Could not find app.listen");

console.log(`[2] Found /chat/stream stub at ${streamStart}, app.listen at ${listenStart}`);

// 3. Clone and adapt
let cloned = chatEndpoint;

// 3a. Change route
cloned = cloned.replace(
  'app.post("/chat"',
  'app.post("/chat/stream"'
);

// 3b. Add streaming flag check right after route definition
cloned = cloned.replace(
  'async (req, res) => {',
  `async (req, res) => {
  if (appConfig.enableChatStreaming !== true) {
    return res.status(405).json({
      error: "Chat streaming is not enabled",
      code: "streaming_disabled"
    });
  }`
);

// 3c. Change scope
cloned = cloned.replace(
  'scope: "chat",',
  'scope: "chat_stream",'
);

// 3d. Add SSE headers before try
const tryIdx = cloned.indexOf("try {");
const sseHeaders = `
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  `;
cloned = cloned.substring(0, tryIdx) + sseHeaders + cloned.substring(tryIdx);

// 3e. Replace JSON response with SSE
// Target: sendChatJsonResponse call
const responsePattern = "return sendChatJsonResponse(reply, newMemory, newFlags, debug, responseDebugMeta, botMessageId, turnSignals);";
if (cloned.includes(responsePattern)) {
  const sseResponse = `maybeGenerateConversationTitle();
    publishChatProgressTerminal(requestId, "done");

    const finalData = {
      conversationId,
      reply,
      memory: newMemory,
      flags: newFlags,
      debug,
      debugMeta: responseDebugMeta,
      botMessageId,
      signals: turnSignals
    };

    res.write(\`data: \${JSON.stringify(finalData)}\\n\\n\`);
    return res.end();`;
  
  cloned = cloned.replace(responsePattern, sseResponse);
  console.log(`[3] Adapted response output for SSE`);
}

// 3f. Fix error responses (400, 503, catch)
// Simple approach: wrap error returns in SSE format
cloned = cloned.replace(
  `return res.status(400).json({
      error: "Invalid chat request",
      issues: requestIssues
    });`,
  `res.write(\`data: \${JSON.stringify({error: "Invalid chat request", issues: requestIssues})}\\n\\n\`);
    return res.end();`
);

cloned = cloned.replace(
  `return res.status(400).json({ error: "Missing conversationId" });`,
  `res.write(\`data: \${JSON.stringify({error: "Missing conversationId"})}\\n\\n\`);
    return res.end();`
);

// Handle 503 error
cloned = cloned.replace(
  `return res.status(503).json({`,
  `const statusData = {`
);
cloned = cloned.replace(
  `memory: previousMemoryForCatch,
        flags: flagsForCatch,
        debug: ["error"],
        debugMeta: fallbackDebugMeta
      });`,
  `memory: previousMemoryForCatch,
        flags: flagsForCatch,
        debug: ["error"],
        debugMeta: fallbackDebugMeta
      };
    res.write(\`data: \${JSON.stringify(statusData)}\\n\\n\`);
    return res.end();`
);

// Handle final fallback in catch
cloned = cloned.replace(
  `return res.json({
      reply: fallbackReply,
      memory: previousMemoryForCatch,
      flags: flagsForCatch,
      debug: ["error"],
      debugMeta: fallbackDebugMeta
    });`,
  `const fallbackData = {
      reply: fallbackReply,
      memory: previousMemoryForCatch,
      flags: flagsForCatch,
      debug: ["error"],
      debugMeta: fallbackDebugMeta
    };
    res.write(\`data: \${JSON.stringify(fallbackData)}\\n\\n\`);
    return res.end();`
);

// 3g. Handle early error returns
cloned = cloned.replace(
  `return res.status(499).json({
        error: "Chat request canceled",
        canceled: true,
        requestId: requestId || null
      });`,
  `const cancelData = {
        error: "Chat request canceled",
        canceled: true,
        requestId: requestId || null
      };
    res.write(\`data: \${JSON.stringify(cancelData)}\\n\\n\`);
    return res.end();`
);

// 4. Construct new server.js
const newContent =
  content.substring(0, streamStart) +
  cloned +
  "\n\n// Start the HTTP server...\n" +
  content.substring(listenStart);

fs.writeFileSync(serverPath, newContent, "utf8");
console.log(`[4] Updated server.js - cloned /chat to /chat/stream with SSE adaptation`);
console.log(`[OK] Complete! server.js now has full /chat/stream implementation`);
