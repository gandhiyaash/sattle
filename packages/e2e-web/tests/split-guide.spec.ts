/**
 * The split guide, the first time a device adds an expense: the tip over the
 * split card on Add expense, and the tour of Who paid, how to split that Show
 * me opens, or the sheet's first opening brings. Its key step, leaving
 * someone out, is done for real through the spotlight while everything
 * around it stays out of reach. Once dealt with it's gone for good, until the
 * i in the sheet's header plays it again. Every other test's devices start
 * with the tips seen (fixtures.ts); these ask for a device without.
 *
 * The overlay marks its spotlight, arrow and card with data-coach, so where
 * each is drawn can be checked against what it points at: on a phone, and
 * on a laptop, where the app is a column in the middle of the window.
 */

import { devices, type Locator, type Page } from '@playwright/test';

import {
  ancestor,
  back,
  button,
  closeSplit,
  createGroup,
  expenseForm,
  goToGroup,
  groupHeader,
  makeAccount,
  openGroup,
  openSplit,
  sheet,
  skipTour,
} from '../src/actions';
import type { Api } from '../src/api';
import { TIPS_SEEN, expect, test, type Person, type PersonOptions } from '../src/fixtures';

/** The tip on Add expense, and the tour in the sheet, by what a screen reader calls them. */
const intro = (page: Page) => page.getByRole('dialog', { name: 'Tip', exact: true });
const guide = (page: Page) => page.getByRole('dialog', { name: 'How splitting works', exact: true });
/** The overlay's parts, as drawn. The spotlight is there once a step is placed. */
const coach = (page: Page, part: 'spotlight' | 'halo' | 'arrow' | 'card') => page.locator(`[data-coach="${part}"]`);

const tip = {
  next: (page: Page) => page.getByRole('button', { name: 'Next tip', exact: true }),
  back: (page: Page) => page.getByRole('button', { name: 'Previous tip', exact: true }),
  skip: (page: Page) => page.getByRole('button', { name: 'Skip the guide', exact: true }),
  gotIt: (page: Page) => page.getByRole('button', { name: 'Got it', exact: true }),
};

/** The tour on step `n` of 5, titled `title`, placed and pointing. */
async function onStep(page: Page, n: number, title: string) {
  await expect(guide(page).getByText(`${n} of 5`, { exact: true })).toBeVisible();
  await expect(guide(page).getByText(title, { exact: true })).toBeVisible();
  await expect(coach(page, 'spotlight')).toBeVisible();
}

/** What the device keeps of the tips it has seen. */
const kept = (page: Page) => page.evaluate(() => localStorage.getItem('sattle.tips'));

/** The app's step in the browser's history (backNavigation.ts): one per screen in, and one per overlay up. */
const depth = (page: Page) => page.evaluate(() => (history.state as { sattleDepth?: number } | null)?.sattleDepth ?? 0);

const sheetTitle = (page: Page) => page.getByText('Who paid, how to split', { exact: true });

/** Yash in Goa with Riya and Kabir, on the group screen, on a phone that hasn't seen the tips. */
async function newcomer(person: (name: string, opts?: PersonOptions) => Promise<Person>, opts: PersonOptions = {}) {
  const seed = async (api: Api) => {
    await api.seedGroup({ name: 'Goa', people: ['Riya', 'Kabir'] });
  };
  const yash = await person('Yash', { tips: false, seed, ...opts });
  await openGroup(yash.page, 'Goa');
  return yash;
}

async function openForm(page: Page) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
}

