/**
 * Screens open on what the app already has, and the user's own changes show
 * before the server has answered them (apps/mobile/src/data/AppData.ts).
 *
 * Each test holds or breaks the API on purpose, through page.route, to show
 * what the app does without it: a group opened from what the device kept, an
 * expense on the group while its POST is still waiting, a save the server
 * refused, one sent again after it couldn't get through.
 */

import type { Page, Route } from '@playwright/test';

import { back, button, expenseForm, goToGroup, groupHeader, openGroup, saveExpense } from '../src/actions';
import { API_PORT } from '../src/env';
import { expect, test } from '../src/fixtures';

const isApi = (url: URL) => url.hostname === '127.0.0.1' && url.port === String(API_PORT);

/**
 * Holds the API's answers to the requests `match` picks until the returned
 * function lets them go. Everything else goes through as usual.
 */
async function hold(page: Page, match: (url: URL, method: string) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(
    (url) => isApi(url),
    async (route: Route) => {
      const req = route.request();
      if (!match(new URL(req.url()), req.method())) return route.continue();
      await gate;
      // A reload while held cancels it: nothing to answer then.
      await route.continue().catch(() => {});
    }
  );
  return release;
}

const postsAnExpense = (url: URL, method: string) => method === 'POST' && /^\/groups\/[^/]+\/expenses$/.test(url.pathname);

/** The line under an expense: who paid what, then its time, or that it's still saving. */
const paidLine = (page: Page, text: RegExp) => page.getByText(text);

