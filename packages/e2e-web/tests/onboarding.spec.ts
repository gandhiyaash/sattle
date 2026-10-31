/**
 * First launch, in a browser: the three-screen tour, the welcome screen that
 * makes an account from a name, the two ways back into an account that
 * already exists (a sign-in key, a Nostr key), and restoring a group from its
 * backup key with no account at all. Those three wait under Other ways to
 * sign in.
 */

import { ancestor, back, button, makeAccount, pressable, skipTour, tab } from '../src/actions';
import { expect, test } from '../src/fixtures';

/** The Pressable around a label. A disabled button is drawn at 0.4 opacity; nothing else marks it. */

const HEX64 = 'ab'.repeat(32);

test.describe('the tour', () => {
  test('walks three steps, with Back from the second and Continue on the last', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');

    await expect(page.getByText('Split bills without the maths')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Step 1 of 3' })).toBeVisible();
    await expect(button(page, 'Skip')).toBeVisible();
    await expect(page.getByText('‹', { exact: true })).toHaveCount(0);
    // The example split: ₹3,000 between three, you paid ₹2,400, Riya ₹600.
    await expect(page.getByText('Kabir owes you')).toBeVisible();
    await expect(page.getByText('₹1,000', { exact: true })).toBeVisible();
    await expect(page.getByText('₹400', { exact: true })).toBeVisible();

    await button(page, 'Next').click();
    await expect(page.getByText('Only one of you needs the app')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Step 2 of 3' })).toBeVisible();
    await expect(page.getByText('‹', { exact: true })).toBeVisible();
    await expect(page.getByText('No app', { exact: true })).toHaveCount(2);

    await back(page);
    await expect(page.getByText('Split bills without the maths')).toBeVisible();
    await button(page, 'Next').click();
    await button(page, 'Next').click();

    await expect(page.getByText('Settle up your way')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Step 3 of 3' })).toBeVisible();
    await expect(button(page, 'Skip')).toHaveCount(0);
    await expect(button(page, 'Next')).toHaveCount(0);
    await expect(page.getByText('Bitcoin, over Lightning')).toBeVisible();
    await expect(page.getByText('Cash, or anything else')).toBeVisible();

    await button(page, 'Continue').click();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();

    // Finishing is remembered.
    await page.reload();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });

  test('skipping is remembered too', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await button(page, 'Next').click();
    await button(page, 'Skip').click();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    await page.reload();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sattle.toured'))).toBe('1');
  });

  test('a reload halfway through starts the tour over', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await button(page, 'Next').click();
    await expect(page.getByText('Only one of you needs the app')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Split bills without the maths')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Step 1 of 3' })).toBeVisible();
  });

  test('a device that has seen it goes straight to welcome', async ({ device }) => {
    const { page } = await device({ toured: true });
    await page.goto('/');
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });
});

test.describe('welcome', () => {
  test('a name is all it takes, and the device stays signed in', async ({ device, api }) => {
    const { page } = await device();
    await page.goto('/');
    await expect(page.getByText('Split bills in sats. Only one of you needs the app.')).toBeVisible();
    await makeAccount(page, 'Yash');
    await expect(page.getByText('Add one to a group and what you owe or are owed shows here.')).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('sattle.token'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await api.as(token).me()).displayName).toBe('Yash');

    await page.reload();
    await expect(page.getByText('No groups yet')).toBeVisible();
  });

  test('Get started does nothing without a name', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await expect(pressable(page, 'Get started')).toHaveCSS('opacity', '0.4');
    await button(page, 'Get started').click();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();

    await page.getByPlaceholder('Your name').fill('   ');
    await expect(pressable(page, 'Get started')).toHaveCSS('opacity', '0.4');
    await button(page, 'Get started').click();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    await expect(page.getByText('No groups yet')).toHaveCount(0);

    await page.getByPlaceholder('Your name').fill('Y');
    await expect(pressable(page, 'Get started')).toHaveCSS('opacity', '1');
  });

  test('the name is cut at 40 characters and trimmed', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    const field = page.getByPlaceholder('Your name');
    await field.pressSequentially('abcdefghij'.repeat(4) + 'XXXXX');
    await expect(field).toHaveValue('abcdefghij'.repeat(4));
    expect(await field.getAttribute('maxlength')).toBe('40');

    await field.fill('   Yash Gandhi   ');
    await button(page, 'Get started').click();
    await expect(page.getByText('No groups yet')).toBeVisible();
    await tab(page, 'Account');
    await expect(page.getByText('Signed in as')).toBeVisible();
    await expect(page.getByText('Yash Gandhi', { exact: true })).toBeVisible();
  });

  test('a name made of symbols is shown as typed', async ({ device, api }) => {
    const { page } = await device();
    await page.goto('/');
    const name = '<b>Zoë</b> 🚀 "O\'Brien"';
    await makeAccount(page, name);
    await tab(page, 'Account');
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    // Rendered as text, not as markup.
    expect(await page.locator('b').count()).toBe(0);
    const token = await page.evaluate(() => localStorage.getItem('sattle.token'));
    expect((await api.as(token).me()).displayName).toBe(name);
  });

  test('the ways in to an account or a group from elsewhere wait under Other ways to sign in', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    const others = pressable(page, 'Other ways to sign in');
    const ways = ['I have a sign-in key', 'Sign in with Nostr', 'Restore a group from its backup key'];
    await expect(others).toHaveAttribute('aria-expanded', 'false');
    for (const way of ways) await expect(button(page, way)).toHaveCount(0);

    await button(page, 'Other ways to sign in').click();
    await expect(others).toHaveAttribute('aria-expanded', 'true');
    for (const way of ways) await expect(button(page, way)).toBeVisible();

    // Back from one of them finds them still showing.
    await button(page, 'Sign in with Nostr').click();
    await back(page);
    await expect(button(page, 'I have a sign-in key')).toBeVisible();

    await button(page, 'Other ways to sign in').click();
    for (const way of ways) await expect(button(page, way)).toHaveCount(0);
  });
});

