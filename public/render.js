// render.js — the DOM is a pure function of (model, ui).
//
// Everything the user sees is rebuilt from state here. Interaction points are
// exposed ONLY as data-* attributes (data-action / data-arg / data-kind /
// data-focus / data-enter); app.js wires them up via event delegation. This
// module never mutates the model and never talks to the network.
//
// Re-renders preserve focus, caret position, and uncommitted input values
// (forms are uncontrolled), and animate metric numbers with a count-up.

import {
  AREAS, SUBCATS, CYCLES, NW_FIELDS, NW_FIELDS_SHORT, TABS,
} from './config.js';
import { toDueDateInput, formatDueDate, isSoon } from './validator.js';

// ---------------------------------------------------------------------------
// tiny DOM builder
// ---------------------------------------------------------------------------
function el(tag, opts = {}, children = []) {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  if (opts.css) n.style.cssText = opts.css;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) if (v != null) n.setAttribute(k, v);
  if (opts.data) for (const [k, v] of Object.entries(opts.data)) if (v != null) n.dataset[k] = v;
  if (opts.value != null) n.value = opts.value;
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
const ac = (color) => `--ac:${color}`;
const area = (k) => AREAS[k] || AREAS.general;
const subcat = (k) => SUBCATS[k] || SUBCATS.utilities;
const dot = (cls = 'dot') => el('span', { class: cls });

// ---------------------------------------------------------------------------
// formatters / derived helpers (computed at read time)
// ---------------------------------------------------------------------------
export const money = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function fmtCompact(v) {
  v = Number(v || 0);
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + Math.round(v);
}
const toMonthly = (s) => s.cycle === 'yearly' ? s.cost / 12 : s.cycle === 'weekly' ? s.cost * 52 / 12 : s.cost;
const sumBal = (r) => NW_FIELDS.reduce((t, f) => t + (Number(r[f.k]) || 0), 0);

// Local calendar day as 'YYYY-MM-DD', built from local Y/M/D parts (the product
// treats due dates as local calendar days). Lives here, not in the pure module,
// because it reads the clock; it is the single source of "today" handed to
// isSoon(...).
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const fmt = (v, kind) => {
  if (kind === 'money') return money(v);
  if (kind === 'compact') return fmtCompact(v);
  return String(Math.round(v));
};

// ---------------------------------------------------------------------------
// animation bookkeeping (module-scoped, survives re-renders)
// ---------------------------------------------------------------------------
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let painted = false;
let prevTab = null;
const prevKeys = { tasks: new Set(), subscriptions: new Set(), snapshots: new Set() };
const prevCounts = new Map();

// A number element that count-ups from its previous value to `value`.
function counter(key, value, kind, cls) {
  return el('span', { class: cls, data: { count: String(value), countKey: key, fmt: kind }, text: fmt(value, kind) });
}

function runCounters(root) {
  const animate = (node, from, to, kind) => {
    if (reduceMotion() || from === to) { node.textContent = fmt(to, kind); return; }
    const dur = 600, t0 = performance.now(), ease = (x) => 1 - Math.pow(1 - x, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      node.textContent = fmt(from + (to - from) * ease(p), kind);
      if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(to, kind);
    };
    requestAnimationFrame(step);
  };
  root.querySelectorAll('[data-count]').forEach((node) => {
    const key = node.dataset.countKey, to = parseFloat(node.dataset.count), kind = node.dataset.fmt;
    const from = prevCounts.has(key) ? prevCounts.get(key) : 0;
    prevCounts.set(key, to);
    animate(node, from, to, kind);
  });
}