test.describe('screens open on what the app already has', () => {
  test('a group opens on what the device kept, before the server has answered anything', async ({ person }) => {
    const yash = await person('Yash', {
      seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob'], spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }] }).then(() => {}),
    });
    const { page } = yash;
    await openGroup(page, 'Trip');
    await expect(page.getByText('Villa', { exact: true })).toBeVisible();

    // From here the server answers nothing until let go: the app has only what it kept.
    const release = await hold(page, () => true);
    await page.reload();
    await openGroup(page, 'Trip');
    await expect(page.getByText('Villa', { exact: true })).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    await expect(page.getByText('You’re owed ₹150', { exact: true })).toBeVisible();

    // What changed meanwhile arrives once the server answers, without leaving the screen.
    const [group] = await yash.api.groups();
    const members = await yash.api.members(group.id);
    await yash.api.addExpense({
      groupId: group.id,
      description: 'Cab',
      amount: 1_000,
      paidByMemberId: members.find((m) => m.displayName === 'Bob')!.id,
      splitMode: 'equal',
      parts: members.map((m) => ({ memberId: m.id })),
    });
    release();
    await expect(page.getByText('Cab', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('opening a group, leaving it and opening it again asks the server for nothing but /sync and the history ahead', async ({ person }) => {
    const yash = await person('Yash', {
      seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob'], spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }] }).then(() => {}),
    });
    const { page } = yash;
    const asked: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (isApi(url) && req.method() === 'GET') asked.push(url.pathname);
    });
    for (let i = 0; i < 2; i++) {
      await openGroup(page, 'Trip');
      await expect(page.getByText('Villa', { exact: true })).toBeVisible();
      await button(page, 'Add expense').click();
      await expect(expenseForm.description(page)).toBeVisible();
      await back(page);
      await expect(groupHeader(page)).toBeVisible();
      await back(page);
      await expect(page.getByText('Trip', { exact: true })).toBeVisible();
    }
    // The history is read ahead, once a minute at most, so See all opens at once too.
    const history = asked.filter((path) => /^\/groups\/[^/]+\/history$/.test(path));
    expect(history.length).toBeLessThanOrEqual(1);
    expect(asked.filter((path) => path !== '/sync' && path !== '/health' && !history.includes(path))).toEqual([]);
  });
});

test.describe('an expense saved without waiting for the server', () => {
  test('is on the group at once, saving, and then saved', async ({ person }) => {
    const yash = await person('Yash', { seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob'] }).then(() => {}) });
    const { page } = yash;
    await goToGroup(page, 'Trip');
    const release = await hold(page, postsAnExpense);

    await button(page, 'Add expense').click();
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('100');
    await saveExpense(page);
    // Back on the group before the server has it, with what it means already counted.
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('Villa', { exact: true })).toBeVisible();
    await expect(paidLine(page, /^You paid ₹100 · Saving…$/)).toBeVisible();
    await expect(page.getByText('You’re owed ₹50', { exact: true })).toBeVisible();
    const [group] = await yash.api.groups();
    expect(await yash.api.expenses(group.id)).toHaveLength(0);

    release();
    await expect(paidLine(page, /Saving…/)).toHaveCount(0);
    await expect(paidLine(page, /^You paid ₹100 · \d{1,2}:\d{2} (am|pm)$/)).toBeVisible();
    await expect.poll(async () => (await yash.api.expenses(group.id)).length).toBe(1);
    await page.reload();
    await openGroup(page, 'Trip');
    await expect(page.getByText('Villa', { exact: true })).toHaveCount(1);
  });

  test('that the server refuses stays on the group as not saved, says why, and is put right in the form', async ({ person }) => {
    const yash = await person('Yash', { seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob', 'Aman'] }).then(() => {}) });
    const { page } = yash;
    await goToGroup(page, 'Trip');
    const [group] = await yash.api.groups();
    const aman = await yash.api.memberNamed(group.id, 'Aman');

    await button(page, 'Add expense').click();
    await expenseForm.description(page).fill('Cab');
    await expenseForm.amount(page).fill('300');
    // Aman is taken out on another phone while the form is open, so the split names someone who isn't there.
    await yash.api.del(`/groups/${group.id}/members/${aman.id}`);
    await saveExpense(page);

    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText(/Not saved\. Someone in that split isn’t in this group\./)).toBeVisible();
    // It counts in nobody's balance.
    await expect(page.getByText('No expenses yet', { exact: true })).toBeVisible();
    expect(await yash.api.expenses(group.id)).toHaveLength(0);

    // Edit opens the form on it, without the person who isn't in the group any more, and saves it afresh.
    await page.getByRole('button', { name: 'Edit Cab', exact: true }).click();
    await expect(expenseForm.description(page)).toHaveValue('Cab');
    await expect(expenseForm.amount(page)).toHaveValue('300');
    await saveExpense(page);
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText(/Not saved/)).toHaveCount(0);
    await expect(page.getByText('Cab', { exact: true })).toHaveCount(1);
    await expect.poll(async () => (await yash.api.expenses(group.id)).map((e) => e.parts.length)).toEqual([2]);
  });

  test('that the server refuses can be let go', async ({ person }) => {
    const yash = await person('Yash', { seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob', 'Aman'] }).then(() => {}) });
    const { page } = yash;
    await goToGroup(page, 'Trip');
    const [group] = await yash.api.groups();
    const aman = await yash.api.memberNamed(group.id, 'Aman');
    await button(page, 'Add expense').click();
    await expenseForm.description(page).fill('Cab');
    await expenseForm.amount(page).fill('300');
    await yash.api.del(`/groups/${group.id}/members/${aman.id}`);
    await saveExpense(page);
    await expect(page.getByText(/Not saved\./)).toBeVisible();
    await page.getByRole('button', { name: 'Delete Cab', exact: true }).click();
    await expect(page.getByText(/Not saved/)).toHaveCount(0);
    await expect(page.getByText('Cab', { exact: true })).toHaveCount(0);
  });

  test('that couldn’t get through is sent again, once, when the server answers', async ({ person }) => {
    const yash = await person('Yash', { seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob'] }).then(() => {}) });
    const { page } = yash;
    await goToGroup(page, 'Trip');
    // The first try gets to the server, but its answer is lost on the way back.
    let lost = false;
    await page.route(
      (url) => isApi(url),
      async (route) => {
        const req = route.request();
        if (!lost && postsAnExpense(new URL(req.url()), req.method())) {
          lost = true;
          await route.fetch();
          return route.abort('connectionreset');
        }
        return route.continue();
      }
    );

    await button(page, 'Add expense').click();
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('100');
    await saveExpense(page);
    await expect(groupHeader(page)).toBeVisible();
    // Sent again with the same key, the server answers as it did the first time: one expense, not two.
    await expect(paidLine(page, /^You paid ₹100 · \d{1,2}:\d{2} (am|pm)$/)).toBeVisible({ timeout: 20_000 });
    const [group] = await yash.api.groups();
    await expect.poll(async () => (await yash.api.expenses(group.id)).length).toBe(1);
    await page.waitForTimeout(1_000);
    expect(await yash.api.expenses(group.id)).toHaveLength(1);
    await expect(page.getByText('Villa', { exact: true })).toHaveCount(1);
  });

  test('deleting one takes it off at once, before the server has answered', async ({ person }) => {
    const yash = await person('Yash', {
      seed: (api) => api.seedGroup({ name: 'Trip', people: ['Bob'], spends: [{ description: 'Dinner', amount: 30_000, paidBy: 'Yash' }] }).then(() => {}),
    });
    const { page } = yash;
    await goToGroup(page, 'Trip');
    const release = await hold(page, (url, method) => method === 'DELETE' && /\/expenses\//.test(url.pathname));
    await page.getByText('Dinner', { exact: true }).click();
    await button(page, 'Delete expense').click();
    await button(page, 'Yes, delete this expense').click();
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('Dinner', { exact: true })).toHaveCount(0);
    const [group] = await yash.api.groups();
    expect(await yash.api.expenses(group.id)).toHaveLength(1);
    release();
    await expect.poll(async () => (await yash.api.expenses(group.id)).length).toBe(0);
    await expect(page.getByText('Dinner', { exact: true })).toHaveCount(0);
  });
});