test.describe('the tip on Add expense', () => {
  test('shows over the split card the first time, without the keyboard, and Show me opens the tour', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(intro(page).getByText('Someone not in this one?', { exact: true })).toBeVisible();
    await expect(intro(page).getByText(/^New expenses are split equally between everyone\./)).toBeVisible();
    await expect(coach(page, 'spotlight')).toBeVisible();
    // The keyboard would cover what it points at.
    await expect(expenseForm.amount(page)).not.toBeFocused();
    // Nothing else on the form can be reached past it.
    await page.getByRole('button', { name: 'Close without saving' }).click({ force: true });
    await expect(expenseForm.description(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close without saving' }).click({ timeout: 1_500 })).rejects.toThrow(
      /intercepts pointer events/
    );

    await button(page, 'Show me').click();
    await expect(intro(page)).toHaveCount(0);
    await expect(sheetTitle(page)).toBeVisible();
    await onStep(page, 1, 'Who paid?');
    await expect(guide(page).getByText('It’s you unless you tap someone else.')).toBeVisible();
    expect(JSON.parse((await kept(page))!)).toEqual({ splitIntro: true });
  });

  test('Not now leaves the tour for the first time the sheet opens, and the amount ready to type', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    await button(page, 'Not now').click();
    await expect(intro(page)).toHaveCount(0);
    await expect(expenseForm.amount(page)).toBeFocused();
    await expenseForm.amount(page).fill('900');
    await openSplit(page);
    await onStep(page, 1, 'Who paid?');
  });

  test('a tap on the card through the spotlight is Show me', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    await button(page, 'Split differently').click();
    await expect(sheetTitle(page)).toBeVisible();
    await onStep(page, 1, 'Who paid?');
  });

  test('isn’t shown changing an expense, where the tour waits for the sheet', async ({ person }) => {
    const seed = async (api: Api) => {
      await api.seedGroup({ name: 'Goa', people: ['Riya'], spends: [{ description: 'Dinner', amount: 60_000, paidBy: 'Yash' }] });
    };
    const { page } = await person('Yash', { tips: false, seed });
    await openGroup(page, 'Goa');
    await page.getByText('Dinner', { exact: true }).click();
    await expect(page.getByText('Edit expense in', { exact: true })).toBeVisible();
    await expect(intro(page)).toHaveCount(0);
    await openSplit(page);
    await onStep(page, 1, 'Who paid?');
    await expect(guide(page).getByText('Tap whoever paid it.')).toBeVisible();
    // Skipping the tour is done with both: a new expense has no tip pointing at the sheet.
    await tip.skip(page).click();
    await expect(guide(page)).toHaveCount(0);
    expect(await kept(page)).toBe(TIPS_SEEN);
    await closeSplit(page);
    await back(page);
    await expect(groupHeader(page)).toBeVisible();
    await openForm(page);
    await expect(intro(page)).toHaveCount(0);
    await expect(expenseForm.amount(page)).toBeFocused();
  });

  test('on a phone’s very first run, comes after the first-launch tour', async ({ device }) => {
    const { page } = await device({ toured: false, tips: false });
    await page.goto('/');
    await makeAccount(page, 'Yash', { toured: false });
    await skipTour(page);
    await createGroup(page, { name: 'Goa', people: ['Riya'], simplifyDebts: false });
    await openForm(page);
    await expect(intro(page).getByText('Someone not in this one?', { exact: true })).toBeVisible();
  });
});

