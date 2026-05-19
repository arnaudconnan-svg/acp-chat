
/**
 * Clone /chat endpoint to /chat/stream with SSE output adaptation.
 * Pragmatic approach: full endpoint duplication with surgical SSE changes.
 */

/**
 * Clone /chat endpoint to /chat/stream with SSE output adaptation.
 * Pragmatic approach: full endpoint duplication, one-line adaptation for streaming.
 */

const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");
let serverContent = fs.readFileSync(serverPath, "utf8");

// Find /chat endpoint (app.post("/chat", ...)
const chatStartPattern = 'app.post("/chat", async (req, res) => {';
const chatStartIdx = serverContent.indexOf(chatStartPattern);

if (chatStartIdx === -1) {
  console.error("ERROR: Could not find app.post(\"/chat\") in server.js");
  process.exit(1);
}

// Find the closing "}));" of /chat endpoint.
// Strategy: count opening/closing braces from chatStartIdx.
let braceCount = 0;
let inString = false;
let escapeNext = false;
let chatEndIdx = -1;

for (let i = chatStartIdx; i < serverContent.length; i++) {
  const char = serverContent[i];
  const prevChar = i > 0 ? serverContent[i - 1] : "";

  if (escapeNext) {
    escapeNext = false;
    continue;
  }

  if (char === "\\") {
    escapeNext = true;
    continue;
  }

  if (char === '"' && prevChar !== "\\") {
    inString = !inString;
    continue;
  }

  if (!inString) {
    if (char === "{") {
      braceCount++;
    } else if (char === "}") {
      braceCount--;
      if (braceCount === 0) {
        // Found the closing brace. Now find the "})" after it.
        if (serverContent.substring(i, i + 3) === "});") {
          chatEndIdx = i + 3;
          break;
        }
      }
    }
  }
}

if (chatEndIdx === -1) {
  console.error("ERROR: Could not find end of /chat endpoint");
  process.exit(1);
}

const chatEndpoint = serverContent.substring(chatStartIdx, chatEndIdx);
console.log(`[OK] Found /chat endpoint: ${chatStartIdx} to ${chatEndIdx} (${chatEndIdx - chatStartIdx} chars)`);

// Now find /chat/stream endpoint location.
const streamStartPattern = 'app.post("/chat/stream", async (req, res) => {';
const streamStartIdx = serverContent.indexOf(streamStartPattern);

if (streamStartIdx === -1) {
  console.error("ERROR: Could not find app.post(\"/chat/stream\") stub in server.js");
  process.exit(1);
}

// Find end of /chat/stream stub (until next app.listen or end of file).
const listenPattern = "app.listen(port, () => {";
const listenIdx = serverContent.indexOf(listenPattern);

if (listenIdx === -1) {
  console.error("ERROR: Could not find app.listen in server.js");
  process.exit(1);
}

const streamEndIdx = listenIdx;

console.log(`[OK] Found /chat/stream stub: ${streamStartIdx} to ${streamEndIdx}`);

// Create the streaming endpoint by:
// 1. Clone the entire /chat endpoint
// 2. Rename scope from "chat" to "chat_stream"
// 3. Adapt response output for SSE

let streamEndpoint = chatEndpoint;

// Change scope name from "chat" to "chat_stream" (only first occurrence in childLogger)
streamEndpoint = streamEndpoint.replace(
  'scope: "chat",',
  'scope: "chat_stream",'
);

// Add SSE headers after request validation
const sseHeadersCode = `
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
`;

// Find where to insert SSE headers: after biometric check, before main try block
const tryBlockPattern = "try {";
const firstTryIdx = streamEndpoint.indexOf(tryBlockPattern, 500); // Skip early stuff
if (firstTryIdx === -1) {
  console.error("ERROR: Could not find 'try {' block in cloned endpoint");
  process.exit(1);
}

streamEndpoint = 
  streamEndpoint.substring(0, firstTryIdx) +
  sseHeadersCode +
  streamEndpoint.substring(firstTryIdx);

// Adapt the response output function for SSE.
// Replace sendChatJsonResponse call with SSE version.
streamEndpoint = streamEndpoint.replace(
  /return sendChatJsonResponse\(reply, newMemory, newFlags, debug, responseDebugMeta, botMessageId, turnSignals\);/g,
  `// SSE: Send final response as event stream
  maybeGenerateConversationTitle();
  publishChatProgressTerminal(requestId, "done");

  const finalResponse = {
    conversationId,
    reply,
    memory: newMemory,
    flags: newFlags,
    debug,
    debugMeta: responseDebugMeta,
    botMessageId,
    signals: turnSignals
  };

  res.write(\`data: \${JSON.stringify(finalResponse)}\\n\\n\`);
  return res.end();`
);

// Adapt error responses for SSE
streamEndpoint = streamEndpoint.replace(
  /return res\.status\(400\)\.json\(\{/g,
  `res.setHeader("Content-Type", "text/event-stream");
   const errorPayload = {`
);

// Wrap the constructed new server content
const newServerContent =
  serverContent.substring(0, streamStartIdx) +
  streamEndpoint +
  "\n\n// Start the HTTP server after all routes and middleware are configured.\n" +
  serverContent.substring(streamEndIdx);

fs.writeFileSync(serverPath, newServerContent, "utf8");
console.log(`[OK] Cloned /chat to /chat/stream with SSE adaptation`);
console.log(`[OK] server.js updated successfully`);