// ---------------------------------------------------------------------------
// focus / caret / value preservation
// ---------------------------------------------------------------------------
function capture() {
  // Uncommitted input values are only meaningful for fields; capture those.
  const values = {};
  document.querySelectorAll('input[data-focus], textarea[data-focus], select[data-focus]')
    .forEach((n) => { values[n.dataset.focus] = n.value; });
  // Focus, however, can rest on ANY data-focus element (tabs, toggles, filters,
  // delete buttons, …) — every persistent control carries a stable focus id so
  // a full re-render can hand focus back to the same control.
  const a = document.activeElement;
  const focusId = a?.dataset?.focus || null;
  const sel = (focusId && typeof a.selectionStart === 'number') ? [a.selectionStart, a.selectionEnd] : null;
  return { values, focusId, sel };
}
function restore(snap) {
  for (const [id, v] of Object.entries(snap.values)) {
    const n = document.querySelector(`[data-focus="${CSS.escape(id)}"]`);
    if (n && v !== undefined && n.value !== v) n.value = v;
  }
  if (snap.focusId) {
    const t = document.querySelector(`[data-focus="${CSS.escape(snap.focusId)}"]`);
    if (t) {
      t.focus();
      if (snap.sel && typeof t.setSelectionRange === 'function') {
        try { t.setSelectionRange(snap.sel[0], snap.sel[1]); } catch { /* number/date inputs */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------
function timeOfDay(h) { return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; }
const SUBLINES = {
  morning: 'A clear morning. Here’s what’s on deck.',
  afternoon: 'Midday check — here’s what’s left.',
  evening: 'Winding down — here’s what’s still open.',
};

function header(model, ui, derived) {
  const now = new Date();
  const tod = timeOfDay(now.getHours());

  const left = el('div', {}, [
    el('h1', { class: 'greeting', text: `Good ${tod}, ${model.settings.name}.` }),
    el('p', { class: 'subline', text: SUBLINES[tod] }),
  ]);

  // context stat card reflects active tab
  let label, meta, big, suffix, color, barWidth, countKey, countKind;
  if (ui.tab === 'tasks') {
    label = 'Progress'; meta = `${derived.doneCount}/${derived.total}`;
    big = derived.openCount; suffix = 'to go'; color = '#fff';
    barWidth = derived.pct + '%'; countKey = 'stat-tasks'; countKind = 'int';
  } else {
    label = 'Monthly spend'; meta = `${derived.activeCount} active`;
    big = derived.monthly; suffix = '/mo'; color = 'var(--green)';
    barWidth = '100%'; countKey = 'stat-finance'; countKind = 'money';
  }

  const card = el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-top' }, [
      el('span', { class: 'stat-label', text: label }),
      el('span', { class: 'stat-meta', text: meta }),
    ]),
    el('div', { class: 'stat-big', css: `color:${color}` }, [
      counter(countKey, big, countKind, 'stat-num'),
      el('span', { class: 'suffix', text: ' ' + suffix }),
    ]),
    el('div', { class: 'bar-track' }, [el('div', { class: 'bar-fill', css: `width:${barWidth}` })]),
  ]);

  return el('header', { class: 'header' + (painted ? '' : ' fade-up') }, [left, card]);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
function tabNav(ui) {
  const list = el('div', { class: 'tabs' + (painted ? '' : ' fade-up'), attrs: { role: 'tablist', 'aria-label': 'Dashboard widgets' } });
  for (const t of TABS) {
    const on = ui.tab === t.k;
    list.append(el('button', {
      class: 'tab', css: ac(t.accent),
      attrs: { role: 'tab', 'aria-selected': String(on) },
      data: { action: 'set-tab', arg: t.k, focus: 'tab:' + t.k },
    }, [dot(), t.name]));
  }
  return list;
}

// ---------------------------------------------------------------------------
// widget header (title + count + add button)
// ---------------------------------------------------------------------------
function widgetHead(title, countLabel, addLabel, accent, kind) {
  return el('div', { class: 'widget-head' }, [
    el('div', { class: 'widget-title' }, [el('h2', { text: title }), el('span', { class: 'count-label', text: countLabel })]),
    el('button', { class: 'add-btn', css: ac(accent), data: { action: 'open-form', kind, focus: 'add:' + kind } }, [
      el('span', { class: 'plus', text: '+' }), ' ' + addLabel,
    ]),
  ]);
}

const animatedRow = (coll, key, cls) => {
  const isNew = painted && !prevKeys[coll].has(key);
  return cls + (isNew ? ' row-in' : '');
};

// ---------------------------------------------------------------------------
// Tasks widget
// ---------------------------------------------------------------------------
function tasksWidget(model, ui, d) {
  const sec = el('section', { class: 'widget' + (prevTab !== ui.tab || !painted ? ' fade-up' : '') });
  sec.append(widgetHead('Tasks', d.tasksShown, 'Add task', AREAS.body.accent, 'task'));

  // filters row
  const seg = el('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': 'Filter tasks' } });
  for (const f of [{ k: 'open', label: 'Open' }, { k: 'soon', label: 'Soon' }, { k: 'done', label: 'Done' }]) {
    seg.append(el('button', { class: 'seg', attrs: { 'aria-pressed': String(ui.filter === f.k) }, data: { action: 'set-filter', arg: f.k, focus: 'filter:' + f.k } }, [
      f.label, el('span', { class: 'seg-count', text: String(d.countBy[f.k]) }),
    ]));
  }
  const cat = el('div', { class: 'cat-filter' }, [
    el('span', { class: 'label', text: 'Category' }),
    el('button', { class: 'area-all', attrs: { 'aria-pressed': String(ui.area === 'all'), title: 'All categories' }, data: { action: 'set-area', arg: 'all', focus: 'area:all' }, text: 'All' }),
  ]);
  for (const k of Object.keys(AREAS).filter((x) => x !== 'general')) {
    cat.append(el('button', {
      class: 'area-dot', css: ac(AREAS[k].accent),
      attrs: { 'aria-pressed': String(ui.area === k), title: AREAS[k].name, 'aria-label': AREAS[k].name },
      data: { action: 'set-area', arg: k, focus: 'area:' + k },
    }));
  }
  sec.append(el('div', { class: 'filters' }, [seg, cat]));

  // list
  const list = el('div', { class: 'list' });
  if (d.list.length === 0) {
    list.append(el('div', { class: 'empty' }, [el('div', { class: 'msg', text: d.emptyMsg })]));
  } else {
    for (const t of d.list) {
      const info = area(t.category);
      const dueLabel = formatDueDate(t.dueDate);
      const row = el('div', { class: animatedRow('tasks', t.key, 'taskrow' + (t.done ? ' done' : '')), css: ac(info.accent) }, [
        el('button', { class: 'check' + (t.done ? ' done' : ''), attrs: { 'aria-label': t.done ? 'mark not done' : 'mark done', 'aria-pressed': String(t.done) }, data: { action: 'toggle-task', arg: t.key, focus: 'toggle-task:' + t.key } }, [el('span', { class: 'glyph', text: '✓' })]),
        dot(),
        el('span', { class: 'task-title', text: t.title }),
        el('span', { class: 'pill', text: info.name }),
        el('input', {
          class: 'due-input',
          attrs: { type: 'date', 'aria-label': dueLabel || 'Set due date', title: dueLabel || 'Set due date' },
          value: toDueDateInput(t.dueDate),
          data: { action: 'set-due-date', arg: t.key, focus: 'task-due:' + t.key },
        }),
        el('button', { class: 'del', attrs: { 'aria-label': 'delete task' }, data: { action: 'del-task', arg: t.key, focus: 'del-task:' + t.key }, text: '✕' }),
      ]);
      list.append(row);
    }
  }
  sec.append(list);
  return sec;
}

