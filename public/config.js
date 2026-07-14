// config.js — constants + the SEED logical model.
//
// This is the single source of truth shared by the frontend AND the Node
// provisioner (setup.js imports it). It contains ONLY values: API endpoints,
// the domain palettes/labels, and the initial seed data expressed as the
// *logical* model (the same shape the client keeps in memory — NOT the
// physical PocketBase record shape). The mapping between the logical model and
// PocketBase records lives in state.js (read) and setup.js (write).

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export const API_BASE = 'http://127.0.0.1:8090/api';

// Logical collection names. Used everywhere instead of bare strings.
export const COLLECTIONS = {
  tasks: 'tasks',
  subscriptions: 'subscriptions',
  snapshots: 'snapshots',
  settings: 'settings',
};

// The single settings record is addressed by this stable key.
export const SETTINGS_KEY = 'app';

// Debounce window (ms) for flushing local mutations to PocketBase.
export const SYNC_DEBOUNCE_MS = 500;

// A task counts as "due soon" when it falls due within this many calendar days
// of today (inclusive). No lower bound is applied, so overdue tasks qualify too.
export const SOON_THRESHOLD_DAYS = 1;

// ---------------------------------------------------------------------------
// Domain palettes — every life area / category owns a neon accent.
// Order matters: object key order drives the order dots/buttons render in.
// ---------------------------------------------------------------------------
export const AREAS = {
  body:    { name: 'Body',    accent: '#00F0FF' },
  mental:  { name: 'Mind',    accent: '#B14EFF' },
  finance: { name: 'Finance', accent: '#00FF94' },
  career:  { name: 'Work',    accent: '#3B82F6' },
  rel:     { name: 'People',  accent: '#FF2E97' },
  hobbies: { name: 'Hobbies', accent: '#FF9500' },
  general: { name: 'General', accent: '#8A8AA0' },
};

export const SUBCATS = {
  entertainment: { name: 'Entertainment', accent: '#FF2E97' },
  software:      { name: 'Software',      accent: '#3B82F6' },
  health:        { name: 'Health',        accent: '#00F0FF' },
  news:          { name: 'News',          accent: '#FF9500' },
  shopping:      { name: 'Shopping',      accent: '#B14EFF' },
  utilities:     { name: 'Utilities',     accent: '#00FF94' },
};

export const CYCLES = {
  monthly: { label: 'Monthly', suffix: '/mo' },
  yearly:  { label: 'Yearly',  suffix: '/yr' },
  weekly:  { label: 'Weekly',  suffix: '/wk' },
};

// Net-worth balance fields, in display order.
export const NW_FIELDS = [
  { k: 'ira',     label: 'IRA' },
  { k: 'irap',    label: 'IRA Private' },
  { k: 'pension', label: 'Pension' },
  { k: 're',      label: 'Real estate' },
  { k: 'liquid',  label: 'Liquid (Bank)' },
  { k: 'brok',    label: 'Brokerage' },
  { k: 'crypto',  label: 'Crypto' },
];
// Short header labels for the (cramped) Road-to-Freedom table.
export const NW_FIELDS_SHORT = {
  ira: 'IRA', irap: 'IRA Priv.', pension: 'Pension', re: 'Real est.',
  liquid: 'Liquid', brok: 'Brokerage', crypto: 'Crypto',
};

// Tabs, in order. Each names the widget section(s) it owns — add a tab here
// plus a render branch and it drops into the shell.
export const TABS = [
  { k: 'tasks',   name: 'Tasks',   accent: AREAS.body.accent },
  { k: 'finance', name: 'Finance', accent: AREAS.finance.accent },
];

// Defaults for a brand-new install (only used if the settings record is empty).
export const DEFAULTS = { name: 'Ayalon', goal: 4200000 };

