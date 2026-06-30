// app.js — the wiring.
//
//   • init: load all four collections in parallel (Promise.allSettled) → model
//   • event delegation: one click + one keydown listener for the whole app
//   • mutations: update the in-memory model, re-render, schedule a sync
//   • persistence: debounced, diff-based — compares the model against the last
//     known server state and emits the minimal create/update/delete set. This
//     makes undo/redo and import "just work" (they replace the model; the diff
//     reconciles the server).
//   • undo/redo (snapshot stacks) + import/export (JSON)

import { COLLECTIONS, SETTINGS_KEY, SYNC_DEBOUNCE_MS, NW_FIELDS } from './config.js';
import { listAll, createRecord, updateRecord, deleteRecord } from './api.js';
import {
  validateTask, validateSubscription, validateSnapshot, validateGoal, validateModel,
} from './validator.js';
import {
  toModel, mutate, applyModel, undo, redo, canUndo, canRedo,
  getModel, getLastPersisted, idMap, setRecordId, dropRecordId, makeKey, toRecord, exportModel,
} from './state.js';
import { render, renderFatal, renderLoading } from './render.js';

// ---------------------------------------------------------------------------
// UI state (ephemeral — never persisted)
// ---------------------------------------------------------------------------
const ui = {
  tab: 'tasks', filter: 'open', area: 'all',
  qaOpen: false, qaKind: 'task', qaArea: 'general',
  subCycle: 'monthly', subCat: 'entertainment',
  toast: '', syncState: 'idle', canUndo: false, canRedo: false,
};

function rerender() {
  ui.canUndo = canUndo();
  ui.canRedo = canRedo();
  render(getModel(), ui);
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  ui.toast = msg;
  rerender();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast = ''; rerender(); }, 2200);
}

const val = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };

// Move focus to a control by its stable data-focus id (used after a delete,
// whose own button no longer exists, so focus lands somewhere sensible).
const focusEl = (focusId) => { const n = document.querySelector(`[data-focus="${CSS.escape(focusId)}"]`); if (n) n.focus(); };

function afterChange(msg) {
  scheduleSync();
  if (msg) toast(msg); else rerender();
}

// ---------------------------------------------------------------------------
// debounced, diff-based persistence
// ---------------------------------------------------------------------------
let syncTimer;
let flushing = false; // re-entrancy guard: never run two flushes at once
function scheduleSync() {
  ui.syncState = 'busy';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flush, SYNC_DEBOUNCE_MS);
}

function diffOps() {
  const last = getLastPersisted(), cur = getModel(), ops = [];
  for (const coll of [COLLECTIONS.tasks, COLLECTIONS.subscriptions, COLLECTIONS.snapshots]) {
    const lastMap = new Map((last[coll] || []).map((r) => [r.key, r]));
    const curMap = new Map((cur[coll] || []).map((r) => [r.key, r]));
    for (const [key, row] of curMap) {
      const prev = lastMap.get(key);
      if (!prev) ops.push({ kind: 'create', coll, key, row });
      else if (JSON.stringify(prev) !== JSON.stringify(row)) ops.push({ kind: 'update', coll, key, row });
    }
    for (const key of lastMap.keys()) if (!curMap.has(key)) ops.push({ kind: 'delete', coll, key });
  }
  if (JSON.stringify(last.settings) !== JSON.stringify(cur.settings)) {
    ops.push({ kind: 'settings', coll: COLLECTIONS.settings, key: SETTINGS_KEY, row: cur.settings });
  }
  return ops;
}

async function runOp(op) {
  if (op.kind === 'create') {
    const rec = await createRecord(op.coll, toRecord(op.coll, op.row));
    return { op, rec };
  }
  if (op.kind === 'update') {
    const id = idMap(op.coll).get(op.key);
    if (!id) { const rec = await createRecord(op.coll, toRecord(op.coll, op.row)); return { op, rec, created: true }; }
    await updateRecord(op.coll, id, toRecord(op.coll, op.row));
    return { op };
  }
  if (op.kind === 'delete') {
    const id = idMap(op.coll).get(op.key);
    if (id) await deleteRecord(op.coll, id);
    return { op };
  }
  // settings
  const id = idMap(COLLECTIONS.settings).get(SETTINGS_KEY);
  if (id) { await updateRecord(COLLECTIONS.settings, id, toRecord(COLLECTIONS.settings, op.row)); return { op }; }
  const rec = await createRecord(COLLECTIONS.settings, toRecord(COLLECTIONS.settings, op.row));
  return { op, rec, created: true };
}