// ---------------------------------------------------------------------------
// Subscriptions widget
// ---------------------------------------------------------------------------
function subsWidget(model, ui, d) {
  const sec = el('section', { class: 'widget' + (prevTab !== ui.tab || !painted ? ' fade-up' : '') });
  sec.append(widgetHead('Subscriptions', d.subsShown, 'Add subscription', AREAS.finance.accent, 'sub'));

  // summary cards
  const summary = el('div', { class: 'summary' }, [
    el('div', { class: 'metric-card accent' }, [
      el('div', { class: 'metric-label', text: 'Monthly spend' }),
      el('div', { class: 'metric-value green' }, [counter('sub-monthly', d.monthly, 'money', 'm-num')]),
    ]),
    el('div', { class: 'metric-card' }, [
      el('div', { class: 'metric-label', text: 'Yearly' }),
      el('div', { class: 'metric-value' }, [counter('sub-yearly', d.yearly, 'money', 'm-num')]),
    ]),
    el('div', { class: 'metric-card' }, [
      el('div', { class: 'metric-label', text: 'Active' }),
      el('div', { class: 'metric-value' }, [String(d.activeCount), el('span', { class: 'sub', text: ` of ${d.subTotal}` })]),
    ]),
  ]);
  sec.append(summary);

  // table
  const wrap = el('div', { class: 'xscroll' });
  const tbl = el('div', { class: 'subtable' });
  const head = el('div', { class: 'thead' });
  for (const h of ['Service', 'Category', 'Cost', 'Next', 'Status']) head.append(el('span', { text: h }));
  head.append(el('span'));
  tbl.append(head);

  if (model.subscriptions.length === 0) {
    tbl.append(el('div', { class: 'empty', text: '' }, [el('div', { class: 'msg', text: 'No subscriptions tracked yet. Add your first above.' })]));
  } else {
    for (const s of model.subscriptions) {
      const info = subcat(s.category);
      const row = el('div', { class: animatedRow('subscriptions', s.key, 'subrow' + (s.active ? '' : ' paused')), css: ac(info.accent) }, [
        el('span', { class: 'svc' }, [dot(), el('span', { class: 'svc-name', text: s.name })]),
        el('span', { class: 'cell-center' }, [el('span', { class: 'pill', text: info.name })]),
        el('span', { class: 'cost' }, [el('span', { class: 'amt', text: money(s.cost) }), el('span', { class: 'cyc', text: CYCLES[s.cycle].suffix })]),
        el('span', { class: 'next', text: s.next || '—' }),
        el('span', { class: 'cell-center' }, [
          el('button', { class: 'status' + (s.active ? ' on' : ''), data: { action: 'toggle-sub', arg: s.key, focus: 'toggle-sub:' + s.key }, attrs: { 'aria-pressed': String(s.active), 'aria-label': s.active ? 'pause subscription' : 'reactivate subscription' } }, [
            el('span', { class: 'sdot' }), s.active ? 'Active' : 'Paused',
          ]),
        ]),
        el('span', { class: 'cell-right' }, [el('button', { class: 'del', attrs: { 'aria-label': 'delete subscription' }, data: { action: 'del-sub', arg: s.key, focus: 'del-sub:' + s.key }, text: '✕' })]),
      ]);
      tbl.append(row);
    }
  }
  wrap.append(tbl);
  sec.append(wrap);
  return sec;
}

