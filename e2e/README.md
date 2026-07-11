# E2E harness

Real browser tests (Playwright) against the real app: PocketBase + the
static frontend, no mocks. `run-e2e.ps1` stands up a throwaway instance
seeded with known fixture data, runs the tests, tears everything down.

## Running it

Stop any running dev instance first (`npm start` binds the same ports this
uses: 8090 for PocketBase, 3000 for the frontend), then:

```powershell
powershell -ExecutionPolicy Bypass -File ./e2e/run-e2e.ps1
```

## What's fixed vs. what's fresh each run

- `e2e/seed_pb_data/` is committed — a pre-provisioned PocketBase data
  directory (collections + the fixture records from `SEED` in
  `public/config.js`). Tests assert against these known values (e.g. the
  seeded user is "Ayalon", "Call Dad" is a seeded task).
- Each run copies that seed to a throwaway temp directory and points
  PocketBase at the copy, so tests can freely mutate data (see
  `dashboard.spec.js`'s task-toggle test) without ever touching the
  committed seed or your real dev `pb_data/`.

## Rebuilding the seed data

Only needed if the PocketBase schema changes (i.e. `setup.js`'s `SCHEMA`)
or you want different fixture records (`SEED` in `public/config.js`).
`setup.js` is the same provisioner `npm run setup` uses for local dev; two
env vars let it target a scratch instance instead of your real one:

```powershell
# pick a port your real dev PocketBase isn't using (dev uses 8090)
$scratch = "$env:TEMP\pb_seed_rebuild"
Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
New-Item -ItemType Directory $scratch | Out-Null

Start-Process ./pocketbase.exe -ArgumentList "serve","--http=127.0.0.1:8091","--dir=$scratch" -NoNewWindow

$env:PB_API_BASE = "http://127.0.0.1:8091/api"
$env:PB_DATA_DIR = $scratch
node setup.js
Remove-Item Env:\PB_API_BASE, Env:\PB_DATA_DIR

# stop the scratch pocketbase, then replace the committed seed:
Remove-Item -Recurse -Force ./e2e/seed_pb_data
Copy-Item -Recurse $scratch ./e2e/seed_pb_data
```
