// validator.js — pure validation + referential-integrity functions.
//
// PocketBase access rules are left open ("") during dev, so the client is the
// only thing enforcing data integrity. Everything here is a pure function of
// its inputs (no DOM, no fetch, no state) so it can be reasoned about and unit
// tested in isolation, and reused by both per-form validation and the
// whole-model check that gates persistence.

import { AREAS, SUBCATS, CYCLES, NW_FIELDS } from './config.js';

const ok = (value) => ({ ok: true, error: '', value });
const err = (error) => ({ ok: false, error, value: undefined });

// --- small shared predicates -------------------------------------------------
export const isNonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;
export const isAreaKey = (k) => Object.prototype.hasOwnProperty.call(AREAS, k);
export const isSubCat = (k) => Object.prototype.hasOwnProperty.call(SUBCATS, k);
export const isCycle = (k) => Object.prototype.hasOwnProperty.call(CYCLES, k);

// Strip currency symbols / commas / spaces and parse to a finite number.
export function parseMoney(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const cleaned = String(raw ?? '').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Sum the seven balances of a snapshot-like object (missing → 0).
export function sumBalances(obj) {
  return NW_FIELDS.reduce((t, f) => t + (Number(obj?.[f.k]) || 0), 0);
}

// --- per-form validators ------------------------------------------------------
// Each returns { ok, error, value } where value is a normalized draft.

export function validateTask(draft) {
  const title = String(draft?.title ?? '').trim();
  if (!title) return err('Add a task title to continue.');
  const category = isAreaKey(draft?.category) ? draft.category : 'general';
  return ok({ title, category, done: Boolean(draft?.done) });
}

export function validateSubscription(draft) {
  const name = String(draft?.name ?? '').trim();
  if (!name) return err('Add a name and a cost to continue.');
  const cost = parseMoney(draft?.cost);
  if (!(cost > 0)) return err('Add a name and a cost to continue.');
  const cycle = isCycle(draft?.cycle) ? draft.cycle : 'monthly';
  const category = isSubCat(draft?.category) ? draft.category : 'utilities';
  return ok({
    name, cost, cycle, category,
    next: typeof draft?.next === 'string' && draft.next ? draft.next : '—',
    method: typeof draft?.method === 'string' ? draft.method : '',
    active: draft?.active === undefined ? true : Boolean(draft.active),
  });
}

export function validateSnapshot(draft) {
  const balances = {};
  for (const f of NW_FIELDS) balances[f.k] = Math.max(0, Number(draft?.[f.k]) || 0);
  if (sumBalances(balances) <= 0) return err('Add at least one balance to continue.');
  return ok(balances);
}

export function validateGoal(raw) {
  const v = parseMoney(raw);
  if (!(v > 0)) return err('Enter a goal amount greater than zero.');
  return ok(v);
}

// --- whole-model integrity check ---------------------------------------------
// Gate run before any persistence flush. Catches anything that would violate
// PocketBase constraints (duplicate keys, unique index) or domain invariants
// (unknown category/cycle references, negative money). Returns a flat list of
// human-readable problems; empty list === valid.
export function validateModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return { ok: false, errors: ['Model is missing.'] };

  const checkUniqueKeys = (rows, label) => {
    const seen = new Set();
    for (const r of rows || []) {
      if (!isNonEmpty(r?.key)) { errors.push(`${label}: a record is missing a key.`); continue; }
      if (seen.has(r.key)) errors.push(`${label}: duplicate key "${r.key}".`);
      seen.add(r.key);
    }
  };

  // tasks
  checkUniqueKeys(model.tasks, 'Tasks');
  for (const t of model.tasks || []) {
    if (!isNonEmpty(t.title)) errors.push(`Tasks: "${t.key}" has an empty title.`);
    if (!isAreaKey(t.category)) errors.push(`Tasks: "${t.key}" references unknown area "${t.category}".`);
  }

  // subscriptions
  checkUniqueKeys(model.subscriptions, 'Subscriptions');
  for (const s of model.subscriptions || []) {
    if (!isNonEmpty(s.name)) errors.push(`Subscriptions: "${s.key}" has an empty name.`);
    if (!(Number(s.cost) > 0)) errors.push(`Subscriptions: "${s.key}" cost must be greater than zero.`);
    if (!isCycle(s.cycle)) errors.push(`Subscriptions: "${s.key}" has unknown cycle "${s.cycle}".`);
    if (!isSubCat(s.category)) errors.push(`Subscriptions: "${s.key}" references unknown category "${s.category}".`);
  }

  // snapshots
  checkUniqueKeys(model.snapshots, 'Snapshots');
  for (const n of model.snapshots || []) {
    for (const f of NW_FIELDS) {
      if (Number(n[f.k]) < 0) errors.push(`Snapshots: "${n.key}" has a negative ${f.label}.`);
    }
    if (sumBalances(n) <= 0) errors.push(`Snapshots: "${n.key}" has no positive balance.`);
  }

  // settings
  if (!model.settings || !(Number(model.settings.goal) > 0)) {
    errors.push('Settings: freedom goal must be greater than zero.');
  }

  return { ok: errors.length === 0, errors };
}
