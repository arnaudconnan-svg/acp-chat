'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const realRequire = createRequire(path.join(root, 'server.js'));
const copy = (x) => (x == null ? null : structuredClone(x));
function databaseDouble(seed = {}) {
  const data = copy(seed),
    operations = [];
  const transactionPlans = [], readFailures = [];
  let sequence = 0;
  function ref(location = '', query = {}) {
    const parts = location.split('/').filter(Boolean);
    function read() {
      let value = data;
      for (const p of parts) value = value?.[p];
      if (query.order && value && typeof value === 'object')
        value = Object.fromEntries(
          Object.entries(value).filter(
            ([, row]) =>
              query.equal === undefined || row?.[query.order] === query.equal
          )
        );
      return copy(value);
    }
    function assign(value) {
      if (!parts.length) {
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, copy(value) || {});
        return;
      }
      let node = data;
      for (const p of parts.slice(0, -1)) node = node[p] ||= {};
      if (value === null) delete node[parts.at(-1)];
      else node[parts.at(-1)] = copy(value);
    }
    const r = {
      key: parts.at(-1),
      child: (key) => ref(`${location}/${key}`),
      orderByChild: (order) => ref(location, { ...query, order }),
      equalTo: (equal) => ref(location, { ...query, equal }),
      limitToLast: () => r,
      limitToFirst: () => r,
      async once() {
        operations.push({ action: 'read', path: location });
        const fail = readFailures.find((item) => item.path === location);
        if (fail && --fail.after === 0) {
          readFailures.splice(readFailures.indexOf(fail), 1);
          throw new Error('synthetic_read_rejected');
        }
        const v = read();
        return {
          val: () => copy(v),
          exists: () => v != null,
          forEach(fn) {
            for (const [key, value] of Object.entries(v || {}))
              fn({ key, ref: r.child(key), val: () => copy(value) });
          }
        };
      },
      async set(value) {
        operations.push({ action: 'set', path: location });
        assign(value);
      },
      async update(patch) {
        operations.push({ action: 'update', path: location });
        for (const [key, value] of Object.entries(patch))
          await r.child(key).set(value);
      },
      async remove() {
        operations.push({ action: 'remove', path: location });
        assign(null);
      },
      async transaction(fn) {
        const planIndex = transactionPlans.findIndex((item) => item.path === location);
        const plan = planIndex < 0 ? {} : transactionPlans.splice(planIndex, 1)[0];
        if (plan.initialNull) {
          const initial = fn(null);
          // Firebase aborts on undefined, even with an initially empty cache.
          if (initial === undefined) return { committed: false, snapshot: { val: read } };
        }
        let value = fn(read());
        if (plan.conflict) {
          plan.conflict(data);
          value = fn(read());
        }
        if (value === undefined)
          return { committed: false, snapshot: { val: read } };
        // One synchronous compare-and-commit: no partial root visibility.
        operations.push({ action: 'transaction', path: location });
        assign(value);
        const committed = read();
        if (plan.ackLost) throw new Error('synthetic_ack_lost');
        return { committed: true, snapshot: { val: () => copy(committed) } };
      },
      push(value) {
        const c = r.child(`synthetic_${++sequence}`);
        if (value !== undefined) c.set(value);
        return c;
      },
      on() {
        throw new Error('synthetic_listener_refused');
      },
      off() {}
    };
    return r;
  }
  return { ref, data, operations, transactionPlans, readFailures };
}
function loadApplication({ seed = {}, overrides = {}, env = {} } = {}) {
  const db = databaseDouble(seed),
    logs = [],
    blocked = [];
  const realExpress = realRequire('express');
  const app = realExpress();
  app.listen = () => {
    blocked.push('listen');
    return { close() {} };
  };
  const express = Object.assign(() => app, realExpress);
  const logger = {};
  for (const level of [
    'info',
    'warn',
    'error',
    'debug',
    'trace',
    'fatal',
    'log'
  ])
    logger[level] = (...args) => logs.push({ level, args });
  logger.child = () => logger;
  const syntheticEnv = {
    NODE_ENV: 'test',
    MISTRAL_API_KEY: 'synthetic-unused',
    FIREBASE_DATABASE_URL: 'https://synthetic.example.test',
    FIREBASE_SERVICE_ACCOUNT: '{}',
    LOG_PERSIST: 'false',
    REFRESH_EMERGENCY_ON_BOOT: 'false',
    SESSION_SECRET: 'synthetic-session-key-012345678901234567890',
    USER_SESSION_SECRET: 'synthetic-user-key-012345678901234567890',
    ADMIN_SESSION_SECRET: 'synthetic-professional-key-0123456789012345',
    ...env
  };
  const deps = {
    express,
    dotenv: { config() {} },
    'firebase-admin': {
      initializeApp() {
        blocked.push('firebase_double');
      },
      credential: { cert: () => ({}) },
      database: () => db
    },
    nodemailer: {
      createTransport: () => ({
        async sendMail() {
          throw new Error('synthetic_mail_refused');
        }
      })
    },
    './lib/logger': { childLogger: () => logger, logger },
    './lib/emergency-updater': {
      updateEmergencyNumbers() {
        throw new Error('synthetic_updater_refused');
      }
    },
    './lib/mistral-transport': {
      createMistralTransport: () => ({
        async complete() {
          throw new Error('synthetic_llm_missing_fixture');
        },
        async stream() {
          throw new Error('synthetic_llm_missing_fixture');
        }
      })
    },
    fs: {
      ...fs,
      readFileSync(file, ...args) {
        if (String(file).startsWith(path.join(root, 'data'))) return '{}';
        if (/(?:\.env|serviceAccount\.json)$/.test(String(file)))
          throw new Error('synthetic_secret_read_refused');
        return fs.readFileSync(file, ...args);
      }
    },
    ...overrides
  };
  const context = vm.createContext({
    require: (name) =>
      Object.hasOwn(deps, name) ? deps[name] : realRequire(name),
    __dirname: root,
    __filename: path.join(root, 'server.js'),
    module: { exports: {} },
    exports: {},
    process: {
      env: syntheticEnv,
      cwd: () => root,
      stdout: { isTTY: false },
      on() {}
    },
    Buffer,
    URL,
    structuredClone,
    console: logger,
    setInterval() {
      blocked.push('interval');
      return 0;
    },
    clearInterval() {},
    setTimeout(fn, ms) {
      return setTimeout(fn, Math.min(ms || 0, 5));
    },
    clearTimeout,
    queueMicrotask
  });
  vm.runInContext(
    fs.readFileSync(path.join(root, 'server.js'), 'utf8'),
    context,
    { filename: 'synthetic-server.js' }
  );
  async function request(
    method,
    url,
    { body = {}, cookie = '', headers = {}, query = {}, onWire = null } = {}
  ) {
    const { IncomingMessage, ServerResponse } = require('http');
    const { Duplex } = require('stream');
    let wire = '';
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, done) {
        wire += chunk.toString();
        onWire?.(chunk.toString());
        done();
      }
    });
    socket.remoteAddress = '127.0.0.1';
    const req = new IncomingMessage(socket);
    const suffix = new URLSearchParams(query).toString();
    req.url = url + (suffix ? (url.includes('?') ? '&' : '?') + suffix : '');
    req.method = method.toUpperCase();
    const payload = JSON.stringify(body);
    req.headers = {
      host: 'synthetic.example.test',
      cookie,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...headers
    };
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    let captured;
    const json = realExpress.response.json;
    res.json = function (value) {
      captured = copy(value);
      return json.call(this, value);
    };
    const finished = new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
    });
    req.push(payload);
    req.push(null);
    req.complete = true;
    app.handle(req, res, (error) => {
      res.statusCode = error?.status || (error ? 500 : 404);
      res.end();
    });
    await finished;
    return {
      statusCode: res.statusCode,
      headers: res.getHeaders(),
      body: captured,
      wire
    };
  }
  return {
    app,
    db,
    request,
    logs,
    blocked,
    context,
    evaluate: (code) => vm.runInContext(code, context)
  };
}
module.exports = { databaseDouble, loadApplication };