// ---------------------------------------------------------------------------
// SEED — the logical model used to populate a fresh database.
// Stable, human-readable `key`s are the cross-boundary identity for every
// record (PocketBase's internal id is never referenced by the client).
// ---------------------------------------------------------------------------
export const SEED = {
  settings: { name: 'Ayalon', goal: 4200000 },

  tasks: [
    { key: 'task-call-dad',         title: 'Call Dad',                category: 'rel',     done: false },
    { key: 'task-pay-amex',         title: 'Pay Amex balance',        category: 'finance', done: false },
    { key: 'task-q3-planning',      title: 'Finish Q3 planning doc',  category: 'career',  done: false },
    { key: 'task-evening-checkin',  title: 'Evening check-in',        category: 'mental',  done: false },
    { key: 'task-guitar',           title: 'Guitar — 20 minutes',     category: 'hobbies', done: false },
    { key: 'task-expense-report',   title: 'Submit expense report',   category: 'finance', done: false },
    { key: 'task-meal-prep',        title: 'Meal prep for the week',  category: 'body',    done: false },
    { key: 'task-review-pr-482',    title: 'Review PR #482',          category: 'career',  done: false },
    { key: 'task-text-sarah',       title: 'Text Sarah back',         category: 'rel',     done: false },
    { key: 'task-book-dentist',     title: 'Book dentist appointment',category: 'body',    done: false },
    { key: 'task-morning-workout',  title: 'Morning workout',         category: 'body',    done: true  },
    { key: 'task-reply-landlord',   title: 'Reply to landlord',       category: 'general', done: true  },
  ],

  subscriptions: [
    { key: 'sub-netflix',      name: 'Netflix',              cost: 15.49, cycle: 'monthly', category: 'entertainment', next: 'Jul 12',      method: 'Visa ·4242',       active: true  },
    { key: 'sub-spotify',      name: 'Spotify',              cost: 11.99, cycle: 'monthly', category: 'entertainment', next: 'Jul 4',       method: 'Visa ·4242',       active: true  },
    { key: 'sub-adobe-cc',     name: 'Adobe Creative Cloud', cost: 59.99, cycle: 'monthly', category: 'software',      next: 'Jul 19',      method: 'Visa ·4242',       active: true  },
    { key: 'sub-chatgpt-plus', name: 'ChatGPT Plus',         cost: 20.00, cycle: 'monthly', category: 'software',      next: 'Jul 22',      method: 'Mastercard ·8801', active: true  },
    { key: 'sub-icloud',       name: 'iCloud+',              cost: 2.99,  cycle: 'monthly', category: 'utilities',     next: 'Jul 8',       method: 'Mastercard ·8801', active: true  },
    { key: 'sub-amazon-prime', name: 'Amazon Prime',         cost: 139.0, cycle: 'yearly',  category: 'shopping',      next: 'Mar 2, 2027', method: 'Visa ·4242',       active: true  },
    { key: 'sub-equinox',      name: 'Equinox',              cost: 39.00, cycle: 'monthly', category: 'health',        next: 'Jul 1',       method: 'Mastercard ·8801', active: true  },
    { key: 'sub-nyt',          name: 'NYT',                  cost: 17.00, cycle: 'monthly', category: 'news',          next: 'Jul 15',      method: 'Visa ·4242',       active: false },
  ],

  // Newest-first. isoDate ("YYYY-MM") is the sortable flat key; date is the
  // display label. Balances are the freeform body of each snapshot.
  snapshots: [
    { key: 'snap-2026-06', date: 'Jun 2026', isoDate: '2026-06', ira: 620000, irap: 310000, pension: 540000, re: 1250000, liquid: 180000, brok: 720000, crypto: 200000 },
    { key: 'snap-2026-05', date: 'May 2026', isoDate: '2026-05', ira: 610000, irap: 305000, pension: 532000, re: 1240000, liquid: 172000, brok: 700000, crypto: 188000 },
    { key: 'snap-2026-04', date: 'Apr 2026', isoDate: '2026-04', ira: 600000, irap: 298000, pension: 525000, re: 1230000, liquid: 168000, brok: 675000, crypto: 175000 },
    { key: 'snap-2026-03', date: 'Mar 2026', isoDate: '2026-03', ira: 588000, irap: 292000, pension: 518000, re: 1220000, liquid: 160000, brok: 650000, crypto: 165000 },
    { key: 'snap-2026-02', date: 'Feb 2026', isoDate: '2026-02', ira: 575000, irap: 288000, pension: 510000, re: 1210000, liquid: 158000, brok: 628000, crypto: 150000 },
    { key: 'snap-2026-01', date: 'Jan 2026', isoDate: '2026-01', ira: 560000, irap: 280000, pension: 500000, re: 1200000, liquid: 150000, brok: 600000, crypto: 130000 },
  ],
};