test.describe('the tour of Who paid, how to split', () => {
  test('leaving someone out goes through the spotlight, and the card says what it did', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await button(page, 'Not now').click();
    await expenseForm.amount(page).fill('900');
    await openSplit(page);
    await onStep(page, 1, 'Who paid?');
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await expect(guide(page).getByText(/^Tap a person to leave them out of this spend\./)).toBeVisible();

    // Riya, the first who isn't Yash, is in the spotlight, and a tap there reaches her.
    const riya = expenseForm.between(page, 'Riya');
    await riya.click();
    await expect(riya).toHaveAttribute('aria-checked', 'false');
    await expect(sheet(page).getByText('Not in this', { exact: true })).toBeVisible();
    await expect(guide(page).getByText('Riya is out of this one.', { exact: true })).toBeVisible();
    // ₹900 between the two left.
    await expect(sheet(page).getByText('₹450', { exact: true })).toHaveCount(2);
    await riya.click();
    await expect(riya).toHaveAttribute('aria-checked', 'true');
    await expect(guide(page).getByText('Riya is back in.', { exact: true })).toBeVisible();
    await expect(sheet(page).getByText('Not in this', { exact: true })).toHaveCount(0);

    // Kabir is outside it: a tap there lands on the dim and changes nothing.
    const kabir = expenseForm.between(page, 'Kabir');
    await expect(kabir.click({ timeout: 1_500 })).rejects.toThrow(/intercepts pointer events/);
    await kabir.click({ force: true });
    await expect(kabir).toHaveAttribute('aria-checked', 'true');

    // Out again, and through to the end: she stays out, and the form says so.
    await riya.click();
    await expect(guide(page).getByText('Riya is out of this one.', { exact: true })).toBeVisible();
    await tip.next(page).click();
    await onStep(page, 3, 'Not an even split?');
    await expect(guide(page).getByText('Riya is out of this one.')).toHaveCount(0);
    await tip.next(page).click();
    await tip.next(page).click();
    await onStep(page, 5, 'All set');
    await tip.gotIt(page).click();
    await expect(guide(page)).toHaveCount(0);
    await button(page, 'Done').click();
    await expect(sheetTitle(page)).toBeHidden();
    await expect(page.getByText('Split equally between 2', { exact: true })).toBeVisible();
  });

  test('Next and Back walk the five steps, and Got it ends it for good', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await button(page, 'Show me').click();
    await onStep(page, 1, 'Who paid?');
    await expect(tip.back(page)).toHaveCount(0);
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await tip.back(page).click();
    await onStep(page, 1, 'Who paid?');
    await tip.next(page).click();
    await tip.next(page).click();
    await onStep(page, 3, 'Not an even split?');
    await expect(guide(page).getByText('Type what each person owes.')).toBeVisible();
    await expect(guide(page).getByText('Had twice as much? Give them 2.')).toBeVisible();
    await expect(guide(page).getByText('Each person’s share of 100%.')).toBeVisible();
    await tip.next(page).click();
    await onStep(page, 4, 'An itemised bill?');
    await tip.next(page).click();
    await onStep(page, 5, 'All set');
    await expect(tip.next(page)).toHaveCount(0);
    await expect(tip.skip(page)).toBeVisible();
    await tip.back(page).click();
    await onStep(page, 4, 'An itemised bill?');
    await tip.next(page).click();
    await tip.gotIt(page).click();
    await expect(guide(page)).toHaveCount(0);
    // Over, and the sheet is still up to use.
    await expect(sheetTitle(page)).toBeVisible();
    expect(await kept(page)).toBe(TIPS_SEEN);

    // Never again, after a reload either.
    await page.reload();
    await openGroup(page, 'Goa');
    await openForm(page);
    await expect(intro(page)).toHaveCount(0);
    await expect(expenseForm.amount(page)).toBeFocused();
    await openSplit(page);
    await expect(guide(page)).toHaveCount(0);
  });

  test('Skip ends it on any step, and it’s remembered', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await button(page, 'Not now').click();
    await openSplit(page);
    await onStep(page, 1, 'Who paid?');
    await tip.next(page).click();
    await tip.next(page).click();
    await onStep(page, 3, 'Not an even split?');
    await tip.skip(page).click();
    await expect(guide(page)).toHaveCount(0);
    await expect(sheetTitle(page)).toBeVisible();
    expect(await kept(page)).toBe(TIPS_SEEN);
    await page.reload();
    await goToGroup(page, 'Goa');
    await openForm(page);
    await openSplit(page);
    await expect(guide(page)).toHaveCount(0);
  });

  test('the back button and Escape end the tour before they close the sheet', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    // Groups, the group, the form, and the tip over it.
    await expect.poll(() => depth(page)).toBe(3);
    // The tip first, which is Not now: the form stays, with the amount ready.
    await page.goBack();
    await expect(intro(page)).toHaveCount(0);
    await expect(expenseForm.description(page)).toBeVisible();
    await expect(expenseForm.amount(page)).toBeFocused();
    await expect.poll(() => depth(page)).toBe(2);

    await openSplit(page);
    await onStep(page, 1, 'Who paid?');
    await expect.poll(() => depth(page)).toBe(4);
    await page.goBack();
    await expect(guide(page)).toHaveCount(0);
    await expect(sheetTitle(page)).toBeVisible();
    await expect.poll(() => depth(page)).toBe(3);
    await page.goBack();
    await expect(sheetTitle(page)).toBeHidden();
    await expect(expenseForm.description(page)).toBeVisible();

    // Escape, the same: the tour, played again from the sheet, goes before the sheet does.
    await openSplit(page);
    await page.getByRole('button', { name: 'How splitting works' }).click();
    await onStep(page, 1, 'Who paid?');
    await page.keyboard.press('Escape');
    await expect(guide(page)).toHaveCount(0);
    await expect(sheetTitle(page)).toBeVisible();
  });

  test('the i beside Done plays it again, on a device that has seen it', async ({ person }) => {
    const seed = async (api: Api) => {
      await api.seedGroup({ name: 'Goa', people: ['Riya', 'Kabir'] });
    };
    const { page } = await person('Yash', { seed });
    await openGroup(page, 'Goa');
    await openForm(page);
    await expect(intro(page)).toHaveCount(0);
    await openSplit(page);
    await expect(guide(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'How splitting works' }).click();
    await onStep(page, 1, 'Who paid?');
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await tip.skip(page).click();
    await expect(guide(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'How splitting works' }).click();
    await onStep(page, 1, 'Who paid?');
  });
});

/** Boxes, as drawn, and the checks that say the overlay points at `target`. */
async function expectPointingAt(page: Page, target: Locator) {
  const [spot, card, arrow, thing] = await Promise.all(
    [coach(page, 'spotlight'), coach(page, 'card'), coach(page, 'arrow'), target].map(async (l) => (await l.boundingBox())!)
  );
  // The spotlight is around the thing.
  expect(spot.x).toBeLessThanOrEqual(thing.x);
  expect(spot.y).toBeLessThanOrEqual(thing.y);
  expect(spot.x + spot.width).toBeGreaterThanOrEqual(thing.x + thing.width);
  expect(spot.y + spot.height).toBeGreaterThanOrEqual(thing.y + thing.height);
  // The card doesn't cover it.
  const apart = card.y >= spot.y + spot.height || card.y + card.height <= spot.y;
  expect(apart, `card ${JSON.stringify(card)} and spotlight ${JSON.stringify(spot)}`).toBe(true);
  // The arrow runs between them, and lands under (or over) the spotlight.
  if (card.y >= spot.y + spot.height) {
    expect(arrow.y).toBeGreaterThanOrEqual(spot.y + spot.height - 1);
    expect(arrow.y + arrow.height).toBeLessThanOrEqual(card.y + 1);
  } else {
    expect(arrow.y).toBeGreaterThanOrEqual(card.y + card.height - 1);
    expect(arrow.y + arrow.height).toBeLessThanOrEqual(spot.y + 1);
  }
  expect(arrow.x).toBeLessThan(spot.x + spot.width);
  expect(arrow.x + arrow.width).toBeGreaterThan(spot.x);
  return { spot, card, arrow, thing };
}

