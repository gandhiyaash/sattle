/**
 * Account and Wallet: who you are signed in as and the key that proves it,
 * which currencies you use and what that hides, deleting the account; the
 * ways to get paid (a wallet connection, a Lightning address, a UPI ID) with
 * everything each one refuses; appearance; the FAQ and the trust disclosure.
 */

import type { Page } from '@playwright/test';

import { ancestor, button, confirm, groupTab, openGroup, pressable, section, tab } from '../src/actions';
import { ApiRefusal } from '../src/api';
import { expect, test } from '../src/fixtures';

/** The Pressable around a label: it carries aria-disabled, and a disabled one is drawn at 0.4 opacity. */

const RUPEES = 'Rupees. Keep bills in rupees and settle up by UPI.';
const BITCOIN = 'Bitcoin. Keep bills in sats and settle up over Lightning.';

/** Every background colour drawn inside the app, for telling light from dark. */
const backgrounds = (page: Page) =>
  page.evaluate(() => [...new Set([...document.querySelectorAll('#root *')].map((e) => getComputedStyle(e).backgroundColor))]);

test.describe('Account', () => {
  test('shows who you are and copies the sign-in key', async ({ person }) => {
    const { page, token } = await person('Yash');
    await tab(page, 'Account');
    await expect(page.getByText('Signed in as')).toBeVisible();
    await expect(page.getByText('Yash', { exact: true })).toBeVisible();
    await expect(page.getByText(/^sattle-signin:/)).toHaveCount(0);

    await button(page, 'Copy sign-in key').click();
    await expect(page.getByText('Copied.', { exact: true })).toBeVisible();
    await expect(page.getByText(`sattle-signin:${token}`, { exact: true })).toBeVisible();
    await page.bringToFront();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`sattle-signin:${token}`);
  });

  test('replacing the key signs every other device out and keeps this one in', async ({ person, device, api }) => {
    const { page, token: old } = await person('Yash');
    const other = await device({ token: old });
    await other.page.goto('/');
    await expect(other.page.getByText('What are you splitting?')).toBeVisible();

    await tab(page, 'Account');
    await confirm(page, 'Replace sign-in key', 'Yes, sign out my other devices');
    await expect(page.getByText(/^Done\. The old key and every device signed in with it are signed out\./)).toBeVisible();
    const shown = page.getByText(/^sattle-signin:[A-Za-z0-9_-]{43}$/);
    await expect(shown).toBeVisible();
    const fresh = (await shown.textContent())!.trim().slice('sattle-signin:'.length);
    expect(fresh).not.toBe(old);
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBe(fresh);

    await expect(api.as(old).me()).rejects.toMatchObject({ status: 401 });
    expect((await api.as(fresh).me()).displayName).toBe('Yash');

    // The other device is signed out the next time it asks; this one keeps going.
    await other.page.reload();
    await expect(other.page.getByText('What should your friends call you?')).toBeVisible();
    expect(await other.page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
  });

  test('turning a currency off hides what goes with it, and the last one stays on', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Account');
    const rupees = page.getByRole('checkbox', { name: RUPEES });
    const bitcoin = page.getByRole('checkbox', { name: BITCOIN });
    await expect(rupees).toBeChecked();
    await expect(bitcoin).toBeChecked();
    await expect(page.getByText('New groups start in')).toBeVisible();
    await expect(page.getByText(/^You pick the currency for each new group\./)).toBeVisible();

    // Deleting the account would forget a wallet connection only while bitcoin is in use.
    await expect(page.getByText(/^This ends your account for good\. Your wallet connection is forgotten, the links you sent stop working/)).toBeVisible();
    await bitcoin.click();
    await expect(bitcoin).not.toBeChecked();
    await expect(page.getByText(/^This ends your account for good\. The links you sent stop working/)).toBeVisible();
    await expect(page.getByText('New groups start in')).toHaveCount(0);
    await expect(page.getByText('Your groups are in rupees and settled by UPI. Sattle keeps everything to do with Bitcoin out of your way.')).toBeVisible();

    // The last one can't go: the row is disabled, and a tap on it does nothing.
    await expect(rupees).toHaveAttribute('aria-disabled', 'true');
    await rupees.click({ force: true });
    await expect(rupees).toBeChecked();
    await expect(bitcoin).not.toBeChecked();

    await tab(page, 'Wallet');
    await expect(page.getByText('Get paid by UPI')).toBeVisible();
    await expect(page.getByText('Your own wallet', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Or a Lightning address', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Lightning address', { exact: true })).toHaveCount(0);
    await expect(page.getByText('UPI', { exact: true })).toBeVisible();
    await expect(page.getByText('Your wallet connection')).toHaveCount(0);

    await tab(page, 'Groups');
    await button(page, 'New group').click();
    await expect(page.getByPlaceholder('Name your group')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Kept in / })).toHaveCount(0);

    // Kept on the device.
    await page.reload();
    await tab(page, 'Account');
    await expect(page.getByRole('checkbox', { name: BITCOIN })).not.toBeChecked();
    await page.getByRole('checkbox', { name: BITCOIN }).click();
    await expect(page.getByText('New groups start in')).toBeVisible();
    await page.getByRole('radio', { name: 'Bitcoin', exact: true }).click();
    await tab(page, 'Groups');
    await button(page, 'New group').click();
    await expect(page.getByRole('button', { name: 'Kept in Bitcoin. Change' })).toBeVisible();
  });

  test('someone who uses bitcoin alone sees no UPI anywhere on Wallet', async ({ person }) => {
    const { page } = await person('Sats', { currencies: ['BTC'] });
    await tab(page, 'Wallet');
    await expect(page.getByText('Use the wallet you already have')).toBeVisible();
    await expect(page.getByText('UPI', { exact: true })).toHaveCount(0);
    await expect(page.getByPlaceholder('name@okhdfcbank')).toHaveCount(0);
    await expect(page.getByText('Your own wallet', { exact: true })).toBeVisible();
    await tab(page, 'Account');
    await expect(page.getByText('Your groups are in sats and settled over Lightning. Sattle keeps UPI out of your way.')).toBeVisible();
  });

  test('offers to link a Nostr key, through a bunker link', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Account');
    const card = section(page, 'Sign in with Nostr');
    await expect(card.getByText(/^Link your Nostr key, and signing in with it opens this account on any device/)).toBeVisible();
    await expect(card.getByText('Sattle never sees your private key: your signer signs a one-time check.')).toBeVisible();
    await expect(card.getByPlaceholder('bunker://…')).toBeVisible();
    await expect(pressable(card, 'Connect and link it')).toHaveCSS('opacity', '0.4');
    await expect(page.getByText('Unlink this key')).toHaveCount(0);
  });

  test('deleting the account ends it, takes a solo group with it, and leaves a ghost in a shared one', async ({ person, api }) => {
    const anu = await person('Anu');
    const bob = await person('Bob');
    const { group } = await anu.api.seedGroup({
      name: 'Shared flat',
      people: ['Bob'],
      spends: [{ description: 'Rent', amount: 200_000, paidBy: 'Anu' }],
    });
    const link = await anu.api.createGroupLink(group.id);
    const ref = (await api.joinView(link.token)).members.find((m) => m.name === 'Bob')!.ref;
    await bob.api.join(link.token, { ref });
    const solo = await bob.api.createGroup({ name: 'Bob alone', memberNames: ['Nobody'] });
    const soloLink = await bob.api.createGroupLink(solo.id);
    expect((await api.groupGuestView(soloLink.token)).groupName).toBe('Bob alone');

    // The list was drawn before the group was made, so it is read again.
    await anu.page.reload();
    await openGroup(anu.page, 'Shared flat');
    await groupTab(anu.page, 'Members');
    await expect(anu.page.getByText('Bob', { exact: true })).toBeVisible();
    await expect(ancestor(anu.page.getByText('Bob', { exact: true }), 2).getByText('Joined', { exact: true })).toBeVisible();

    await tab(bob.page, 'Account');
    await expect(bob.page.getByText(/^This ends your account for good\./)).toBeVisible();
    await confirm(bob.page, 'Delete my account', 'Yes, delete my account');
    await expect(bob.page.getByText('What should your friends call you?')).toBeVisible();
    expect(await bob.page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();
    await expect(bob.api.me()).rejects.toMatchObject({ status: 401 });

    // The group only Bob could open is gone, link and all.
    await expect(api.groupGuestView(soloLink.token)).rejects.toMatchObject({ status: 404 });

    // In the shared group his name and balance stay, as a ghost, within the screen's own refresh.
    const row = ancestor(anu.page.getByText('Bob', { exact: true }), 2);
    await expect(row.getByText('Hasn’t joined · pays from links')).toBeVisible({ timeout: 15_000 });
    await expect(anu.page.getByText('In this group · 2')).toBeVisible();
    const members = await anu.api.members(group.id);
    expect(members.find((m) => m.displayName === 'Bob')).toMatchObject({ status: 'ghost' });
    expect(members.find((m) => m.displayName === 'Bob')!.claimedByUserId).toBeUndefined();
    expect((await anu.api.debts(group.id))[0]).toMatchObject({ amount: 100_000 });

    // Deleting twice can't happen: the old token is nobody.
    const again = await api.raw('DELETE', '/me', undefined, { token: bob.token });
    expect(again.status).toBe(401);
  });
});

