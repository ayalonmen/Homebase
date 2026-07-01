// setup.js — one-time, idempotent PocketBase provisioner.
//
// Run once (after `pocketbase serve` is up):  node setup.js
//
// What it does, in order:
//   1. Ensures a superuser exists via `pocketbase superuser upsert` (idempotent).
//   2. Waits for the REST API, then authenticates as that superuser.
//   3. For every collection: DROP if present, then CREATE fresh (idempotent
//      "drop + recreate" — PocketBase is the source of truth, this file defines
//      it from scratch each run).
//   4. Seeds initial data from the single SEED constant in config.js, using the
//      exact same toRecord() mapper the client uses (so seeds round-trip).
//
// Admin creds come from env (PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD) with a dev
// fallback. Collection access rules are left OPEN ("") for dev.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { API_BASE, COLLECTIONS, SETTINGS_KEY, SEED } from './public/config.js';
import { toRecord } from './public/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || 'admin@homebase.dev';
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || 'devpassword1234';
// Absolute path to the binary — spawnSync resolves bare names via PATH (not cwd)
// on Windows, so an explicit path is required.
const PB_BIN = join(__dirname, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase');

// --- tiny coloured logger ----------------------------------------------------
const log = {
  step: (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`),
  ok: (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m!\x1b[0m ${m}`),
  err: (m) => console.error(`\x1b[31m✗\x1b[0m ${m}`),
};

// --- field-definition helpers (PocketBase v0.23+ flat field schema) ----------
const text = (name, required = false) => ({ name, type: 'text', required });
const bool = (name) => ({ name, type: 'bool' });
const number = (name) => ({ name, type: 'number' });
const json = (name) => ({ name, type: 'json' });
const created = () => ({ name: 'created', type: 'autodate', onCreate: true, onUpdate: false });
const updated = () => ({ name: 'updated', type: 'autodate', onCreate: true, onUpdate: true });
const uniq = (coll, col) => `CREATE UNIQUE INDEX \`idx_${coll}_${col}\` ON \`${coll}\` (\`${col}\`)`;
const idx = (coll, col) => `CREATE INDEX \`idx_${coll}_${col}\` ON \`${coll}\` (\`${col}\`)`;

// The physical schema for each collection: flat columns for the queryable
// fields + one `body` JSON column for nested/freeform data.
const SCHEMA = [
  {
    name: COLLECTIONS.tasks,
    fields: [text('key', true), text('title', true), text('category'), bool('done'), json('body'), created(), updated()],
    indexes: [uniq(COLLECTIONS.tasks, 'key'), idx(COLLECTIONS.tasks, 'category')],
  },
  {
    name: COLLECTIONS.subscriptions,
    fields: [text('key', true), text('name', true), number('cost'), text('cycle'), text('category'), bool('active'), json('body'), created(), updated()],
    indexes: [uniq(COLLECTIONS.subscriptions, 'key'), idx(COLLECTIONS.subscriptions, 'category')],
  },
  {
    name: COLLECTIONS.snapshots,
    fields: [text('key', true), text('date'), text('isoDate'), json('body'), created(), updated()],
    indexes: [uniq(COLLECTIONS.snapshots, 'key'), idx(COLLECTIONS.snapshots, 'isoDate')],
  },
  {
    name: COLLECTIONS.settings,
    fields: [text('key', true), json('body'), created(), updated()],
    indexes: [uniq(COLLECTIONS.settings, 'key')],
  },
];

// --- authed REST helper ------------------------------------------------------
let TOKEN = '';
async function pb(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: TOKEN } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Cannot reach the API at ${API_BASE} (${method} ${path}). Is PocketBase running? [${e.message || e}]`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${data?.message || text}`);
  }
  return data;
}

