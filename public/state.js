// state.js — the single in-memory model + id maps + read/write mappers + undo.
//
// There is exactly ONE model object; the DOM is a pure function of it (render.js)
// and every change flows through here. This module also owns:
//   • idByKey      — key → PocketBase record id, so PATCH/DELETE can find a row
//   • toModel      — PocketBase records → logical model (the read mapping)
//   • toRecord     — logical row → PocketBase record payload (the write mapping)
//   • lastPersisted — snapshot of what the server is believed to hold (diff base)
//   • undo/redo    — snapshot stacks
//
// It is DOM-free and fetch-free on purpose: toRecord/fromRecord are imported by
// the Node provisioner (setup.js) too, so seed data and client writes use ONE
// mapping and can never drift.

import { COLLECTIONS, SETTINGS_KEY, NW_FIELDS, DEFAULTS } from './config.js';

const clone = (x) => structuredClone(x);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---------------------------------------------------------------------------
// Logical row  →  PocketBase record payload  (hybrid: flat cols + body JSON)
// ---------------------------------------------------------------------------
export function toRecord(collection, m) {
  switch (collection) {
    case COLLECTIONS.tasks:
      return { key: m.key, title: m.title, category: m.category, done: !!m.done, body: {} };
    case COLLECTIONS.subscriptions:
      return {
        key: m.key, name: m.name, cost: num(m.cost), cycle: m.cycle,
        category: m.category, active: !!m.active,
        body: { next: m.next ?? '—', method: m.method ?? '' },
      };
    case COLLECTIONS.snapshots:
      return {
        key: m.key, date: m.date, isoDate: m.isoDate,
        body: NW_FIELDS.reduce((b, f) => (b[f.k] = num(m[f.k]), b), {}),
      };
    case COLLECTIONS.settings:
      return { key: SETTINGS_KEY, body: { name: m.name, goal: num(m.goal) } };
    default:
      throw new Error(`toRecord: unknown collection "${collection}"`);
  }
}

// ---------------------------------------------------------------------------
// PocketBase record  →  logical row  (the inverse)
// ---------------------------------------------------------------------------
export function fromRecord(collection, r) {
  const body = r.body || {};
  switch (collection) {
    case COLLECTIONS.tasks:
      return { key: r.key, title: r.title, category: r.category, done: !!r.done };
    case COLLECTIONS.subscriptions:
      return {
        key: r.key, name: r.name, cost: num(r.cost), cycle: r.cycle,
        category: r.category, active: !!r.active,
        next: body.next ?? '—', method: body.method ?? '',
      };
    case COLLECTIONS.snapshots:
      return {
        key: r.key, date: r.date, isoDate: r.isoDate,
        ...NW_FIELDS.reduce((o, f) => (o[f.k] = num(body[f.k]), o), {}),
      };
    case COLLECTIONS.settings:
      return { name: body.name ?? DEFAULTS.name, goal: num(body.goal) || DEFAULTS.goal };
    default:
      throw new Error(`fromRecord: unknown collection "${collection}"`);
  }
}

// ---------------------------------------------------------------------------
// Stable, human-readable key generation for brand-new rows.
// ---------------------------------------------------------------------------
export function makeKey(prefix, label) {
  const slug = String(label || '')
    .toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  const suffix = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return `${prefix}-${slug}-${suffix}`;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
const emptyModel = () => ({
  settings: { ...DEFAULTS },
  tasks: [], subscriptions: [], snapshots: [],
});

const store = {
  model: emptyModel(),
  idByKey: { tasks: new Map(), subscriptions: new Map(), snapshots: new Map(), settings: new Map() },
  lastPersisted: emptyModel(),
  _undo: [],
  _redo: [],
};

const strDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

// Build the logical model (and id maps, and the persistence baseline) from a
// bag of raw PocketBase records keyed by collection name.
export function toModel(raw) {
  const idByKey = { tasks: new Map(), subscriptions: new Map(), snapshots: new Map(), settings: new Map() };

  const index = (collection, records) => {
    for (const r of records) idByKey[collection].set(r.key, r.id);
  };

  // tasks / subscriptions: newest-first by created, then by key for stability.
  const tasksRaw = [...(raw.tasks || [])].sort((a, b) => strDesc(a.created || '', b.created || '') || strDesc(b.key, a.key));
  const subsRaw = [...(raw.subscriptions || [])].sort((a, b) => strDesc(a.created || '', b.created || '') || strDesc(b.key, a.key));
  // snapshots: newest-first by isoDate, tie-break created.
  const snapsRaw = [...(raw.snapshots || [])].sort((a, b) => strDesc(a.isoDate || '', b.isoDate || '') || strDesc(a.created || '', b.created || ''));

  index(COLLECTIONS.tasks, tasksRaw);
  index(COLLECTIONS.subscriptions, subsRaw);
  index(COLLECTIONS.snapshots, snapsRaw);

  const settingsRec = (raw.settings || [])[0];
  if (settingsRec) idByKey.settings.set(SETTINGS_KEY, settingsRec.id);

  const model = {
    settings: settingsRec ? fromRecord(COLLECTIONS.settings, settingsRec) : { ...DEFAULTS },
    tasks: tasksRaw.map((r) => fromRecord(COLLECTIONS.tasks, r)),
    subscriptions: subsRaw.map((r) => fromRecord(COLLECTIONS.subscriptions, r)),
    snapshots: snapsRaw.map((r) => fromRecord(COLLECTIONS.snapshots, r)),
  };

  store.model = model;
  store.idByKey = idByKey;
  store.lastPersisted = clone(model);
  store._undo = [];
  store._redo = [];
  return model;
}

// Install a replacement model. Records the previous one on the undo stack
// (unless told not to), which is what makes every mutation undoable.
export function applyModel(next, { undo = true } = {}) {
  if (undo) { store._undo.push(clone(store.model)); store._redo = []; }
  store.model = next;
  return store.model;
}

// Ergonomic mutation: clone → let the caller mutate the draft → install it.
export function mutate(mutator) {
  const draft = clone(store.model);
  mutator(draft);
  return applyModel(draft);
}

export function undo() {
  if (!store._undo.length) return false;
  store._redo.push(clone(store.model));
  store.model = store._undo.pop();
  return true;
}
export function redo() {
  if (!store._redo.length) return false;
  store._undo.push(clone(store.model));
  store.model = store._redo.pop();
  return true;
}
export const canUndo = () => store._undo.length > 0;
export const canRedo = () => store._redo.length > 0;

// Persistence baseline accessors (used by app.js's diff-based sync).
export const getModel = () => store.model;
export const getLastPersisted = () => store.lastPersisted;
export const markPersisted = () => { store.lastPersisted = clone(store.model); };
export const idMap = (collection) => store.idByKey[collection];
export const setRecordId = (collection, key, id) => store.idByKey[collection].set(key, id);
export const dropRecordId = (collection, key) => store.idByKey[collection].delete(key);

// Whole-model snapshot for import/export.
export const exportModel = () => clone(store.model);
