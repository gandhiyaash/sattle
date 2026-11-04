/**
 * Where to be paid, asked once at launch: a sheet over the groups list for
 * someone with no Lightning address, UPI ID or wallet yet, that takes a
 * Lightning address for bitcoin and a UPI ID for rupees, either or both, or
 * is skipped. Whatever they do with it, the device doesn't ask again, and an
 * account that has somewhere already isn't looked up again either.
 *
 * Every other test's device is already done with it (DeviceOptions.getPaidDone).
 */

import type { Page } from '@playwright/test';

import { back, button, closeSheet, makeAccount, pressable, section, sheet, tab } from '../src/actions';
import type { Api } from '../src/api';
import { API_URL } from '../src/env';
import { expect, test } from '../src/fixtures';
import { groupLinkToken } from '../src/links.helpers';

const TITLE = 'How should people pay you?';
const ADDRESS = 'you@walletofsatoshi.com';
const UPI = 'name@okhdfcbank';

/** What the question looks up. Nothing else on the groups list asks for these. */
const SETTINGS = ['/me/wallet', '/me/receive-address', '/me/upi'];

const isSetting = (url: string) => {
  const u = new URL(url);
  return u.origin === API_URL && SETTINGS.includes(u.pathname);
};

/** Each of those the page asks for, from now on. */
function watchSettings(page: Page): string[] {
  const asked: string[] = [];
  page.on('request', (r) => {
    if (isSetting(r.url())) asked.push(new URL(r.url()).pathname);
  });
  return asked;
}

/** Resolves once the page has had all three answers, and a moment to act on them. Start it before the page loads. */
function answered(page: Page): Promise<void> {
  const each = SETTINGS.map((path) => page.waitForResponse((r) => isSetting(r.url()) && new URL(r.url()).pathname === path));
  // A sheet that was coming is up within a frame of the last answer; this gives it many. Waiting
  // can only let a test that says it never came miss a sheet that came late, not fail a right one.
  return Promise.all(each).then(() => page.waitForTimeout(500));
}

const doneOnDevice = (page: Page) => page.evaluate(() => localStorage.getItem('sattle.getPaidDone'));

/** Our entries in the browser's history above the one the app opened on (backNavigation). */
const historyDepth = (page: Page) =>
  page.evaluate(() => (history.state as { sattleDepth?: number } | null)?.sattleDepth ?? 0);

/** A group of Riya's, with Kabir not joined, and its link's token. */
async function riyasGroup(api: Api) {
  const riya = api.as((await api.account('Riya')).token);
  const { group } = await riya.seedGroup({ name: 'Goa trip', people: ['Kabir'] });
  return groupLinkToken(riya, group.id);
}