test.describe('I have a sign-in key', () => {
  test('refuses what isn’t a key, and a key no account has', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await button(page, 'Other ways to sign in').click();
    await button(page, 'I have a sign-in key').click();
    await expect(page.getByText('Sign in with your key')).toBeVisible();
    await expect(pressable(page, 'Sign in')).toHaveCSS('opacity', '0.4');

    const field = page.getByPlaceholder('sattle-signin:…');
    expect(await field.getAttribute('type')).toBe('password');
    await field.fill('hello there');
    await button(page, 'Sign in').click();
    await expect(page.getByText('That isn’t a sign-in key. It starts with sattle-signin:')).toBeVisible();

    await field.fill(`sattle-signin:${'A'.repeat(43)}`);
    await button(page, 'Sign in').click();
    await expect(page.getByText('No account has that key. It may have been deleted.')).toBeVisible();
    // Nothing was kept for a key that didn't sign in.
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();

    await back(page);
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
  });

  test('the key copied from Account signs a second device in as the same person', async ({ person, device }) => {
    const owner = await person('Owner');
    await owner.api.seedGroup({ name: 'Owner’s flat', people: ['Mo'] });
    await tab(owner.page, 'Account');
    await button(owner.page, 'Copy sign-in key').click();
    const shown = owner.page.getByText(/^sattle-signin:[A-Za-z0-9_-]{43}$/);
    await expect(shown).toBeVisible();
    const key = (await shown.textContent())!.trim();
    expect(key).toBe(`sattle-signin:${owner.token}`);

    const { page } = await device();
    await page.goto('/');
    await button(page, 'Other ways to sign in').click();
    await button(page, 'I have a sign-in key').click();
    await page.getByPlaceholder('sattle-signin:…').fill(key);
    await button(page, 'Sign in').click();
    await expect(page.getByText('Owner’s flat')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBe(owner.token);

    // Both devices are the same account: a group made on one shows on the other.
    await page.reload();
    await expect(page.getByText('Owner’s flat')).toBeVisible();
    await tab(page, 'Account');
    await expect(page.getByText('Owner', { exact: true })).toBeVisible();
  });

  test('the bare token works too, with spaces around it and Enter to submit', async ({ api, device }) => {
    const { token } = await api.account('Bare');
    const { page } = await device();
    await page.goto('/');
    await button(page, 'Other ways to sign in').click();
    await button(page, 'I have a sign-in key').click();
    await page.getByPlaceholder('sattle-signin:…').fill(`  ${token}  `);
    await page.getByPlaceholder('sattle-signin:…').press('Enter');
    await expect(page.getByText('No groups yet')).toBeVisible();
  });
});

test.describe('Sign in with Nostr', () => {
  test('offers a bunker link, and nothing from an extension this browser hasn’t got', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await button(page, 'Other ways to sign in').click();
    await button(page, 'Sign in with Nostr').click();
    await expect(page.getByText('If you linked a Nostr key under Account, signing in with it opens your account here, with all your groups.')).toBeVisible();
    await expect(page.getByText('Paste a bunker link from your signer')).toBeVisible();
    await expect(page.getByText(/Use my Nostr extension/)).toHaveCount(0);
    await expect(pressable(page, 'Connect and sign in')).toHaveCSS('opacity', '0.4');
    await page.getByPlaceholder('bunker://…').fill('bunker://abc');
    await expect(pressable(page, 'Connect and sign in')).toHaveCSS('opacity', '1');
    await back(page);
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
  });
});

test.describe('Restore a group from its backup key', () => {
  test('from welcome: reads the key before asking any relay, and Back returns', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await button(page, 'Other ways to sign in').click();
    await button(page, 'Restore a group from its backup key').click();
    await expect(page.getByText('Restore a group', { exact: true })).toBeVisible();
    await expect(page.getByText('From its backup key, straight off Nostr')).toBeVisible();
    await expect(pressable(page, 'Read it from the relays')).toHaveCSS('opacity', '0.4');

    const field = page.getByPlaceholder('sattle-ledger://…');
    await field.fill('not a key');
    await expect(pressable(page, 'Read it from the relays')).toHaveCSS('opacity', '1');
    await button(page, 'Read it from the relays').click();
    await expect(page.getByText('That isn’t a ledger backup key. It starts with sattle-ledger://')).toBeVisible();

    await field.fill(`sattle-ledger://${HEX64}?key=short`);
    await button(page, 'Read it from the relays').click();
    await expect(page.getByText('The backup key’s group key is missing or malformed.')).toBeVisible();

    await field.fill(`sattle-ledger://${HEX64}?key=${'cd'.repeat(32)}`);
    await button(page, 'Read it from the relays').click();
    await expect(page.getByText('This key doesn’t say which relays the group is on.')).toBeVisible();

    await back(page);
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
  });

  test('/restore opens it on a brand-new device with no tour first', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/restore');
    await expect(page.getByText('Restore a group', { exact: true })).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
    await back(page);
    await expect(page).toHaveURL(/\/$/);
    // Back is the app at /, which on this device has the tour still to show.
    await expect(page.getByText('Split bills without the maths')).toBeVisible();
  });
});