test.describe('Wallet', () => {
  test('says what it is for, and what you are trusting', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Wallet');
    await expect(page.getByText('Use the wallet you already have')).toBeVisible();
    await expect(page.getByText(/^Sattle doesn’t hold money\. Connect your own Lightning wallet below/)).toBeVisible();
    await expect(page.getByText("What you're trusting")).toBeVisible();
    for (const row of [
      'Your money',
      'Your wallet connection',
      'Your Lightning address',
      'The relay in between',
      'Your account',
      'Your currencies',
      'Is it really paid?',
      'Your group data',
      'Who can see what',
      'Joining',
      'The exchange rate',
    ]) {
      await expect(page.getByText(row, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/not end-to-end encrypted/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Privacy policy' })).toBeVisible();
  });

  test('a wallet connection string is checked before anything is kept', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Wallet');
    const card = section(page, 'Your own wallet');
    await expect(card.getByText(/^Already have a Lightning wallet\? Connect it with Nostr Wallet Connect/)).toBeVisible();
    await expect(pressable(card, 'Connect')).toHaveCSS('opacity', '0.4');
    const field = card.getByPlaceholder('nostr+walletconnect://…');
    expect(await field.getAttribute('type')).toBe('password');

    await field.fill('https://example.com/not-a-wallet');
    await button(card, 'Connect').click();
    await expect(card.getByText(/must start with "nostr\+walletconnect:\/\/"/)).toBeVisible();

    await field.fill('nostr+walletconnect://abc?relay=wss://x&secret=def');
    await button(card, 'Connect').click();
    await expect(card.getByText('That isn’t a wallet connection string: the wallet key is missing or malformed.')).toBeVisible();

    await field.fill(`nostr+walletconnect://${'ab'.repeat(32)}?secret=${'cd'.repeat(32)}`);
    await button(card, 'Connect').click();
    await expect(card.getByText('That isn’t a wallet connection string: it names no relay.')).toBeVisible();

    // Well formed, but the relay is a port nothing listens on: the wallet never answers.
    await field.fill(`nostr+walletconnect://${'ab'.repeat(32)}?relay=wss%3A%2F%2F127.0.0.1%3A1&secret=${'cd'.repeat(32)}`);
    await button(card, 'Connect').click();
    await expect(card.getByText(/^Your wallet (didn’t answer\. Check it’s online, then try again\.|refused the connection)/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.getByText(/^Connected to/)).toHaveCount(0);
  });

  test('a Lightning address is checked, kept, changed and removed', async ({ person, api }) => {
    const { page, token } = await person('Yash');
    await tab(page, 'Wallet');
    const card = section(page, 'Or a Lightning address');
    await expect(card.getByText(/^Wallet of Satoshi, Phoenix, Blink and most other wallets give you a Lightning address/)).toBeVisible();
    await expect(pressable(card, 'Save')).toHaveCSS('opacity', '0.4');
    const field = card.getByPlaceholder('you@walletofsatoshi.com');

    await field.fill('nope');
    await button(card, 'Save').click();
    await expect(card.getByText('That doesn’t look like a Lightning address. It should look like name@wallet.com.')).toBeVisible();

    await field.fill('lnbc10n1pjexampleinvoice');
    await button(card, 'Save').click();
    await expect(card.getByText("That's an invoice, which only works once. Ask for their Lightning address instead — it looks like an email.")).toBeVisible();

    await field.fill('LNURL1DP68GURN8GHJ7');
    await button(card, 'Save').click();
    await expect(card.getByText('LNURL codes aren’t supported yet. Ask for the address that looks like an email.')).toBeVisible();

    await field.fill('  Yash@WalletOfSatoshi.com ');
    await button(card, 'Save').click();
    await expect(card.getByText('You receive at')).toBeVisible();
    await expect(card.getByText('yash@walletofsatoshi.com', { exact: true })).toBeVisible();
    await expect(card.getByText(/^In every group\. If you also connect a wallet above, that’s used first\./)).toBeVisible();
    expect(await api.as(token).get<{ address: string | null }>('/me/receive-address')).toEqual({ address: 'yash@walletofsatoshi.com' });

    await button(card, 'Change address').click();
    await expect(card.getByPlaceholder('you@walletofsatoshi.com')).toBeVisible();
    await button(card, 'Cancel').click();
    await expect(card.getByPlaceholder('you@walletofsatoshi.com')).toHaveCount(0);
    await expect(card.getByText('yash@walletofsatoshi.com', { exact: true })).toBeVisible();

    await button(card, 'Stop receiving here').click();
    await expect(card.getByText('You receive at')).toHaveCount(0);
    await expect(card.getByText(/^Wallet of Satoshi, Phoenix, Blink/)).toBeVisible();
    expect(await api.as(token).get<{ address: string | null }>('/me/receive-address')).toEqual({ address: null });
  });

  test('a UPI ID is checked, warned about, kept, shown on links or not, changed and removed', async ({ person, api }) => {
    const { page, token } = await person('Yash');
    await tab(page, 'Wallet');
    const card = section(page, 'UPI');
    await expect(card.getByText(/^Add your UPI ID and people who owe you in a rupee group can pay you from GPay, PhonePe or any UPI app/)).toBeVisible();
    await expect(pressable(card, 'Save')).toHaveCSS('opacity', '0.4');
    const field = card.getByPlaceholder('name@okhdfcbank');

    await field.fill('nope');
    await button(card, 'Save').click();
    await expect(card.getByText('That doesn’t look like a UPI ID. It should look like name@okhdfcbank or 98xxxxxx10@ybl.')).toBeVisible();

    await field.fill('name@gmail.com');
    await button(card, 'Save').click();
    await expect(card.getByText('That looks like an email or a Lightning address. A UPI ID looks like name@okhdfcbank or 98xxxxxx10@ybl.')).toBeVisible();

    // A phone number as the ID: warned about, saved anyway on request.
    await field.fill('9876543210@ybl');
    await expect(card.getByText('This UPI ID has a phone number in it')).toBeVisible();
    await expect(card.getByText(/All of them would see the number\./)).toBeVisible();
    await expect(button(card, 'Save anyway')).toBeVisible();
    await expect(button(card, 'Save')).toHaveCount(0);

    await field.fill('Yash@OkHdfcBank');
    await expect(card.getByText('This UPI ID has a phone number in it')).toHaveCount(0);
    await button(card, 'Save').click();
    await expect(card.getByText('You can be paid at')).toBeVisible();
    await expect(card.getByText('yash@okhdfcbank', { exact: true })).toBeVisible();
    await expect(card.getByText('On shared group links')).toBeVisible();
    await expect(card.getByText(/^On\. Someone paying from a group’s shared link, without the app, can pay you by UPI\./)).toBeVisible();
    expect(await api.as(token).get('/me/upi')).toEqual({ upiId: 'yash@okhdfcbank', onGroupLinks: true });

    await button(card, 'Turn off for shared links').click();
    await expect(card.getByText(/^Off\. Someone paying from a group’s shared link, without the app, can’t pay you by UPI\./)).toBeVisible();
    await expect(button(card, 'Let shared links show it')).toBeVisible();
    expect(await api.as(token).get('/me/upi')).toEqual({ upiId: 'yash@okhdfcbank', onGroupLinks: false });
    await button(card, 'Let shared links show it').click();
    await expect(button(card, 'Turn off for shared links')).toBeVisible();

    await button(card, 'Change UPI ID').click();
    await expect(card.getByPlaceholder('name@okhdfcbank')).toBeVisible();
    await button(card, 'Cancel').click();
    await expect(card.getByPlaceholder('name@okhdfcbank')).toHaveCount(0);

    await button(card, 'Change UPI ID').click();
    await card.getByPlaceholder('name@okhdfcbank').fill('9876543210@ybl');
    await button(card, 'Save anyway').click();
    await expect(card.getByText('9876543210@ybl', { exact: true })).toBeVisible();
    // Saved with a number in it, the shared-link switch carries the warning too.
    await expect(card.getByText('This UPI ID has a phone number in it')).toBeVisible();

    await button(card, 'Remove it').click();
    await expect(card.getByText('You can be paid at')).toHaveCount(0);
    await expect(card.getByText(/^Add your UPI ID and people who owe you/)).toBeVisible();
    expect(await api.as(token).get('/me/upi')).toEqual({ upiId: null, onGroupLinks: true });
  });

  test('appearance follows the choice, and the choice is kept', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Wallet');
    const dark = 'rgb(12, 16, 24)';
    const light = 'rgb(245, 247, 250)';
    await expect(page.getByRole('radio', { name: 'System', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(await backgrounds(page)).toContain(light);

    await page.getByRole('radio', { name: 'Dark', exact: true }).click();
    await expect.poll(() => backgrounds(page)).toContain(dark);
    expect(await backgrounds(page)).not.toContain(light);
    expect(await page.evaluate(() => localStorage.getItem('sattle.appearance'))).toBe('dark');

    await page.reload();
    await expect(page.getByText('Groups', { exact: true }).first()).toBeVisible();
    await expect.poll(() => backgrounds(page)).toContain(dark);
    await tab(page, 'Wallet');
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('radio', { name: 'Light', exact: true }).click();
    await expect.poll(() => backgrounds(page)).toContain(light);
    await page.emulateMedia({ colorScheme: 'dark' });
    // Light is light whatever the phone says.
    await expect.poll(() => backgrounds(page)).toContain(light);
    expect(await backgrounds(page)).not.toContain(dark);

    await page.getByRole('radio', { name: 'System', exact: true }).click();
    await expect.poll(() => backgrounds(page)).toContain(dark);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => backgrounds(page)).toContain(light);
    expect(await page.evaluate(() => localStorage.getItem('sattle.appearance'))).toBe('system');
  });
});

test.describe('FAQ', () => {
  test('answers open and close, and the sections follow the ways you use', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Wallet');
    await button(page, 'FAQ').click();
    await expect(page.getByText('FAQ', { exact: true }).first()).toBeVisible();
    for (const label of ['Lightning', 'UPI', 'Groups and your account']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Every answer says what Sattle does today. If that changes, this changes with it.')).toBeVisible();

    const question = page.getByRole('button', { name: /^How does paying by UPI work\?/ });
    await expect(question).toHaveAttribute('aria-expanded', 'false');
    const answer = page.getByText(/^The person you owe adds their UPI ID on the Wallet screen\./);
    await expect(answer).toHaveCount(0);
    await question.click();
    await expect(question).toHaveAttribute('aria-expanded', 'true');
    await expect(answer).toBeVisible();
    await expect(page.getByText(/No bank or UPI app tells anyone else that one person paid another/)).toBeVisible();
    await question.click();
    await expect(question).toHaveAttribute('aria-expanded', 'false');
    await expect(answer).toHaveCount(0);

    // Two open at once stay open independently.
    await page.getByRole('button', { name: /^What is a payment proof\?/ }).click();
    await page.getByRole('button', { name: /^What if I lose this phone\?/ }).click();
    await expect(page.getByText(/called the preimage: 64 letters and digits/)).toBeVisible();
    await expect(page.getByText(/Copy sign-in key gives it to you/)).toBeVisible();
    await expect(page.getByText(/pay a debt over Lightning or by UPI, or mark it as paid/)).toHaveCount(0);
    await page.getByRole('button', { name: /^What can someone with the group’s link do\?/ }).click();
    await expect(page.getByText(/can pay a debt over Lightning or by UPI, or mark it as paid if they paid another way/)).toBeVisible();

    await page.getByText('‹', { exact: true }).click();
    await expect(page.getByText('Wallet', { exact: true }).first()).toBeVisible();
  });

  test('someone who uses rupees alone gets no Lightning questions, and the rest in UPI’s words', async ({ person }) => {
    const { page } = await person('Rupee', { currencies: ['INR'] });
    await tab(page, 'Wallet');
    await button(page, 'FAQ').click();
    await expect(page.getByText('UPI', { exact: true })).toBeVisible();
    await expect(page.getByText('Groups and your account', { exact: true })).toBeVisible();
    await expect(page.getByText('Lightning', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^How do I get paid over Lightning\?/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^What can someone with the group’s link do\?/ }).click();
    await expect(
      page.getByText(
        /can pay a debt by UPI, or mark it as paid if they paid another way, like cash\. They can’t add or change anything, and a payment they say they made counts only once/
      )
    ).toBeVisible();
  });
});