// ---------------------------------------------------------------------------
// Road to Freedom widget
// ---------------------------------------------------------------------------
function freedomWidget(model, ui, d) {
  const sec = el('section', { class: 'widget' + (prevTab !== ui.tab || !painted ? ' fade-up' : '') });
  sec.append(widgetHead('Road to Freedom', d.nwShown, 'Add snapshot', AREAS.finance.accent, 'networth'));

  // banner
  const banner = el('div', { class: 'goal-banner' }, [
    el('div', { class: 'goal-top' }, [
      el('div', {}, [
        el('div', { class: 'nw-label', text: 'Net worth' }),
        el('div', { class: 'nw-value' }, [counter('nw-current', d.current, 'compact', 'nw-big')]),
        el('div', { class: 'nw-sub', text: `of ${fmtCompact(model.settings.goal)} goal · ${fmtCompact(d.remaining)} to go` }),
      ]),
      el('div', { css: 'text-align:right' }, [
        el('div', { class: 'nw-pct' }, [counter('nw-pct', d.curPct, 'int', 'pct-num'), el('span', { class: 'pct-sign', text: '%' })]),
        el('button', { class: 'edit-goal', data: { action: 'open-form', kind: 'goal', focus: 'add:goal' }, text: 'Edit goal' }),
      ]),
    ]),
    el('div', { class: 'goal-meter' }, [el('span', { class: 'fill', css: `width:${Math.min(100, d.curPct)}%` })]),
  ]);
  sec.append(banner);

  // table
  const wrap = el('div', { class: 'xscroll' });
  const tbl = el('div', { class: 'nwtable' });
  const head = el('div', { class: 'thead' });
  head.append(el('span', { text: 'Date' }));
  for (const f of NW_FIELDS) head.append(el('span', { class: 'num', text: NW_FIELDS_SHORT[f.k] }));
  head.append(el('span', { text: 'To goal' }));
  head.append(el('span'));
  tbl.append(head);

  if (model.snapshots.length === 0) {
    tbl.append(el('div', { class: 'empty', text: '' }, [el('div', { class: 'msg', text: 'No snapshots yet. Log your first to start tracking.' })]));
  } else {
    for (const r of model.snapshots) {
      const total = sumBal(r), pct = model.settings.goal ? Math.round(total / model.settings.goal * 100) : 0;
      const row = el('div', { class: animatedRow('snapshots', r.key, 'nwrow') }, [
        el('span', { class: 'date', text: r.date }),
        ...NW_FIELDS.map((f) => el('span', { class: 'nw-num', text: fmtCompact(r[f.k]) })),
        el('span', { class: 'togoal' }, [
          el('span', { class: 'mini-meter' }, [el('span', { class: 'fill', css: `width:${Math.min(100, pct)}%` })]),
          el('span', { class: 'p', text: pct + '%' }),
        ]),
        el('span', { class: 'cell-right' }, [el('button', { class: 'del', attrs: { 'aria-label': 'delete snapshot' }, data: { action: 'del-snapshot', arg: r.key, focus: 'del-snapshot:' + r.key }, text: '✕' })]),
      ]);
      tbl.append(row);
    }
  }
  wrap.append(tbl);
  sec.append(wrap);
  return sec;
}

