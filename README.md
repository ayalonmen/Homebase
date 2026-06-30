# Life Management Dashboard

A personal life-management **cockpit** — tabs of self-contained widgets (Tasks,
Subscriptions, Road to Freedom). Vanilla JS ES modules on the front, PocketBase
(REST only) on the back. **No build step, no bundler, no framework.**

```
.
├─ pocketbase.exe          # the backend (single Go binary, used as a REST API)
├─ setup.js                # one-time idempotent provisioner (drop + recreate + seed)
├─ package.json            # type:module, scripts (no dependencies to install)
├─ start.ps1               # one-command dev orchestration (Windows)
└─ public/                 # the static frontend (served as-is)
   ├─ index.html           #   skeleton only
   ├─ style.css            #   design tokens + design system
   ├─ config.js            #   constants (incl. API_BASE) + the SEED logical model
   ├─ api.js               #   thin REST wrapper (throws on 4xx/5xx, 204→null)
   ├─ validator.js         #   pure validation + referential-integrity checks
   ├─ state.js             #   single in-memory model + id maps + mappers + undo
   ├─ render.js            #   DOM as a pure function of state (data-* hooks)
   └─ app.js               #   init, event delegation, debounced sync, undo/redo, import/export
```

## Prerequisites

- **Node.js** ≥ 18 (uses the built-in `fetch`).
- **PocketBase** binary in the project root. It is not committed (platform-specific, ~32MB).
  Download it from [pocketbase.io/docs](https://pocketbase.io/docs/) and unzip the executable
  here as `pocketbase.exe` (Windows) or `pocketbase` (macOS/Linux). Built against v0.39.x.

## Run it

### One command (Windows / PowerShell)

```powershell
npm start
```

This starts PocketBase, provisions + seeds the database, and serves the
frontend at **http://127.0.0.1:5173**. Ctrl+C stops everything.

### Manual (any platform), three terminals

```bash
# 1. backend (REST API)
./pocketbase serve --http=127.0.0.1:8090        # Windows: .\pocketbase.exe serve --http=127.0.0.1:8090

# 2. provision + seed (one time; safe to re-run — it drops & recreates)
node setup.js

# 3. frontend
npx serve -l 5173 public
```

Open **http://127.0.0.1:5173**.

## How it works

- **PocketBase is the source of truth.** `setup.js` authenticates as a superuser
  (bootstrapped with `pocketbase superuser upsert`), then idempotently **drops
  and recreates** every collection — fields, indexes, and access rules — and
  seeds initial data from the single `SEED` constant in `config.js`, using the
  exact same `toRecord()` mapper the client uses (so seeds round-trip perfectly).
- **Admin credentials** come from `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD`
  (dev fallback: `admin@homebase.dev` / `devpassword1234`).
- **Access rules are open (`""`) in dev.** CORS defaults to `*`, so the static
  frontend calls the API cross-origin with no auth token. **Data integrity is
  enforced client-side** by `validator.js`.
- **Hybrid storage.** Queryable fields are flat indexed columns; nested/freeform
  data lives in a single `body` JSON column per record (subscription
  `next`/`method`, the seven snapshot balances, the settings blob).
- **Stable string keys.** Every record carries a human-readable `key`; the client
  references records by `key` (never PocketBase's internal id). `state.js` keeps
  `key → id` maps so updates/deletes can find the row.
- **One model, pure DOM.** `state.js` holds the single in-memory model; the DOM
  is always rebuilt from it (`render.js`). Mutations update the model, re-render,
  and schedule a **debounced, diff-based** flush to PocketBase. Undo/redo and
  JSON import simply swap the model — the diff reconciles the server.

## Keyboard / extras

- **Undo / Redo** — `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`), or the toolbar buttons.
- **Export / Import** — JSON of the whole model, from the toolbar.
- **Esc** closes the quick-add dialog.

## Extending

Add a tab in `config.js#TABS`, a widget render branch in `render.js`, a
collection in `setup.js#SCHEMA`, and mappers in `state.js` — everything else
(quick-add modal, toast, diff-sync, undo) is shared.
