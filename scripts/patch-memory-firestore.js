/**
 * Patch: detach memory update from critical path
 * - Reads previousMemory from Firebase (convRef) instead of req.body for non-private conversations
 * - Moves updateMemory + finalizeMemoryCandidate to fire-and-forget after res.json()
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'server.js');
let c = fs.readFileSync(serverPath, 'utf8');

// ── STEP 1: launch convMemoryPromise in parallel at top of pipeline ──────────
const anchor1 = 'const shouldLoadUserProfile = !isPrivateConversation';
const idx1 = c.indexOf(anchor1);
if (idx1 === -1) throw new Error('anchor1 not found');

const insert1 = [
  'const convMemoryPromise = (!isPrivateConversation && convRef)',
  '      ? convRef.once("value").then(s => {',
  '          const d = s.val();',
  '          return (d && typeof d.memory === "string" && d.memory.trim()) ? d.memory : null;',
  '        }).catch(() => null)',
  '      : Promise.resolve(null);',
  '    ',
].join('\n    ');

c = c.slice(0, idx1) + insert1 + c.slice(idx1);
console.log('step1 ok');

// ── STEP 2: await convMemoryPromise and override previousMemory (non-private) ─
// Insert just after `previousMemoryForCatch = previousMemory;`
const anchor2 = 'previousMemoryForCatch = previousMemory;';
const idx2 = c.indexOf(anchor2);
if (idx2 === -1) throw new Error('anchor2 not found');

const lineEnd2 = c.indexOf('\r\n', idx2) + 2;
const insert2 = [
  '',
  '    // For non-private conversations, use the memory stored in Firebase (written by the previous turn).',
  '    // Falls back to req.body.memory if Firebase has no memory yet (first turn).',
  '    if (!isPrivateConversation && convMemoryPromise) {',
  '      const convMemoryFromDb = await convMemoryPromise;',
  '      if (convMemoryFromDb) {',
  '        previousMemory = normalizeMemory(convMemoryFromDb, activePromptRegistry);',
  '        previousMemoryForCatch = previousMemory;',
  '      }',
  '    }',
  '    ',
].join('\n');

c = c.slice(0, lineEnd2) + insert2 + c.slice(lineEnd2);
console.log('step2 ok');

// ── STEP 3: make previousMemory a let (currently const via destructuring) ──────
// It's declared inside `const { previousMemory, rawFlags, flags } = normalizeChatMemoryAndFlags(...)`
// We need to extract it as a let instead.
const anchor3 = 'const {\r\n      previousMemory,\r\n      rawFlags,\r\n      flags\r\n    } = normalizeChatMemoryAndFlags(req, activePromptRegistry);';
if (!c.includes(anchor3)) throw new Error('anchor3 not found: ' + JSON.stringify(anchor3.substring(0, 60)));

c = c.replace(
  anchor3,
  'const { rawFlags, flags } = normalizeChatMemoryAndFlags(req, activePromptRegistry);\r\n    let previousMemory = normalizeMemory(req.body?.memory, activePromptRegistry);'
);
console.log('step3 ok');

// ── STEP 4: fire-and-forget the memory update block ───────────────────────────
// Find the memory update block start and end, then wrap in async IIFE after res.json

// Find the res.json call at end of main pipeline
const anchor4 = 'const botMessageId = persistAssistantMessageAsync(reply, debug, responseDebugMeta, { memory: newMemory, flags: newFlags });';
const idx4 = c.indexOf(anchor4);
if (idx4 === -1) throw new Error('anchor4 not found');

// Find the memory update block start (markChatStage("memory_update"))
const anchor4start = 'markChatStage("memory_update");';
// Find the LAST occurrence before idx4 (there could be only one)
const idx4start = c.lastIndexOf(anchor4start, idx4);
if (idx4start === -1) throw new Error('anchor4start not found');

// Find the start of the line containing markChatStage("memory_update")
const lineStart4 = c.lastIndexOf('\n', idx4start) + 1;

// The memory block ends just before buildResponseDebugMeta
const anchor4end = 'const responseDebugMeta = buildResponseDebugMeta({';
const idx4end = c.indexOf(anchor4end, idx4start);
if (idx4end === -1) throw new Error('anchor4end not found');
const lineEnd4 = c.lastIndexOf('\n', idx4end) + 1;

const memoryBlock = c.slice(lineStart4, lineEnd4);
console.log('memory block length:', memoryBlock.length);

// Build the new inline version: synchronous stub + async fire-and-forget
// For non-private: newMemory = previousMemory (client will ignore it, server reads from Firebase next turn)
// For private: we must still compute newMemory synchronously
// Solution: always compute synchronously for private, fire-and-forget for non-private
// BUT that defeats the purpose. Simpler: always fire-and-forget, always return previousMemory in JSON.
// The memory field in the JSON response is only used by private conversations (non-private reads from Firebase).

const newMemoryStub = [
  '    // Memory update runs asynchronously after the response is sent.',
  '    // Non-private conversations: server reads memory from Firebase next turn (convMemoryPromise).',
  '    // Private conversations: client continues to use req.body.memory (no Firebase), so we still',
  '    //   need to compute and return newMemory synchronously for them.',
  '    let newMemory = previousMemory; // default: returned as-is in JSON for non-private',
  '    let memoryWasCompressed = false;',
  '    let memoryBeforeCompression = previousMemory;',
  '    let memoryRewriteIntent = {',
  '      compressionRequested: false,',
  '      interpretationRejectionActive: safeInterpretationRejection.isInterpretationRejection === true,',
  '      rejectsUnderlyingPhenomenon: safeInterpretationRejection.rejectsUnderlyingPhenomenon === true,',
  '      soberReadjustmentActive: postureDecision.needsSoberReadjustment === true,',
  '      lectureBotForcedReset: false',
  '    };',
  '    let memoryAge = 0;',
  '',
  '    // Fire-and-forget memory update for non-private conversations.',
  '    // For private conversations, compute synchronously (no Firebase storage).',
  '    if (isPrivateConversation) {',
  '      // Synchronous path for private conversations (no Firebase, client-authoritative).',
  '      ' + memoryBlock.trim().replace(/\n/g, '\n      '),
  '      newMemory = finalizedMemoryCandidate;',
  '    } else {',
  '      // Async fire-and-forget for non-private: compute and write to Firebase.',
  '      // We capture needed variables in a closure.',
  '      const _prevMem = previousMemory;',
  '      const _reply = reply;',
  '      const _message = message;',
  '      const _history = recentHistory;',
  '      const _registry = activePromptRegistry;',
  '      const _prioritySignal = postureDecision.memoryPrioritySignal || "normal";',
  '      const _isFirstTurn = recentHistory.length === 0;',
  '      const _updateForced = _isFirstTurn || _prioritySignal !== "normal";',
  '      const _shouldRun = currentMemoryUpdateTurnsUntilRefresh === 0 || _updateForced;',
  '      const _interSession = intersessionMemoryForThisTurn;',
  '      const _postureSnap = { conversationState: postureDecision.conversationState, needsSoberReadjustment: postureDecision.needsSoberReadjustment, tensionHoldLevel: postureDecision.tensionHoldLevel };',
  '      const _rejectionSnap = { ...safeInterpretationRejection };',
  '      (async () => {',
  '        try {',
  '          let rawMem;',
  '          if (_shouldRun) {',
  '            rawMem = await updateMemory(_prevMem, [..._history, { role: "user", content: _message }, { role: "assistant", content: _reply }], _registry, _prioritySignal, _interSession);',
  '          } else {',
  '            rawMem = _prevMem;',
  '          }',
  '          const _memBaseState = baseStateOf(_postureSnap.conversationState || "exploration_open");',
  '          if (_memBaseState !== "exploration" && _memBaseState !== "info") {',
  '            rawMem = forceLectureBotReset(rawMem);',
  '          }',
  '          const _needsCompression = shouldCompressMemoryCandidate(rawMem, _prevMem);',
  '          const _finalized = await finalizeMemoryCandidate({',
  '            previousMemory: _prevMem,',
  '            candidateMemory: rawMem,',
  '            interpretationRejection: { ..._rejectionSnap, needsSoberReadjustment: _postureSnap.needsSoberReadjustment, tensionHoldLevel: _postureSnap.tensionHoldLevel },',
  '            needsCompression: _needsCompression,',
  '            promptRegistry: _registry',
  '          });',
  '          // convRef.update is already handled by persistAssistantMessageAsync which runs in bg too.',
  '          // We just need to overwrite the memory field in the conversation document.',
  '          if (convRef) {',
  '            await convRef.update({ memory: normalizeMemory(_finalized, _registry), updatedAt: new Date().toISOString() });',
  '          }',
  '        } catch (e) {',
  '          console.warn("[CHAT][MEMORY_BG_FAILED]", e && e.message);',
  '        }',
  '      })();',
  '    }',
  '',
].join('\n');

c = c.slice(0, lineStart4) + newMemoryStub + c.slice(lineEnd4);
console.log('step4 ok');

// ── STEP 5: fix normalizeChatMemoryAndFlags — it still returns previousMemory, keep it ──
// Already handled by step3 above.

fs.writeFileSync(serverPath, c, 'utf8');
console.log('ALL STEPS DONE');
