//agent touched this and used local claude md
// task-due-date.spec.js — E2E coverage for the task "due date" feature.
//
// Drives the real, running app (PocketBase + static frontend, no mocks) the
// way a user would: opens the quick-add modal, types in the inline row date
// control, reloads. Asserts on visible state (input values, aria-label/title
// labels, row presence), never internals.
//
// Runs against the committed seed (e2e/seed_pb_data, built from SEED in
// public/config.js — see e2e/README.md). SEED tasks carry NO `due`, so every
// seeded row starts with an empty date control (body.due round-trips as null
// via state.js toRecord/fromRecord). Each mutating test below uses a DISTINCT
// seeded task (or a uniquely-titled new task) so the fully-parallel run never
// has two tests fighting over the same row on the shared backend.
//
// The inline `.due-input` is an <input type="date"> the app watches with a
// delegated `change` listener (app.js onChange → setTaskDue); Playwright's
// fill() only emits `input`, so we fill() then dispatchEvent('change') to fire
// the exact event the app is wired to react to.

import { test, expect } from '@playwright/test';

// A specific task row / its inline due-date control, located by visible title.
const taskRow = (page, title) => page.locator('.taskrow', { hasText: title });
const dueInput = (page, title) => taskRow(page, title).locator('.due-input');

// Set (or, with iso='', clear) an existing row's due date the way a user does:
// type into the inline date control, which fires the app's `change` handler.
async function setInlineDue(page, title, iso) {
  const input = dueInput(page, title);
  await input.fill(iso);
  await input.dispatchEvent('change');
  return input;
}

// Create a task through the quick-add modal. `iso` optional — omit for no due.
async function addTask(page, title, iso) {
  await page.locator('.add-btn', { hasText: 'Add task' }).click();
  await page.locator('#f-task-title').fill(title);
  if (iso) await page.locator('#f-task-due').fill(iso);
  await page.locator('.save-btn', { hasText: 'Add task' }).click();
}

test.describe('Task due dates', () => {
  // COVERS: AC-1
  test('AC-1: every task carries a due field defaulting to no date (null)', async ({ page }) => {
    await page.goto('/');

    // The due control is wired onto EVERY task row (the field exists universally),
    // not just some — one `.due-input` per `.taskrow`.
    const rows = page.locator('.taskrow');
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(await page.locator('.taskrow .due-input').count()).toBe(rowCount);

    // A seeded task (SEED has no `due`) round-trips through storage as null →
    // its control shows no date.
    await expect(dueInput(page, 'Finish Q3 planning doc')).toHaveValue('');

    // A brand-new task defaults to no due date (null → empty control).
    await addTask(page, 'AC1 field-default task');
    await expect(dueInput(page, 'AC1 field-default task')).toHaveValue('');
  });

  // COVERS: AC-2
  test('AC-2: a due date can be set on a task when it is created', async ({ page }) => {
    await page.goto('/');

    await addTask(page, 'AC2 created-with-due task', '2026-09-30');

    const input = dueInput(page, 'AC2 created-with-due task');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('2026-09-30');
    // formatDueDate('2026-09-30') → en-US "Sep 30, 2026".
    await expect(input).toHaveAttribute('aria-label', 'Sep 30, 2026');
  });

  // COVERS: AC-3
  test("AC-3: an existing task's due date can be edited inline and cleared", async ({ page }) => {
    await page.goto('/');

    // Seeded → starts with no due.
    const input = dueInput(page, 'Text Sarah back');
    await expect(input).toHaveValue('');

    // Edit: typing a date into the inline control sets it.
    await setInlineDue(page, 'Text Sarah back', '2026-08-15');
    await expect(input).toHaveValue('2026-08-15');
    await expect(input).toHaveAttribute('aria-label', 'Aug 15, 2026');

    // Clear: emptying the control resets the due date to null.
    await setInlineDue(page, 'Text Sarah back', '');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('aria-label', 'Set due date');
  });

  // COVERS: AC-4
  test("AC-4: a task row displays its due date once set", async ({ page }) => {
    await page.goto('/');

    await setInlineDue(page, 'Book dentist appointment', '2026-12-25');

    // The chosen date is visible both as the control's value and as the
    // human-readable label (aria-label + title = formatDueDate).
    const input = dueInput(page, 'Book dentist appointment');
    await expect(input).toHaveValue('2026-12-25');
    await expect(input).toHaveAttribute('aria-label', 'Dec 25, 2026');
    await expect(input).toHaveAttribute('title', 'Dec 25, 2026');
  });

  // COVERS: AC-5
  test('AC-5: due date is optional — empty renders as an empty control, no error, no fabricated date', async ({ page }) => {
    await page.goto('/');

    // A seeded task with no due shows a literally empty control labelled
    // "Set due date" — no placeholder / synthesized date is invented.
    const seeded = dueInput(page, 'Call Dad');
    await expect(seeded).toHaveValue('');
    await expect(seeded).toHaveAttribute('aria-label', 'Set due date');
    await expect(seeded).toHaveAttribute('title', 'Set due date');

    // Creating a task WITHOUT a due date is accepted (null is valid): the row
    // lands successfully and its due control stays empty — no error blocks it.
    await addTask(page, 'AC5 optional-no-due task');
    const created = dueInput(page, 'AC5 optional-no-due task');
    await expect(created).toBeVisible();
    await expect(created).toHaveValue('');
    await expect(created).toHaveAttribute('aria-label', 'Set due date');
  });

  // COVERS: AC-6
  test('AC-6: a due date persists across a reload (body.due round-trip)', async ({ page }) => {
    await page.goto('/');

    await setInlineDue(page, 'Meal prep for the week', '2026-10-05');
    await expect(dueInput(page, 'Meal prep for the week')).toHaveValue('2026-10-05');

    // Mutations flush to PocketBase on a debounce (SYNC_DEBOUNCE_MS = 500 in
    // config.js); reloading before it flushes would just refetch the pre-edit
    // state. Wait past the debounce, then reload to prove it truly persisted.
    await page.waitForTimeout(800);
    await page.reload();

    const reloaded = dueInput(page, 'Meal prep for the week');
    await expect(reloaded).toHaveValue('2026-10-05');
    await expect(reloaded).toHaveAttribute('aria-label', 'Oct 5, 2026');

    // Leave the seeded state as found for any other reader.
    await setInlineDue(page, 'Meal prep for the week', '');
    await expect(dueInput(page, 'Meal prep for the week')).toHaveValue('');
    await page.waitForTimeout(800);
  });
});