// ---------------------------------------------------------------------------
// toolbar (undo / redo / import / export + sync status)
// ---------------------------------------------------------------------------
function toolbar(ui) {
  const syncCls = ui.syncState === 'busy' ? 'sync-dot busy' : ui.syncState === 'error' ? 'sync-dot error' : 'sync-dot';
  const syncText = ui.syncState === 'busy' ? 'Syncing…' : ui.syncState === 'error' ? 'Sync error' : 'Synced';
  return el('div', { class: 'toolbar' }, [
    el('button', { class: 'tool-btn', attrs: { 'aria-label': 'undo', ...(ui.canUndo ? {} : { disabled: 'true' }) }, data: { action: 'undo', focus: 'tool:undo' }, text: '↶ Undo' }),
    el('button', { class: 'tool-btn', attrs: { 'aria-label': 'redo', ...(ui.canRedo ? {} : { disabled: 'true' }) }, data: { action: 'redo', focus: 'tool:redo' }, text: '↷ Redo' }),
    el('span', { class: 'spacer' }),
    el('span', { class: syncCls, text: syncText }),
    el('button', { class: 'tool-btn', data: { action: 'export', focus: 'tool:export' }, text: '⤓ Export' }),
    el('button', { class: 'tool-btn', data: { action: 'import', focus: 'tool:import' }, text: '⤒ Import' }),
  ]);
}

// ---------------------------------------------------------------------------
// quick-add modal
// ---------------------------------------------------------------------------
function modal(model, ui) {
  if (!ui.qaOpen) return null;
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'qa-overlay', data: { action: 'close-qa' }, attrs: { 'aria-hidden': 'true' } }));

  const body = el('div', {});
  if (ui.qaKind === 'task') body.append(taskForm(ui));
  else if (ui.qaKind === 'sub') body.append(subForm(ui));
  else if (ui.qaKind === 'networth') body.append(netForm());
  else if (ui.qaKind === 'goal') body.append(goalForm(model));

  const labels = { task: 'New task', sub: 'Track a subscription', networth: 'Log a net-worth snapshot', goal: 'Edit freedom goal' };
  frag.append(el('div', { class: 'qa-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': labels[ui.qaKind] } }, [body]));
  return frag;
}

function taskForm(ui) {
  const accent = area(ui.qaArea).accent;
  const grid = el('div', { class: 'area-grid' });
  for (const k of Object.keys(AREAS).filter((x) => x !== 'general')) {
    grid.append(el('button', {
      class: 'area-pick', css: ac(AREAS[k].accent),
      attrs: { 'aria-pressed': String(ui.qaArea === k) }, data: { action: 'pick-area', arg: k, focus: 'pick-area:' + k },
    }, [dot(), AREAS[k].name]));
  }
  return el('div', {}, [
    el('div', { class: 'qa-kicker', text: 'New task' }),
    el('h3', { text: 'What needs doing?' }),
    el('input', { class: 'text-input', attrs: { id: 'f-task-title', placeholder: 'Task title', autocomplete: 'off' }, data: { focus: 'f-task-title', enter: 'save-task' } }),
    el('div', { class: 'mono-label', text: 'Category' }),
    grid,
    el('div', { class: 'mono-label', text: 'Due date' }),
    el('input', { class: 'text-input', attrs: { id: 'f-task-due', type: 'date' }, data: { focus: 'f-task-due' } }),
    el('button', { class: 'save-btn accent', css: ac(accent), data: { action: 'save-task' }, text: 'Add task' }),
  ]);
}