// --- 1. superuser bootstrap --------------------------------------------------
function ensureSuperuser() {
  log.step(`Ensuring superuser ${ADMIN_EMAIL} (pocketbase superuser upsert)`);
  const r = spawnSync(PB_BIN, ['superuser', 'upsert', ADMIN_EMAIL, ADMIN_PASSWORD], {
    cwd: __dirname, encoding: 'utf8',
  });
  if (r.status !== 0) {
    log.warn(`superuser upsert exited ${r.status}: ${(r.error?.message || r.stderr || r.stdout || '').trim()}`);
    log.warn('Continuing — will try to authenticate anyway.');
  } else {
    log.ok('Superuser ready.');
  }
}

// --- 2. wait for API + auth --------------------------------------------------
async function waitForApi(timeoutMs = 20000) {
  log.step(`Waiting for PocketBase at ${API_BASE} …`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(API_BASE + '/health');
      if (res.ok) { log.ok('API is up.'); return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`PocketBase did not respond at ${API_BASE}. Start it with: ${PB_BIN} serve --http=127.0.0.1:8090`);
}

async function authenticate() {
  log.step('Authenticating as superuser …');
  const data = await pb('/collections/_superusers/auth-with-password', {
    method: 'POST', body: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  TOKEN = data.token;
  log.ok('Authenticated.');
}

// --- 3. drop + recreate collections -----------------------------------------
async function rebuildCollections() {
  const existing = (await pb('/collections?perPage=200')).items;
  const ours = new Set(SCHEMA.map((s) => s.name));

  // Drop ours if present (reverse-safe: no relations between them).
  for (const c of existing) {
    if (ours.has(c.name)) {
      await pb(`/collections/${c.id}`, { method: 'DELETE' });
      log.ok(`Dropped existing "${c.name}".`);
    }
  }

  // Create fresh.
  for (const def of SCHEMA) {
    await pb('/collections', {
      method: 'POST',
      body: {
        name: def.name,
        type: 'base',
        fields: def.fields,
        indexes: def.indexes,
        listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '',
      },
    });
    log.ok(`Created "${def.name}" (${def.fields.length} fields, ${def.indexes.length} indexes).`);
  }
}

// --- 4. seed -----------------------------------------------------------------
async function seed() {
  log.step('Seeding initial data …');

  // Settings (single record).
  await pb(`/collections/${COLLECTIONS.settings}/records`, {
    method: 'POST', body: toRecord(COLLECTIONS.settings, SEED.settings),
  });

  // Tasks & subscriptions are sorted newest-first at read time (created desc),
  // so insert reversed → SEED[0] is written last → lands on top.
  for (const t of [...SEED.tasks].reverse()) {
    await pb(`/collections/${COLLECTIONS.tasks}/records`, { method: 'POST', body: toRecord(COLLECTIONS.tasks, t) });
  }
  for (const s of [...SEED.subscriptions].reverse()) {
    await pb(`/collections/${COLLECTIONS.subscriptions}/records`, { method: 'POST', body: toRecord(COLLECTIONS.subscriptions, s) });
  }
  // Snapshots are ordered by isoDate, so insertion order is irrelevant.
  for (const n of SEED.snapshots) {
    await pb(`/collections/${COLLECTIONS.snapshots}/records`, { method: 'POST', body: toRecord(COLLECTIONS.snapshots, n) });
  }

  log.ok(`Seeded ${SEED.tasks.length} tasks, ${SEED.subscriptions.length} subscriptions, ${SEED.snapshots.length} snapshots, 1 settings record.`);
}

// --- main --------------------------------------------------------------------
(async () => {
  try {
    console.log('\n\x1b[1mLife Management Dashboard — PocketBase provisioner\x1b[0m\n');
    ensureSuperuser();
    await waitForApi();
    await authenticate();
    await rebuildCollections();
    await seed();
    log.ok('\x1b[1mProvisioning complete.\x1b[0m');
    console.log(`\nNext: serve the frontend →  npx serve -l 3000 public\n`);
  } catch (e) {
    log.err(e.message || String(e));
    process.exitCode = 1;
  }
})();
