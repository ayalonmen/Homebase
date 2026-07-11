// dashboard.spec.js — smoke test against the real, running app.
//
// Asserts against the known fixture data in e2e/seed_pb_data (built from the
// same SEED constant in public/config.js — see e2e/README.md for how the
// seed was produced). This is deliberately a smoke test, not exhaustive
// coverage: it proves the whole stack (PocketBase + static frontend) boots
// and renders real data end to end. Per-ticket behavior gets its own tests
// written by the pipeline's test agent, not added here.

import { test, expect } from '@playwright/test';

test('dashboard loads and greets the seeded user', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.greeting')).toHaveText(/^Good (morning|afternoon|evening), Ayalon\.$/);
  await expect(page.locator('.subline')).toBeVisible();
});

test('tasks tab shows seeded tasks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Call Dad')).toBeVisible();
  await expect(page.getByText('Pay Amex balance')).toBeVisible();
});

test('finance tab shows seeded subscriptions and monthly spend', async ({ page }) => {
  await page.goto('/');
  await page.locator('.tab', { hasText: 'Finance' }).click();
  await expect(page.locator('.svc-name', { hasText: 'Netflix' })).toBeVisible();
  await expect(page.locator('.svc-name', { hasText: 'Spotify' })).toBeVisible();
  // Active seeded subscriptions' monthly-equivalent cost is a stable derived
  // number — just check the stat card renders a dollar amount, not the exact
  // figure (that math belongs to a unit test on the pure function, not e2e).
  await expect(page.locator('.stat-big')).toContainText('$');
});

test('toggling a task persists across reload', async ({ page }) => {
  await page.goto('/');
  // Default filter is "Open", so completing a task removes its row from
  // view immediately — that's correct app behavior, not something to
  // assert against. Switch to the "Done" filter to see it land there.
  const row = page.locator('.taskrow', { hasText: 'Guitar — 20 minutes' });
  await row.locator('.check').click();

  const doneFilter = page.locator('.seg', { hasText: 'Done' });
  await doneFilter.click();
  const doneRow = page.locator('.taskrow', { hasText: 'Guitar — 20 minutes' });
  await expect(doneRow).toHaveClass(/done/);

  // Mutations sync to PocketBase on a debounce (SYNC_DEBOUNCE_MS in
  // config.js) rather than immediately — reloading before it flushes would
  // just refetch the pre-toggle state and fail for a reason that has
  // nothing to do with whether persistence actually works.
  await page.waitForTimeout(800);
  await page.reload();
  await doneFilter.click();
  const reloadedRow = page.locator('.taskrow', { hasText: 'Guitar — 20 minutes' });
  await expect(reloadedRow).toHaveClass(/done/);

  // Leave state as found for any other test that reads this row.
  await reloadedRow.locator('.check').click();
});