/** The card with Split differently in it: card > link > its words. */
const splitCard = (page: Page) => ancestor(page.getByText('Split differently', { exact: true }), 2);
/** Split differently itself: link > its words. */
const splitLink = (page: Page) => ancestor(page.getByText('Split differently', { exact: true }), 1);
/** A person's row in the sheet: row > the toggle with their name. */
const personRow = (page: Page, name: string) => ancestor(expenseForm.between(page, name), 1);
/** Paid by and its chips, in the sheet: the label and chips > chips > Yash. */
const paidBy = (page: Page) => ancestor(expenseForm.paidBy(page, 'Yash'), 2);

test.describe('where it’s drawn', () => {
  test('on a phone, the spotlight is round what each step is about and the card is clear of it', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    await expect(coach(page, 'halo')).toHaveCount(1);
    await expectPointingAt(page, splitCard(page));
    await button(page, 'Show me').click();
    await onStep(page, 1, 'Who paid?');
    await expectPointingAt(page, paidBy(page));
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await expectPointingAt(page, personRow(page, 'Riya'));
    await tip.next(page).click();
    await onStep(page, 3, 'Not an even split?');
    await expectPointingAt(page, sheet(page).getByRole('radiogroup'));
    await tip.next(page).click();
    await onStep(page, 4, 'An itemised bill?');
    await expectPointingAt(page, button(sheet(page), 'Split by item'));
    await tip.next(page).click();
    await onStep(page, 5, 'All set');
    await expectPointingAt(page, button(sheet(page), 'Done'));
  });
});

test.describe('where it’s drawn on a small phone', () => {
  // Short enough that the whole split card can't be lit with room for the tip. The expense form has
  // the whole screen, with no tab bar under it, so it's shorter than the phones that used to do it.
  test.use({ viewport: { width: 360, height: 580 } });

  test('with no room beside the whole split card, the tip lights Split differently alone', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    const { spot } = await expectPointingAt(page, splitLink(page));
    const card = (await splitCard(page).boundingBox())!;
    expect(spot.height).toBeLessThan(card.height);
    // It's still Show me, through the spotlight.
    await button(page, 'Split differently').click();
    await onStep(page, 1, 'Who paid?');
  });
});

test.describe('with Reduce Motion on', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('nothing pulses or draws itself in, and it all works the same', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    await expect(coach(page, 'halo')).toHaveCount(0);
    // The arrow is there whole from the start: its dash has nothing left to draw.
    await expect(coach(page, 'arrow').locator('path').first()).toHaveAttribute('stroke-dashoffset', '0');
    await button(page, 'Show me').click();
    await onStep(page, 1, 'Who paid?');
    await expect(coach(page, 'halo')).toHaveCount(0);
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await expenseForm.between(page, 'Riya').click();
    await expect(guide(page).getByText('Riya is out of this one.', { exact: true })).toBeVisible();
  });
});

// The browser is the same; only in a describe the device's browser type can't be named again.
const { defaultBrowserType: _sameBrowser, ...laptop } = devices['Desktop Chrome'];

test.describe('where it’s drawn on a laptop', () => {
  test.use({ ...laptop, viewport: { width: 1400, height: 900 } });

  test('the app’s column is in the middle of the window, and the spotlight is still on the thing', async ({ person }) => {
    const { page } = await newcomer(person);
    await openForm(page);
    await expect(coach(page, 'spotlight')).toBeVisible();
    const { thing, card } = await expectPointingAt(page, splitCard(page));
    // Off the window's left edge, as the column is: the overlay knows where it is.
    expect(thing.x).toBeGreaterThan(300);
    expect(card.x).toBeGreaterThan(300);
    expect(card.x + card.width).toBeLessThan(1400 - 300);
    await button(page, 'Show me').click();
    await onStep(page, 1, 'Who paid?');
    await tip.next(page).click();
    await onStep(page, 2, 'Not in this one?');
    await expectPointingAt(page, personRow(page, 'Riya'));
    await expenseForm.between(page, 'Riya').click();
    await expect(guide(page).getByText('Riya is out of this one.', { exact: true })).toBeVisible();
  });
});
