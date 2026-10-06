'use strict';

// Dedicated reversible RTDB probe only; no app boot or business paths.
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
const id = 'probe_' + crypto.randomBytes(16).toString('hex');
const result = {id, contextOk: false, created: false, readOk: false, updateOk: false,
  removed: false, cleanupOk: false, ok: false};
const DATABASE = 'https://facilitat-io-default-rtdb.europe-west1.firebasedatabase.app/';
const marker = {schemaVersion: 1, probeId: id, step: 0};
const ours = value => value?.schemaVersion === 1 && value?.probeId === id &&
  Object.keys(value).length === 3 && [0, 1].includes(value.step);

async function main() {
  let app, db, ref;
  try {
    const {parseAppConfig, resolveServiceAccount} = appRequire('./lib/config');
    const config = parseAppConfig(process.env);
    const credential = resolveServiceAccount(config);
    if (!['srv-d6lh0094tr6s73b71kug', 'srv-d6kuf4ftskes73d0k15g'].includes(process.env.RENDER_SERVICE_ID) ||
        credential.project_id !== 'facilitat-io' ||
        credential.client_email !== 'firebase-adminsdk-fbsvc@facilitat-io.iam.gserviceaccount.com' ||
        new URL(config.firebaseDatabaseUrl).href !== DATABASE || process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
      throw new Error('context_mismatch');
    }
    const admin = appRequire('firebase-admin');
    app = admin.initializeApp({credential: admin.credential.cert(credential), databaseURL: DATABASE}, id);
    db = app.database();
    result.contextOk = true;
    ref = db.ref('_launchGateSdkProbe').child(id);
    const creation = await ref.transaction(value => value === null ? marker : undefined);
    if (!creation.committed) throw new Error('probe_collision');
    result.created = true;
    result.readOk = ours((await ref.once('value')).val());
    if (!result.readOk) throw new Error('read_failed');
    await ref.update({step: 1});
    const next = (await ref.once('value')).val();
    result.updateOk = ours(next) && next.step === 1;
    if (!result.updateOk) throw new Error('update_failed');
  } catch {
    result.ok = false;
  } finally {
    if (ref) {
      try {
        // Remove only our exact generated probe, even after an uncertain response.
        const deletion = await ref.transaction(value => ours(value) ? null : undefined);
        result.removed = deletion.committed || !(await ref.once('value')).exists();
      } catch { result.removed = false; }
    }
    try {
      if (db) db.goOffline();
      if (app) await app.delete();
      result.cleanupOk = true;
    } catch { result.cleanupOk = false; }
    result.ok = result.contextOk && result.created && result.readOk && result.updateOk &&
      result.removed && result.cleanupOk;
    output(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }
}
main().catch(() => { output(JSON.stringify({id, ok: false}) + '\n'); process.exitCode = 1; });
