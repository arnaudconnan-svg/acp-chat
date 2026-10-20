'use strict';
// Run with env -i and the M0 guard. Only transport selection is substituted:
// application routes, normalization, reset queue, Nodemailer and MIME are real.
const assert = require('assert/strict');
const path = require('path');
assert(
  require.cache[path.join(__dirname, 'guard.cjs')],
  'M0 guard must be preloaded before this harness'
);
const nodemailer = require('nodemailer');
const version = require('nodemailer/package.json').version;
const { loadApplication } = require('./runtime.cjs');
const { createResetEmailSender } = require('../../lib/password-reset');
const { domainToASCII } = require('url');
const userId = 'u_0123456789abcdef01234567';
const tick = () => new Promise((resolve) => setImmediate(resolve));
let complete = false;
process.on('beforeExit', () => {
  if (!complete) process.exitCode = 1;
});
function fixture({ email = 'person@example.test', fail = false } = {}) {
  const messages = [],
    options = [],
    attempts = [];
  const app = loadApplication({
    seed: {
      users: {
        [userId]: { email, authVersion: 0, passwordHash: 'SYNTHETIC_HASH' }
      },
      conversations: {
        c_mail: {
          userId,
          messages: { private: { content: 'TRANSCRIPT_MUST_NOT_LEAK' } }
        }
      }
    },
    env: {
      NOTIFY_SMTP_HOST: 'smtp.example.test',
      NOTIFY_SMTP_PORT: '465',
      NOTIFY_SMTP_SECURE: 'true',
      NOTIFY_SMTP_USER: 'synthetic-user',
      NOTIFY_SMTP_PASSWORD: 'synthetic-password',
      NOTIFY_EMAIL_FROM: 'Facilitat <sender@example.test>',
      NOTIFY_EMAIL_TO: 'notify@example.test',
      HUMAN_RELAY_EMAIL_TO: 'Équipe <relay@équipe.test>',
      SECURITY_ALERT_EMAIL_TO: 'vigilance@example.test',
      PUBLIC_APP_URL: 'https://synthetic.example.test'
    },
    overrides: {
      nodemailer: {
        createTransport(config) {
          options.push(structuredClone(config));
          // Also construct the genuine SMTP transport to qualify these options,
          // but never invoke its send/verify/connect methods.
          const smtp = nodemailer.createTransport(config);
          assert.equal(smtp.transporter.name, 'SMTP');
          assert.equal(smtp.options.host, 'smtp.example.test');
          assert.equal(smtp.options.auth.user, 'synthetic-user');
          smtp.close();
          const transport = nodemailer.createTransport({
            streamTransport: true,
            buffer: true,
            newline: 'unix'
          });
          const deliver = transport.transporter.send.bind(
            transport.transporter
          );
          transport.transporter.send = (mail, callback) => {
            // Capture real MIME, then report success/error through Nodemailer's
            // transport callback and genuine sendMail Promise rejection path.
            deliver(mail, (error, info) => {
              if (error) return callback(error);
              messages.push({
                envelope: info.envelope,
                wire: info.message.toString('utf8')
              });
              callback(
                fail ? new Error('synthetic_transport_failure') : null,
                info
              );
            });
          };
          const send = transport.sendMail.bind(transport);
          transport.sendMail = async (data) => {
            assert.deepEqual(Object.keys(data).sort(), [
              'from',
              'subject',
              'text',
              'to'
            ]);
            attempts.push(structuredClone(data));
            return send(data);
          };
          return transport;
        }
      }
    }
  });
  const cookie =
    'userSessionId=' + app.evaluate(`buildUserSessionToken('${userId}',0)`);
  return { app, cookie, messages, options, attempts };
}
async function drain(app) {
  for (let n = 0; n < 200; n++) {
    const stats = app.evaluate('passwordResetService.queueStats()');
    if (stats.active === 0 && stats.pending === 0) return;
    await tick();
  }
  assert.fail('reset queue did not finish');
}
function body(wire) {
  const content = wire
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n\n');
  if (/Content-Transfer-Encoding: base64/i.test(wire))
    return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (/Content-Transfer-Encoding: quoted-printable/i.test(wire)) {
    const text = content.replace(/=\r?\n/g, '');
    return Buffer.from(
      text.replace(/=([A-F0-9]{2})/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      ),
      'binary'
    ).toString('utf8');
  }
  return content;
}
async function main() {
  assert.throws(
    () => require('net').connect(465, 'smtp.example.test'),
    /prohibited side effect/
  );
  assert.throws(
    () => require('https').get('https://synthetic.example.test'),
    /prohibited side effect/
  );
  assert.throws(() => require('firebase-admin'), /prohibited side effect/);
  const relay = fixture();
  for (const [requestType, isPrivateConversation] of [
    ['service_contact', false],
    ['human_support', true]
  ]) {
    const result = await relay.app.request(
      'POST',
      '/api/human-support/request',
      {
        cookie: relay.cookie,
        body: {
          consent: true,
          requestType,
          conversationId: 'c_mail',
          isPrivateConversation
        }
      }
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    const mail = relay.messages.at(-1),
      text = body(mail.wire);
    assert.deepEqual(mail.envelope.to, [
      'relay@' + domainToASCII('équipe.test')
    ]);
    assert.match(
      text,
      new RegExp('Type de demande \\(requestType\\) : ' + requestType)
    );
    assert.match(text, /person@example.test/);
    assert(!text.includes('TRANSCRIPT_MUST_NOT_LEAK'));
    assert.equal(text.includes('c_mail'), !isPrivateConversation);
    assert.match(mail.wire, /Content-Type: text\/plain; charset=utf-8/i);
    assert.match(mail.wire, /Subject:/);
  }
  const denied = await relay.app.request('POST', '/api/human-support/request', {
    cookie: relay.cookie,
    body: { consent: false, requestType: 'human_support' }
  });
  assert.equal(denied.statusCode, 400);
  assert.equal(relay.messages.length, 2);
  console.log(
    'PASS real human relay routes: both types, consent, private minimization, IDN recipient, MIME text'
  );

  const rejected = fixture({ fail: true });
  for (let n = 0; n < 2; n++) {
    const result = await rejected.app.request(
      'POST',
      '/api/human-support/request',
      {
        cookie: rejected.cookie,
        body: {
          consent: true,
          requestType: 'human_support',
          isPrivateConversation: true
        }
      }
    );
    assert.equal(
      result.statusCode,
      502,
      'failed delivery releases rate limit for retry'
    );
  }
  assert.equal(rejected.messages.length, 2);
  console.log('PASS real human relay route: transport rejection and retry');

  for (const email of [
    'person@example.test',
    'alice@équipe.test',
    'élise@équipe.test',
    'élise@xn--quipe-9ra.test'
  ]) {
    for (const fail of [false, true]) {
      const reset = fixture({ email, fail });
      const response = await reset.app.request(
        'POST',
        '/api/auth/forgot-password',
        { body: { email: '  ' + email.toUpperCase() + '  ' } }
      );
      assert.equal(response.statusCode, 202);
      await drain(reset.app);
      assert.equal(reset.messages.length, 1);
      assert.deepEqual(reset.attempts[0].to, { address: email });
      const [local, domain] = email.split('@');
      // 10.1.0 intentionally preserves a U-label domain when the local part
      // already requires SMTPUTF8. Assert exact output AND destination identity.
      const unicodeLocal = /[^\x00-\x7f]/.test(local);
      const expectedDomain =
        Number(version.split('.')[0]) >= 10 && unicodeLocal
          ? require('url').domainToUnicode(domain)
          : domainToASCII(domain);
      assert.deepEqual(reset.messages[0].envelope.to, [
        local + '@' + expectedDomain
      ]);
      const [actualLocal, actualDomain] =
        reset.messages[0].envelope.to[0].split('@');
      assert.equal(actualLocal, local);
      assert.equal(domainToASCII(actualDomain), domainToASCII(domain));
      assert.match(
        body(reset.messages[0].wire),
        /https:\/\/synthetic\.example\.test\/auth\.html#reset=u_0123456789abcdef01234567\.[A-Za-z0-9_-]{43}/
      );
      assert.equal(
        reset.app.logs.some((log) =>
          JSON.stringify(log).includes('password_reset_email_failed')
        ),
        fail
      );
      assert.equal(
        reset.app.logs.some((log) =>
          JSON.stringify(log).includes('password_reset_job_failed')
        ),
        fail
      );
      assert(reset.app.db.data.users[userId].passwordReset.secretHash);
      assert(!JSON.stringify(reset.app.db.data).includes('#reset='));
      for (const [key, value] of Object.entries({
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
      }))
        assert.equal(reset.options[0][key], value);
    }
  }
  console.log(
    'PASS real reset routes/queue/sender: normalized address object, ASCII/Unicode/IDN, success/error, hashed secret'
  );
  const unknown = fixture();
  await unknown.app.request('POST', '/api/auth/forgot-password', {
    body: { email: 'unknown@example.test' }
  });
  await drain(unknown.app);
  assert.equal(unknown.messages.length, 0);
  const oversized = await unknown.app.request(
    'POST',
    '/api/auth/forgot-password',
    { body: { email: 'a'.repeat(103000) + '@example.test' } }
  );
  assert.equal(oversized.statusCode, 413);
  console.log(
    'PASS existing reset bounds: unknown account sends nothing, Express body limit retained'
  );

  const direct = nodemailer.createTransport({
    streamTransport: true,
    buffer: true
  });
  const logs = [];
  const sender = createResetEmailSender({
    transporter: direct,
    fromAddress: 'sender@example.test',
    logger: { error: (value) => logs.push(value) }
  });
  assert.equal(
    await sender({
      to: 'person@example.test',
      link: 'https://synthetic.example.test/auth.html#reset=SYNTHETIC'
    }),
    true
  );
  assert.equal(logs.length, 0);
  const vigilance = fixture();
  assert.equal(
    await vigilance.app.evaluate(
      "offTopicAbuseEmailNotifier.sendOffTopicAbuseAlert({userId:'synthetic-user',conversationId:'c_mail',requestId:'synthetic-request',windowCount:1,threshold:1,cooldownHours:1})"
    ),
    true
  );
  assert.deepEqual(vigilance.messages[0].envelope.to, [
    'vigilance@example.test'
  ]);
  console.log(
    'PASS shared dependency: reset simple string and genuine vigilance notifier'
  );
  complete = true;
  console.log(
    `PASS Nodemailer ${version}: guarded real dependency compatibility`
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