// Move the persistence baseline forward for a *successful* op only, so failed
// ops stay in the diff and get retried on the next flush.
function commit(res) {
  const last = getLastPersisted();
  const { op, rec, created } = res;
  if (op.kind === 'settings') {
    if (created) setRecordId(COLLECTIONS.settings, SETTINGS_KEY, rec.id);
    last.settings = structuredClone(op.row);
    return;
  }
  if (op.kind === 'create' || (op.kind === 'update' && created)) setRecordId(op.coll, op.key, rec.id);
  if (op.kind === 'delete') {
    dropRecordId(op.coll, op.key);
    last[op.coll] = last[op.coll].filter((r) => r.key !== op.key);
    return;
  }
  const arr = last[op.coll];
  const i = arr.findIndex((r) => r.key === op.key);
  if (i >= 0) arr[i] = structuredClone(op.row); else arr.push(structuredClone(op.row));
}

async function flush() {
  // Guard re-entrancy: a flush mid-request must not overlap a second flush, or
  // a create whose id/baseline hasn't been committed yet would be re-issued
  // (and rejected by the unique-key index). Reschedule and bail instead.
  if (flushing) { scheduleSync(); return; }

  const check = validateModel(getModel());
  if (!check.ok) { ui.syncState = 'error'; toast('Not saved — ' + check.errors[0]); return; }

  const ops = diffOps();
  if (!ops.length) { ui.syncState = 'idle'; rerender(); return; }

  flushing = true;
  ui.syncState = 'busy'; rerender();
  let fail = 0;
  try {
    const results = await Promise.allSettled(ops.map(runOp));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') commit(r.value);
      else { fail++; console.error('Sync failed:', ops[i], r.reason); }
    });
  } finally {
    flushing = false;
  }
  ui.syncState = fail ? 'error' : 'idle';
  rerender();
  if (fail) toast(`${fail} change${fail > 1 ? 's' : ''} couldn't save — will retry on next change.`);
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------
function toggleTask(key) {
  let msg;
  mutate((m) => { const t = m.tasks.find((x) => x.key === key); if (t) { t.done = !t.done; msg = t.done ? 'Nice — checked off  ✓' : 'Back on the list'; } });
  afterChange(msg);
}
function delTask(key) { mutate((m) => { m.tasks = m.tasks.filter((x) => x.key !== key); }); afterChange('Task removed'); focusEl('add:task'); }

function toggleSub(key) {
  let msg;
  mutate((m) => { const s = m.subscriptions.find((x) => x.key === key); if (s) { s.active = !s.active; msg = s.name + (s.active ? ' reactivated' : ' paused'); } });
  afterChange(msg);
}
function delSub(key) { mutate((m) => { m.subscriptions = m.subscriptions.filter((x) => x.key !== key); }); afterChange('Subscription removed'); focusEl('add:sub'); }
function delSnap(key) { mutate((m) => { m.snapshots = m.snapshots.filter((x) => x.key !== key); }); afterChange('Snapshot removed'); focusEl('add:networth'); }

function openForm(kind) {
  ui.qaOpen = true;
  ui.qaKind = kind;
  // SPEC §3: default to the currently-filtered area if one is selected, else general.
  if (kind === 'task') ui.qaArea = ui.area !== 'all' ? ui.area : 'general';
  rerender();
  const firstId = { task: 'f-task-title', sub: 'f-sub-name', networth: 'f-nw-date', goal: 'f-goal-amount' }[kind];
  const node = firstId && document.getElementById(firstId);
  if (node) { node.focus(); if (node.select) try { node.select(); } catch { /* noop */ } }
}

function saveTask() {
  const res = validateTask({ title: val('f-task-title'), category: ui.qaArea });
  if (!res.ok) { toast(res.error); return; }
  mutate((m) => { m.tasks.unshift({ key: makeKey('task', res.value.title), title: res.value.title, category: res.value.category, done: false }); });
  ui.qaOpen = false;
  afterChange('Task added  ✓');
}

function saveSub() {
  const res = validateSubscription({ name: val('f-sub-name'), cost: val('f-sub-cost'), cycle: ui.subCycle, category: ui.subCat });
  if (!res.ok) { toast(res.error); return; }
  const v = res.value;
  mutate((m) => { m.subscriptions.unshift({ key: makeKey('sub', v.name), name: v.name, cost: v.cost, cycle: v.cycle, category: v.category, active: true, next: '—', method: '' }); });
  ui.qaOpen = false;
  afterChange('Subscription added  ✓');
}

