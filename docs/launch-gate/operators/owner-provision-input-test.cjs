'use strict';

// New operator-reader tests only. Every input below is synthetic, never a credential.
// Importing the helper does not run main, load an SDK or decode its M1 modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createSecretReader, failureInfo, operatorFailure, validateConfirmation } =
  require('./owner-provision.cjs');
const { isStrongPassword } = require('../../../lib/auth-password');
const SYNTHETIC = 'SyntheticAlpha42!';
const cases = [];

class SimulatedTTY extends PassThrough {
  constructor() { super(); this.isTTY = true; this.isRaw = false; }
  setRawMode(value) { this.isRaw = value; }
}
function fixture() {
  const input = new SimulatedTTY();
  const writes = [];
  const reader = createSecretReader({input, terminal: {isTTY: true}, write: text => writes.push(text)});
  return {input, reader, writes};
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function check(condition) { assert.ok(condition, 'synthetic assertion failed'); }
function clean(f) {
  check(f.reader.close());
  check(f.reader.close());
  check(f.input.isRaw === false);
  for (const event of ['data', 'error', 'end', 'close']) check(f.input.listenerCount(event) === 0);
  check(f.writes.every(value => value === 'first: ' || value === 'confirmation: ' || value === '\n'));
}
async function pair(chunks) {
  const f = fixture();
  const first = f.reader.read('first: ');
  for (const chunk of chunks) f.input.write(chunk);
  const a = await first;
  check(f.input.isRaw === true);
  const b = await f.reader.read('confirmation: ');
  check(a === SYNTHETIC && b === SYNTHETIC);
  validateConfirmation(a, b, isStrongPassword);
  clean(f);
}
async function refused(chunks, reason, event) {
  const f = fixture();
  const pending = f.reader.read('first: ').then(
    () => { throw new Error('unexpected synthetic acceptance'); },
    error => check(failureInfo(error, 'password_entry').reason === reason)
  );
  for (const chunk of chunks) f.input.write(chunk);
  if (event === 'eof') f.input.end();
  if (event === 'close') f.input.emit('close');
  if (event === 'error') f.input.emit('error', new Error('SYNTHETIC_RAW_ERROR_MARKER'));
  await pending;
  clean(f);
}
async function originalReader() {
  const archived = fs.readFileSync(path.join(__dirname, 'owner-tty-before.cjs.txt'), 'utf8');
  const input = new SimulatedTTY();
  const context = {process: {stdin: input, stdout: {isTTY: true}}, Buffer, output: () => {}};
  vm.runInNewContext(archived + '; readLine = secretLine;', context);
  return {input, read: context.readLine};
}
function test(name, run) { cases.push({name, run}); }

test('old_split_crlf_reproduced', async () => {
  const old = await originalReader();
  const first = old.read('first'); old.input.write(SYNTHETIC + '\r'); await first;
  const second = old.read('confirmation'); old.input.write('\n');
  check((await second) === '');
});
test('old_same_chunk_paste_remainder_lost', async () => {
  const old = await originalReader();
  const first = old.read('first'); old.input.write(SYNTHETIC + '\r' + SYNTHETIC + '\r'); await first;
  let settled = false;
  const second = old.read('confirmation').then(value => { settled = true; return value; });
  await turn(); check(!settled);
  old.input.write('\r'); check((await second) === '');
});
test('old_stream_eof_left_pending', async () => {
  const old = await originalReader();
  let settled = false;
  const pending = old.read('first').then(() => { settled = true; }, () => { settled = true; });
  old.input.emit('end'); await turn(); check(!settled);
  old.input.write('\u0003'); await pending;
});
test('bare_cr_pair', () => pair([SYNTHETIC + '\r' + SYNTHETIC + '\r']));
test('bare_lf_pair', () => pair([SYNTHETIC + '\n' + SYNTHETIC + '\n']));
test('same_chunk_crlf_pair', () => pair([SYNTHETIC + '\r\n' + SYNTHETIC + '\r\n']));
test('split_crlf_with_confirmation_open', async () => {
  const f = fixture();
  const first = f.reader.read('first: '); f.input.write(SYNTHETIC + '\r'); check((await first) === SYNTHETIC);
  let settled = false;
  const second = f.reader.read('confirmation: ').then(value => { settled = true; return value; });
  f.input.write('\n'); await turn(); check(!settled); check(f.input.isRaw === true);
  f.input.write(SYNTHETIC + '\r'); check((await second) === SYNTHETIC);
  f.input.write('\n'); clean(f);
});
test('split_crlf_before_confirmation_open', () => pair([SYNTHETIC + '\r', '\n', SYNTHETIC + '\r', '\n']));
test('character_chunk_paste_pair', () => pair(Array.from(SYNTHETIC + '\r\n' + SYNTHETIC + '\r\n')));
test('mixed_terminators_preserve_confirmation', () => pair([SYNTHETIC + '\r', SYNTHETIC + '\n']));
test('del_and_backspace_do_not_echo', () => pair(['Unused\u007f\u007f\u007f\u007f\u007f\u007f' + SYNTHETIC + '\r',
  SYNTHETIC + 'x\b\n']));
test('backspace_empty_is_safe', () => pair(['\b\u007f' + SYNTHETIC + '\r', SYNTHETIC + '\r']));
test('utf8_split_bytes_are_decoded', async () => {
  const f = fixture();
  const vector = 'Synthétique42!';
  const encoded = Buffer.from(vector + '\n' + vector + '\n');
  const first = f.reader.read('first: ');
  for (const byte of encoded) f.input.write(Buffer.from([byte]));
  check((await first) === vector);
  check((await f.reader.read('confirmation: ')) === vector);
  clean(f);
});
test('unicode_backspace_removes_whole_character', () => pair([SYNTHETIC + '😀\b\r', SYNTHETIC + '\r']));
test('control_c_cancellation', () => refused(['PartialSynthetic\u0003'], 'input_cancelled'));
test('control_d_eof', () => refused(['PartialSynthetic\u0004'], 'input_eof'));
test('stream_end_eof', () => refused([], 'input_eof', 'eof'));
test('stream_close_eof', () => refused([], 'input_eof', 'close'));
test('tty_error_is_not_dumped', () => refused([], 'tty_io_failed', 'error'));
test('tab_control_refused', () => refused(['\t'], 'input_control_not_allowed'));
test('escape_bracketed_paste_control_refused', () => refused(['\u001b[200~'], 'input_control_not_allowed'));
test('c0_control_refused', () => refused(['\u0000'], 'input_control_not_allowed'));
test('single_line_limit_refused', () => refused(['A'.repeat(1025)], 'input_too_long'));
test('pending_paste_limit_refused', () => refused(['A'.repeat(4097)], 'input_too_long'));
test('original_single_line_limit_preserved', async () => {
  const f = fixture(); const vector = 'A'.repeat(1024);
  const pending = f.reader.read('first: '); f.input.write(vector + '\r');
  check((await pending) === vector); clean(f);
});
test('non_tty_refused', async () => {
  const f = fixture(); f.input.isTTY = false;
  await f.reader.read('first: ').then(() => { throw new Error('unexpected acceptance'); },
    error => check(failureInfo(error, 'password_entry').reason === 'tty_unavailable'));
  clean(f);
});
test('terminal_restore_failure_stays_false', async () => {
  const f = fixture();
  const pending = f.reader.read('first: '); f.input.write(SYNTHETIC + '\r'); await pending;
  f.input.setRawMode = () => { throw new Error('SYNTHETIC_RESTORE_MARKER'); };
  check(!f.reader.close()); check(!f.reader.close());
});
test('mismatch_reason_is_specific', async () => {
  try { validateConfirmation(SYNTHETIC, 'DifferentSynthetic42!', isStrongPassword); throw new Error('accepted'); }
  catch (error) { check(failureInfo(error, 'confirmation').reason === 'entries_differ'); }
});
test('force_policy_unchanged', async () => {
  for (const vector of ['weak', 'LettersOnly', '1234567890123', 'Short1']) {
    try { validateConfirmation(vector, vector, isStrongPassword); throw new Error('accepted'); }
    catch (error) { check(failureInfo(error, 'confirmation').reason === 'password_policy'); }
  }
  validateConfirmation(SYNTHETIC, SYNTHETIC, isStrongPassword);
});
test('raw_error_message_and_code_ignored', async () => {
  const error = new Error('SYNTHETIC_PRIVATE_MARKER'); error.code = 'input_too_long';
  const safe = failureInfo(error, 'creation');
  check(safe.reason === 'creation_operation_failed' && safe.phase === 'creation');
  check(!JSON.stringify(safe).includes('SYNTHETIC_PRIVATE_MARKER'));
});
test('untrusted_properties_are_not_read', async () => {
  const error = Object.defineProperty({}, 'message', {get() { throw new Error('not allowed'); }});
  check(failureInfo(error, 'preflight').reason === 'preflight_failed');
});
test('unknown_reason_and_phase_are_sanitized', async () => {
  const safe = failureInfo(operatorFailure('SYNTHETIC_PRIVATE_MARKER'), 'SYNTHETIC_PRIVATE_PHASE');
  check(safe.reason === 'operation_failed' && safe.phase === 'unknown');
  check(!JSON.stringify(safe).includes('SYNTHETIC_PRIVATE'));
});

(async () => {
  const passed = [];
  for (const item of cases) {
    try { await item.run(); passed.push(item.name); }
    catch { console.error(JSON.stringify({test: item.name, passed: false})); process.exitCode = 1; return; }
  }
  console.log(JSON.stringify({suite: 'owner_provision_tty_and_failure_codes', passed: passed.length,
    cases: passed, sdkLoaded: false, realNetwork: false, actualCredential: false}));
})().catch(() => { console.error(JSON.stringify({passed: false})); process.exitCode = 1; });