function subForm(ui) {
  const cyc = el('div', { class: 'cycle-seg' });
  for (const k of Object.keys(CYCLES)) {
    cyc.append(el('button', { class: 'cycle-opt', attrs: { 'aria-pressed': String(ui.subCycle === k) }, data: { action: 'set-cycle', arg: k, focus: 'set-cycle:' + k }, text: CYCLES[k].label }));
  }
  const cats = el('div', { class: 'cat-wrap' });
  for (const k of Object.keys(SUBCATS)) {
    cats.append(el('button', { class: 'cat-pick', css: ac(SUBCATS[k].accent), attrs: { 'aria-pressed': String(ui.subCat === k) }, data: { action: 'set-subcat', arg: k, focus: 'set-subcat:' + k } }, [dot(), SUBCATS[k].name]));
  }
  return el('div', {}, [
    el('div', { class: 'qa-kicker green', text: 'New subscription' }),
    el('h3', { text: 'Track a subscription' }),
    el('label', { class: 'field-label', text: 'Service name' }),
    el('input', { class: 'text-input', attrs: { id: 'f-sub-name', placeholder: 'e.g. Netflix', autocomplete: 'off' }, data: { focus: 'f-sub-name', enter: 'save-sub' } }),
    el('div', { css: 'margin-top:13px' }, [
      el('label', { class: 'field-label', text: 'Cost' }),
      el('div', { class: 'money-input' }, [el('span', { class: 'sign', text: '$' }), el('input', { attrs: { id: 'f-sub-cost', type: 'number', min: '0', step: '0.01', placeholder: '0.00' }, data: { focus: 'f-sub-cost', enter: 'save-sub' } })]),
    ]),
    el('label', { class: 'field-label', css: 'margin:14px 0 8px', text: 'Billing cycle' }),
    cyc,
    el('label', { class: 'field-label', css: 'margin:16px 0 8px', text: 'Category' }),
    cats,
    el('button', { class: 'save-btn green', data: { action: 'save-sub' }, text: 'Add subscription' }),
  ]);
}

function netForm() {
  const grid = el('div', { class: 'nw-grid' });
  for (const f of NW_FIELDS) {
    grid.append(el('div', {}, [
      el('label', { class: 'field-label', text: f.label }),
      el('div', { class: 'money-input' }, [
        el('span', { class: 'sign', text: '$' }),
        el('input', { attrs: { id: 'f-nw-' + f.k, type: 'number', min: '0', step: '100', placeholder: '0' }, data: { focus: 'f-nw-' + f.k, enter: 'save-net' } }),
      ]),
    ]));
  }
  return el('div', {}, [
    el('div', { class: 'qa-kicker green', text: 'New snapshot' }),
    el('h3', { text: 'Log a net-worth snapshot' }),
    el('label', { class: 'field-label', text: 'Date' }),
    el('input', { class: 'nw-date', attrs: { id: 'f-nw-date', type: 'date' }, data: { focus: 'f-nw-date' } }),
    grid,
    el('button', { class: 'save-btn green', data: { action: 'save-net' }, text: 'Add snapshot' }),
  ]);
}

function goalForm(model) {
  return el('div', {}, [
    el('div', { class: 'qa-kicker green', text: 'Freedom goal' }),
    el('h3', { text: 'Your freedom number' }),
    el('label', { class: 'field-label', text: 'Target net worth' }),
    el('div', { class: 'money-input' }, [
      el('span', { class: 'sign', text: '$' }),
      el('input', { attrs: { id: 'f-goal-amount', type: 'text', inputmode: 'numeric' }, value: String(model.settings.goal), data: { focus: 'f-goal-amount', enter: 'save-goal' } }),
    ]),
    el('button', { class: 'save-btn green', data: { action: 'save-goal' }, text: 'Save goal' }),
  ]);
}