function saveNet() {
  const balances = {};
  for (const f of NW_FIELDS) balances[f.k] = val('f-nw-' + f.k);
  const res = validateSnapshot(balances);
  if (!res.ok) { toast(res.error); return; }

  const raw = val('f-nw-date');
  const parsed = raw ? new Date(raw + 'T00:00:00') : new Date();
  const dt = isNaN(parsed) ? new Date() : parsed;
  const date = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const isoDate = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;

  mutate((m) => {
    // unshift (not push) so that for an equal isoDate the new snapshot wins the
    // stable sort and lands at index 0 → becomes the current net worth (SPEC §5).
    m.snapshots.unshift({ key: makeKey('snap', isoDate), date, isoDate, ...res.value });
    m.snapshots.sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));
  });
  ui.qaOpen = false;
  afterChange('Snapshot added  ✓');
}

function saveGoal() {
  const res = validateGoal(val('f-goal-amount'));
  if (!res.ok) { toast(res.error); return; }
  mutate((m) => { m.settings.goal = res.value; });
  ui.qaOpen = false;
  afterChange('Goal updated  ✓');
}

function doUndo() { if (undo()) { ui.qaOpen = false; afterChange('Undone'); } }
function doRedo() { if (redo()) { ui.qaOpen = false; afterChange('Redone'); } }

// ---------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------
function doExport() {
  const blob = new Blob([JSON.stringify(exportModel(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `homebase-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported  ✓');
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('Import failed — not valid JSON.'); return; }

  const next = {
    settings: { ...getModel().settings, ...(data.settings || {}) },
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
  };
  const check = validateModel(next);
  if (!check.ok) { toast('Import failed — ' + check.errors[0]); return; }
  next.snapshots.sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));
  applyModel(next);
  ui.qaOpen = false;
  afterChange('Imported  ✓');
}

// ---------------------------------------------------------------------------
// event delegation
// ---------------------------------------------------------------------------
function handleAction(action, ds) {
  switch (action) {
    case 'set-tab': ui.tab = ds.arg; ui.qaOpen = false; rerender(); break;
    case 'set-filter': ui.filter = ds.arg; rerender(); break;
    case 'set-area': ui.area = ds.arg; rerender(); break;
    case 'toggle-task': toggleTask(ds.arg); break;
    case 'del-task': delTask(ds.arg); break;
    case 'toggle-sub': toggleSub(ds.arg); break;
    case 'del-sub': delSub(ds.arg); break;
    case 'del-snapshot': delSnap(ds.arg); break;
    case 'open-form': openForm(ds.kind); break;
    case 'close-qa': ui.qaOpen = false; rerender(); break;
    case 'pick-area': ui.qaArea = ds.arg; rerender(); break;
    case 'set-cycle': ui.subCycle = ds.arg; rerender(); break;
    case 'set-subcat': ui.subCat = ds.arg; rerender(); break;
    case 'save-task': saveTask(); break;
    case 'save-sub': saveSub(); break;
    case 'save-net': saveNet(); break;
    case 'save-goal': saveGoal(); break;
    case 'undo': doUndo(); break;
    case 'redo': doRedo(); break;
    case 'export': doExport(); break;
    case 'import': document.getElementById('import-file').click(); break;
  }
}

function onClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled) return;
  handleAction(t.dataset.action, t.dataset);
}

function onKeydown(e) {
  if (e.key === 'Enter') {
    const t = e.target;
    if (t?.dataset?.enter) { e.preventDefault(); handleAction(t.dataset.enter, {}); return; }
  }
  if (e.key === 'Escape' && ui.qaOpen) { ui.qaOpen = false; rerender(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '');
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function init() {
  renderLoading();
  const colls = [COLLECTIONS.tasks, COLLECTIONS.subscriptions, COLLECTIONS.snapshots, COLLECTIONS.settings];
  const sorts = { [COLLECTIONS.tasks]: '-created', [COLLECTIONS.subscriptions]: '-created', [COLLECTIONS.snapshots]: '-isoDate', [COLLECTIONS.settings]: '' };

  const results = await Promise.allSettled(colls.map((c) => listAll(c, { sort: sorts[c] })));
  const raw = {};
  let okCount = 0, firstErr = null;
  results.forEach((r, i) => {
    const c = colls[i];
    if (r.status === 'fulfilled') { raw[c] = r.value; okCount++; }
    else { raw[c] = []; firstErr = firstErr || r.reason; }
  });

  if (okCount === 0) { renderFatal('Could not reach PocketBase.', firstErr?.message); return; }

  toModel(raw);

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  document.getElementById('import-file').addEventListener('change', onImportFile);

  rerender();
  if (okCount < colls.length) toast('Some data could not be loaded.');
}

init();