test.describe('asked where to be paid', () => {
  test('a new account is asked over the groups list, and Skip is an answer for good', async ({ device }) => {
    const { page } = await device({ getPaidDone: false });
    await page.goto('/');
    await makeAccount(page, 'Yash');

    const ask = sheet(page);
    await expect(ask.getByText(TITLE)).toBeVisible();
    await expect(
      ask.getByText(/^Add a Lightning address to be paid in bitcoin, a UPI ID to be paid in rupees, or both\./)
    ).toBeVisible();
    await expect(ask.getByText('Lightning address · bitcoin', { exact: true })).toBeVisible();
    await expect(ask.getByText('UPI ID · rupees', { exact: true })).toBeVisible();
    await expect(ask.getByPlaceholder(ADDRESS)).toBeVisible();
    await expect(ask.getByPlaceholder(UPI)).toBeVisible();
    await expect(ask.getByText('Wallet of Satoshi, Blink and most other wallets give you one. It looks like an email.')).toBeVisible();
    // The UPI ID's reach is said before it's saved, since shared links show it from the start.
    await expect(ask.getByText(/so does anyone holding one of your groups’ shared links/)).toBeVisible();
    // Only those two: connecting a wallet is left to Wallet.
    await expect(ask.getByText(/connect|nostr/i)).toHaveCount(0);
    await expect(ask.getByText('You won’t be asked again. You can add or change these under Wallet.')).toBeVisible();
    await expect(pressable(ask, 'Save')).toHaveCSS('opacity', '0.4');

    await button(ask, 'Skip').click();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await doneOnDevice(page)).toBe('1');

    // The next launch doesn't even look.
    const looked = watchSettings(page);
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(looked).toEqual([]);
  });

  test('a Lightning address and a UPI ID are saved together, and Wallet has both', async ({ person }) => {
    const { page, api } = await person('Yash', { getPaidDone: false });
    const ask = sheet(page);
    await expect(ask.getByText(TITLE)).toBeVisible();
    // Enter in the address goes on to the UPI ID and saves nothing yet; Enter there saves both.
    const sent = watchSettings(page);
    await ask.getByPlaceholder(ADDRESS).fill('  Yash@WalletOfSatoshi.com ');
    await ask.getByPlaceholder(ADDRESS).press('Enter');
    await expect(ask.getByPlaceholder(UPI)).toBeFocused();
    await expect(ask.getByText(TITLE)).toBeVisible();
    expect(sent).toEqual([]);
    await ask.getByPlaceholder(UPI).fill('Yash@OkHdfcBank');
    await ask.getByPlaceholder(UPI).press('Enter');

    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await api.get('/me/receive-address')).toEqual({ address: 'yash@walletofsatoshi.com' });
    expect(await api.get('/me/upi')).toEqual({ upiId: 'yash@okhdfcbank', onGroupLinks: true });
    expect(await doneOnDevice(page)).toBe('1');

    await tab(page, 'Wallet');
    await expect(section(page, 'Or a Lightning address').getByText('yash@walletofsatoshi.com', { exact: true })).toBeVisible();
    await expect(section(page, 'UPI').getByText('yash@okhdfcbank', { exact: true })).toBeVisible();
  });

  test('what the server refuses stays to fix, what it took shows as saved, and Save sends only the rest', async ({
    person,
  }) => {
    const { page, api } = await person('Yash', { getPaidDone: false });
    const ask = sheet(page);
    await ask.getByPlaceholder(ADDRESS).fill('nope');
    await ask.getByPlaceholder(UPI).fill('yash@okhdfcbank');
    await button(ask, 'Save').click();

    await expect(ask.getByText('That doesn’t look like a Lightning address. It should look like name@wallet.com.')).toBeVisible();
    await expect(ask.getByPlaceholder(ADDRESS)).toHaveValue('nope');
    await expect(ask.getByPlaceholder(UPI)).toHaveCount(0);
    await expect(ask.getByText('yash@okhdfcbank', { exact: true })).toBeVisible();
    expect(await api.get('/me/upi')).toMatchObject({ upiId: 'yash@okhdfcbank' });
    // Something is saved, so leaving now isn't skipping.
    await expect(button(ask, 'Skip')).toHaveCount(0);
    await expect(button(ask, 'Done')).toBeVisible();

    // Typing again clears the refusal.
    await ask.getByPlaceholder(ADDRESS).fill('yash@walletofsatoshi.com');
    await expect(ask.getByText(/^That doesn’t look like a Lightning address/)).toHaveCount(0);
    const sent = watchSettings(page);
    await button(ask, 'Save').click();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await api.get('/me/receive-address')).toEqual({ address: 'yash@walletofsatoshi.com' });
    expect(sent).toEqual(['/me/receive-address']);
  });

  test('a UPI ID with a phone number in it is warned about, and saved anyway on request', async ({ person }) => {
    const { page, api } = await person('Yash', { getPaidDone: false });
    const ask = sheet(page);
    await ask.getByPlaceholder(UPI).fill('9876543210@ybl');
    await expect(ask.getByText('This UPI ID has a phone number in it')).toBeVisible();
    await expect(ask.getByText(/^Everyone shown it would see the number\./)).toBeVisible();
    await expect(button(ask, 'Save anyway')).toBeVisible();
    await expect(button(ask, 'Save')).toHaveCount(0);

    await ask.getByPlaceholder(UPI).fill('yash@okhdfcbank');
    await expect(ask.getByText('This UPI ID has a phone number in it')).toHaveCount(0);
    await ask.getByPlaceholder(UPI).fill('9876543210@ybl');
    await ask.getByPlaceholder(ADDRESS).fill('nope');
    await button(ask, 'Save anyway').click();

    // The ID went in, so the warning goes with its field, and Done leaves the refused address unsaved.
    await expect(ask.getByText('9876543210@ybl', { exact: true })).toBeVisible();
    await expect(ask.getByText('This UPI ID has a phone number in it')).toHaveCount(0);
    await expect(button(ask, 'Save')).toBeVisible();
    await button(ask, 'Done').click();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await api.get('/me/upi')).toMatchObject({ upiId: '9876543210@ybl' });
    expect(await api.get('/me/receive-address')).toEqual({ address: null });
    expect(await doneOnDevice(page)).toBe('1');
  });

  test('only what goes with the currencies they use is asked for, and tapping outside is an answer too', async ({
    person,
  }) => {
    const rupees = await person('Asha', { getPaidDone: false, currencies: ['INR'] });
    const upiOnly = sheet(rupees.page);
    await expect(upiOnly.getByText(TITLE)).toBeVisible();
    await expect(
      upiOnly.getByText('Add your UPI ID, and people who owe you pay you there, straight from GPay, PhonePe or any UPI app.')
    ).toBeVisible();
    await expect(upiOnly.getByText('UPI ID', { exact: true })).toBeVisible();
    await expect(upiOnly.getByPlaceholder(UPI)).toBeVisible();
    await expect(upiOnly.getByPlaceholder(ADDRESS)).toHaveCount(0);
    await expect(upiOnly.getByText(/lightning|bitcoin/i)).toHaveCount(0);
    await expect(upiOnly.getByText('You won’t be asked again. You can add or change it under Wallet.')).toBeVisible();
    await closeSheet(rupees.page);
    expect(await doneOnDevice(rupees.page)).toBe('1');

    const sats = await person('Ben', { getPaidDone: false, currencies: ['BTC'] });
    const lightningOnly = sheet(sats.page);
    await expect(lightningOnly.getByText(TITLE)).toBeVisible();
    await expect(
      lightningOnly.getByText('Add your Lightning address, and people who owe you pay you there, straight from their own wallet.')
    ).toBeVisible();
    await expect(lightningOnly.getByText('Lightning address', { exact: true })).toBeVisible();
    await expect(lightningOnly.getByPlaceholder(ADDRESS)).toBeVisible();
    await expect(lightningOnly.getByPlaceholder(UPI)).toHaveCount(0);
    await expect(lightningOnly.getByText(/upi|rupee/i)).toHaveCount(0);
  });

  test('an account with somewhere to be paid already isn’t asked, and the device doesn’t look again', async ({
    api,
    device,
  }) => {
    const { token } = await api.account('Yash');
    const yash = api.as(token);
    await yash.setUpiId('yash@okhdfcbank');
    const { page } = await device({ token, getPaidDone: false });

    const settled = answered(page);
    await page.goto('/');
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await settled;
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await doneOnDevice(page)).toBe('1');

    // Removing the ID later doesn't bring the question back.
    await yash.del('/me/upi');
    const looked = watchSettings(page);
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(looked).toEqual([]);
  });

  test('shared links turned off for an earlier UPI ID stay off, and the sheet says so', async ({ api, device }) => {
    const { token } = await api.account('Yash');
    const yash = api.as(token);
    await yash.setUpiId('old@okhdfcbank');
    await yash.setUpiOnGroupLinks(false);
    await yash.del('/me/upi');
    const { page } = await device({ token, getPaidDone: false });
    await page.goto('/');

    const ask = sheet(page);
    await expect(ask.getByText(TITLE)).toBeVisible();
    await expect(
      ask.getByText('People who owe you see it. A group’s shared link shows it only if you turned that on for the group.')
    ).toBeVisible();
    await expect(ask.getByText(/anyone holding one of your groups’ shared links/)).toHaveCount(0);
    await ask.getByPlaceholder(UPI).fill('yash@okhdfcbank');
    await button(ask, 'Save').click();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(await yash.get('/me/upi')).toEqual({ upiId: 'yash@okhdfcbank', onGroupLinks: false });
  });

  test('an account opened by a link goes where it leads, and is asked at the next launch instead', async ({
    api,
    device,
  }) => {
    const link = await riyasGroup(api);
    const { token } = await api.account('Yash');
    const { page } = await device({ token, getPaidDone: false });

    const looked = watchSettings(page);
    await page.goto(`/join/${link}`);
    await expect(page.getByText('Who are you?')).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);

    // Back without joining: the groups list, and still not this time. Nothing was even looked up.
    await back(page);
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    expect(looked).toEqual([]);

    await page.reload();
    await expect(sheet(page).getByText(TITLE)).toBeVisible();
  });

  test('someone who makes their account by joining from a link is asked once they’re in', async ({ api, device }) => {
    const link = await riyasGroup(api);
    const { page } = await device({ getPaidDone: false });
    await page.goto(`/join/${link}`);
    await page.getByText('I’m not on this list').click();
    await page.getByPlaceholder('Your name').fill('Asha');
    await button(page, 'Join as Asha').click();

    await expect(page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(sheet(page).getByText(TITLE)).toBeVisible();
  });

  test('in a browser, the sheet takes the back button once the page has had a tap', async ({ api, device }) => {
    const { token } = await api.account('Yash');
    const { page } = await device({ token, getPaidDone: false });
    // Read through DevTools until the tap: Playwright's own evaluating, its waiting included, counts as a tap.
    const cdp = await page.context().newCDPSession(page);
    const read = async (expression: string) =>
      (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value as unknown;
    await page.goto('/');
    await expect.poll(() => read(`document.body.innerText.includes(${JSON.stringify(TITLE)})`)).toBe(true);
    // Up with no tap, it adds nothing to the history: Chrome's back button would pass over an entry added then.
    await new Promise((settle) => setTimeout(settle, 500));
    expect(await read('navigator.userActivation.hasBeenActive')).toBe(false);
    expect(await read('history.state?.sattleDepth ?? 0')).toBe(0);

    await sheet(page).getByPlaceholder(UPI).click();
    await expect.poll(() => historyDepth(page)).toBe(1);
    await page.goBack();
    await expect(page.getByText(TITLE)).toHaveCount(0);
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    expect(await doneOnDevice(page)).toBe('1');
  });
});