// ---------------------------------------------------------------------------
// derived values for a render pass
// ---------------------------------------------------------------------------
function derive(model, ui) {
  const items = model.tasks;
  const total = items.length, doneCount = items.filter((i) => i.done).length, openCount = total - doneCount;
  const pct = total ? Math.round(doneCount / total * 100) : 0;
  const scoped = ui.area === 'all' ? items : items.filter((i) => i.category === ui.area);
  const today = todayISO();
  const countBy = {
    open: scoped.filter((i) => !i.done).length,
    soon: scoped.filter((i) => isSoon(i.dueDate, i.done, today)).length,
    done: scoped.filter((i) => i.done).length,
  };
  let list = ui.filter === 'done'
    ? scoped.filter((i) => i.done)
    : ui.filter === 'soon'
      ? scoped.filter((i) => isSoon(i.dueDate, i.done, today))
      : scoped.filter((i) => !i.done);
  list = list.slice().sort((a, b) => Number(a.done) - Number(b.done)); // stable: open first
  const emptyMsg = ui.filter === 'done'
    ? 'Nothing checked off here yet — one thing at a time.'
    : ui.filter === 'soon'
      ? 'Nothing due soon — you’re ahead of it.'
      : 'All clear — nothing open here. Nice work.';

  const active = model.subscriptions.filter((s) => s.active);
  const monthly = active.reduce((sum, s) => sum + toMonthly(s), 0);

  const goal = model.settings.goal;
  const current = model.snapshots.length ? sumBal(model.snapshots[0]) : 0;
  const curPct = goal ? Math.round(current / goal * 100) : 0;

  return {
    total, doneCount, openCount, pct, countBy, list, emptyMsg,
    tasksShown: `${list.length} ${list.length === 1 ? 'task' : 'tasks'}`,
    activeCount: active.length, subTotal: model.subscriptions.length,
    monthly, yearly: monthly * 12,
    subsShown: `${model.subscriptions.length} ${model.subscriptions.length === 1 ? 'service' : 'services'}`,
    current, curPct, remaining: Math.max(0, goal - current),
    nwShown: `${model.snapshots.length} ${model.snapshots.length === 1 ? 'snapshot' : 'snapshots'}`,
  };
}

// ---------------------------------------------------------------------------
// public render entry point
// ---------------------------------------------------------------------------
export function render(model, ui) {
  const snap = capture();

  const appRoot = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');

  const d = derive(model, ui);

  // app
  appRoot.replaceChildren();
  appRoot.append(header(model, ui, d));
  appRoot.append(tabNav(ui));
  if (ui.tab === 'tasks') {
    appRoot.append(tasksWidget(model, ui, d));
  } else if (ui.tab === 'finance') {
    appRoot.append(subsWidget(model, ui, d));
    appRoot.append(freedomWidget(model, ui, d));
  }
  appRoot.append(toolbar(ui));

  // modal
  modalRoot.replaceChildren();
  const m = modal(model, ui);
  if (m) modalRoot.append(m);

  // toast
  toastRoot.replaceChildren();
  if (ui.toast) toastRoot.append(el('div', { class: 'toast', text: ui.toast }));

  restore(snap);
  runCounters(appRoot);

  // bookkeeping for next pass
  prevTab = ui.tab;
  painted = true;
  prevKeys.tasks = new Set(model.tasks.map((t) => t.key));
  prevKeys.subscriptions = new Set(model.subscriptions.map((s) => s.key));
  prevKeys.snapshots = new Set(model.snapshots.map((s) => s.key));
}

// Fatal full-screen error (API unreachable, etc.)
export function renderFatal(message, detail) {
  document.getElementById('app').replaceChildren(
    el('div', { class: 'fatal' }, [
      el('h2', { text: '⚠ Cannot load the dashboard' }),
      el('p', { text: message }),
      detail ? el('p', {}, [el('code', { text: detail })]) : null,
      el('p', {}, ['Start the backend with ', el('code', { text: 'pocketbase serve --http=127.0.0.1:8090' }), ' then provision it with ', el('code', { text: 'node setup.js' }), '.']),
    ]),
  );
  document.getElementById('modal-root').replaceChildren();
  document.getElementById('toast-root').replaceChildren();
}

export function renderLoading() {
  document.getElementById('app').replaceChildren(el('div', { class: 'loading', text: 'Loading your cockpit…' }));
}
