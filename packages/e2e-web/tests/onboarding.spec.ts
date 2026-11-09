/**
 * First launch, in a browser: the first screen, which makes an account from a
 * name and asks which currencies they use, rupees ticked; the UPI step after
 * it for someone who ticked rupees; the three-screen tour once they're in;
 * what rupees alone keeps out of the way; the two ways back into an account
 * that already exists (a sign-in key, a Nostr key), and restoring a group
 * from its backup key with no account at all. Those three wait under Other
 * ways to sign in, whatever is ticked.
 */

import type { Page } from '@playwright/test';

import {
  UPI_STEP,
  WELCOME,
  back,
  button,
  currencyBox,
  makeAccount,
  pressable,
  section,
  tab,
  tickCurrencies,
} from '../src/actions';
import { expect, test } from '../src/fixtures';

/** The Pressable around a label. A disabled button is drawn at 0.4 opacity; nothing else marks it. */

const HEX64 = 'ab'.repeat(32);

test.describe('the first screen', () => {
  test('asks a name and the currencies, rupees ticked, with no tour before it and no Skip', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await expect(page.getByText('Hi there.')).toBeVisible();
    await expect(page.getByText(WELCOME)).toBeVisible();
    await expect(page.getByText('And the currencies you use')).toBeVisible();
    await expect(page.getByText('₹ · INR', { exact: true })).toBeVisible();
    await expect(page.getByText('₿ · BTC', { exact: true })).toBeVisible();
    await expect(currencyBox(page, 'INR')).toBeChecked();
    await expect(currencyBox(page, 'BTC')).not.toBeChecked();
    await expect(button(page, 'Skip')).toHaveCount(0);
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });

  test('takes both currencies or either, never none', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await currencyBox(page, 'BTC').click();
    await expect(currencyBox(page, 'BTC')).toBeChecked();
    await expect(currencyBox(page, 'INR')).toBeChecked();
    await currencyBox(page, 'INR').click();
    await expect(currencyBox(page, 'INR')).not.toBeChecked();

    // The last one can't go: the chip is disabled, and a tap on it does nothing.
    await expect(currencyBox(page, 'BTC')).toHaveAttribute('aria-disabled', 'true');
    await currencyBox(page, 'BTC').click({ force: true });
    await expect(currencyBox(page, 'BTC')).toBeChecked();
  });

  test('Continue does nothing without a name, and says whose it is once there is one', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await expect(pressable(page, 'Continue')).toHaveCSS('opacity', '0.4');
    await button(page, 'Continue').click({ force: true });
    await expect(page.getByText(WELCOME)).toBeVisible();

    const field = page.getByPlaceholder('Your name');
    await field.fill('   ');
    await expect(pressable(page, 'Continue')).toHaveCSS('opacity', '0.4');
    await button(page, 'Continue').click({ force: true });
    await expect(page.getByText(WELCOME)).toBeVisible();
    await expect(page.getByText(UPI_STEP)).toHaveCount(0);

    await field.fill('Y');
    await expect(pressable(page, 'Continue as Y')).toHaveCSS('opacity', '1');
    // Enter only puts the keyboard away: the currencies are part of the answer.
    await field.press('Enter');
    await expect(page.getByText(WELCOME)).toBeVisible();
    // The browser is told it's a name, so it can offer the one it knows.
    expect(await field.getAttribute('autocomplete')).toBe('name');
  });

  test('a name is all it takes, and the device stays signed in', async ({ device, api }) => {
    const { page } = await device();
    await page.goto('/');
    await makeAccount(page, 'Yash');
    await expect(page.getByText('Nothing to settle yet.', { exact: false })).toBeVisible();

    const token = await page.evaluate(() => localStorage.getItem('sattle.token'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await api.as(token).me()).displayName).toBe('Yash');

    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
  });

  test('the name is cut at 40 characters and trimmed', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    const field = page.getByPlaceholder('Your name');
    await field.pressSequentially('abcdefghij'.repeat(4) + 'XXXXX');
    await expect(field).toHaveValue('abcdefghij'.repeat(4));
    expect(await field.getAttribute('maxlength')).toBe('40');

    await makeAccount(page, '   Yash Gandhi   ');
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

  test('what was ticked is kept, and Account shows it', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await makeAccount(page, 'Sats', { currencies: ['BTC'] });
    await page.reload();
    await tab(page, 'Account');
    await expect(currencyBox(page, 'INR')).not.toBeChecked();
    await expect(currencyBox(page, 'BTC')).toBeChecked();
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

  test('the ways back in show whatever is ticked: someone reaching for them is getting back in', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await expect(currencyBox(page, 'BTC')).not.toBeChecked();
    await button(page, 'Other ways to sign in').click();
    for (const way of ['I have a sign-in key', 'Sign in with Nostr', 'Restore a group from its backup key']) {
      await expect(button(page, way)).toBeVisible();
    }
  });

  test('signing in keeps the chips only if they were touched; untouched, the device shows both', async ({ api, device }) => {
    const { token } = await api.account('Back');
    const signIn = async (page: Page) => {
      await button(page, 'Other ways to sign in').click();
      await button(page, 'I have a sign-in key').click();
      await page.getByPlaceholder('sattle-signin:…').fill(token);
      await button(page, 'Sign in').click();
      await expect(page.getByText('What are you splitting?')).toBeVisible();
    };

    // Straight to the key: the default rupees aren't a choice anyone made.
    const untouched = await device();
    await untouched.page.goto('/');
    await signIn(untouched.page);
    expect(await untouched.page.evaluate(() => localStorage.getItem('sattle.currencies'))).toBeNull();
    await tab(untouched.page, 'Account');
    await expect(currencyBox(untouched.page, 'INR')).toBeChecked();
    await expect(currencyBox(untouched.page, 'BTC')).toBeChecked();

    // Bitcoin alone, ticked first: that's kept.
    const picked = await device();
    await picked.page.goto('/');
    await tickCurrencies(picked.page, ['BTC']);
    await signIn(picked.page);
    await tab(picked.page, 'Account');
    await expect(currencyBox(picked.page, 'INR')).not.toBeChecked();
    await expect(currencyBox(picked.page, 'BTC')).toBeChecked();
  });
});

test.describe('the UPI step', () => {
  test('comes next for rupees, and Skip leaves it to Wallet, answering the groups list’s question too', async ({
    device,
  }) => {
    const { page } = await device({ getPaidDone: false });
    await page.goto('/');
    await page.getByPlaceholder('Your name').fill('Yash');
    await button(page, 'Continue as Yash').click();

    await expect(page.getByText(UPI_STEP)).toBeVisible();
    await expect(page.getByText('Add your UPI ID.', { exact: true })).toBeVisible();
    await expect(page.getByText('Shown to people who owe you, and on your group links.')).toBeVisible();
    await expect(pressable(page, 'Save')).toHaveCSS('opacity', '0.4');

    await button(page, 'Skip').click();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText('How should people pay you?')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('sattle.getPaidDone'))).toBe('1');

    // Asked once: a reload opens on the groups.
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText(UPI_STEP)).toHaveCount(0);
  });

  test('saves the UPI ID, and Wallet has it', async ({ device, api }) => {
    const { page } = await device();
    await page.goto('/');
    await page.getByPlaceholder('Your name').fill('Yash');
    await button(page, 'Continue as Yash').click();
    await page.getByPlaceholder('name@okhdfcbank').fill('Yash@OkHdfcBank');
    await button(page, 'Save').click();

    await expect(page.getByText('What are you splitting?')).toBeVisible();
    const token = await page.evaluate(() => localStorage.getItem('sattle.token'));
    expect(await api.as(token).get('/me/upi')).toEqual({ upiId: 'yash@okhdfcbank', onGroupLinks: true });
    await tab(page, 'Wallet');
    await expect(section(page, 'UPI').getByText('yash@okhdfcbank', { exact: true })).toBeVisible();
  });

  test('warns about a phone number in the ID, and saves it anyway', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await page.getByPlaceholder('Your name').fill('Yash');
    await button(page, 'Continue as Yash').click();
    await page.getByPlaceholder('name@okhdfcbank').fill('9876543210@ybl');
    await expect(page.getByText('This UPI ID has a phone number in it')).toBeVisible();
    await button(page, 'Save anyway').click();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
  });

  test('isn’t asked of someone who ticked bitcoin alone', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await page.getByPlaceholder('Your name').fill('Sats');
    await tickCurrencies(page, ['BTC']);
    await button(page, 'Continue as Sats').click();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText(UPI_STEP)).toHaveCount(0);
  });
});

test.describe('the tour', () => {
  test('comes once they’re in, and walks three steps, with Back from the second and Continue on the last', async ({
    device,
  }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await makeAccount(page, 'Yash', { toured: false });

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
    // Both currencies were ticked, so both ways show.
    await expect(page.getByText('Bitcoin, over Lightning')).toBeVisible();
    await expect(page.getByText('UPI', { exact: true })).toBeVisible();
    await expect(page.getByText('Cash, or anything else')).toBeVisible();

    await button(page, 'Continue').click();
    await expect(page.getByText('What are you splitting?')).toBeVisible();

    // Finishing is remembered.
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });

  test('with rupees alone, settling up leaves Lightning out', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await makeAccount(page, 'Yash', { currencies: ['INR'], toured: false });
    await button(page, 'Next').click();
    await button(page, 'Next').click();
    await expect(page.getByText('Settle up your way')).toBeVisible();
    await expect(page.getByText('UPI', { exact: true })).toBeVisible();
    await expect(page.getByText('Bitcoin, over Lightning')).toHaveCount(0);
    await expect(page.getByText(/To get paid yourself, add a UPI ID under Wallet\.$/)).toBeVisible();
  });

  test('skipping is remembered too', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await makeAccount(page, 'Yash', { toured: false });
    await button(page, 'Next').click();
    await button(page, 'Skip').click();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    await page.reload();
    await expect(page.getByText('What are you splitting?')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sattle.toured'))).toBe('1');
  });

  test('a reload halfway through starts the tour over', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/');
    await makeAccount(page, 'Yash', { toured: false });
    await button(page, 'Next').click();
    await expect(page.getByText('Only one of you needs the app')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Split bills without the maths')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Step 1 of 3' })).toBeVisible();
  });
});

test.describe('rupees alone', () => {
  test('keeps Lightning and Nostr out of the way, and ticking bitcoin under Account brings them back', async ({
    device,
  }) => {
    const { page } = await device();
    await page.goto('/');
    await makeAccount(page, 'Yash', { currencies: ['INR'] });

    await tab(page, 'Wallet');
    await expect(page.getByText('Get paid by UPI')).toBeVisible();
    await expect(page.getByText('Your own wallet', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Lightning address', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/or a Nostr key linked there/)).toHaveCount(0);

    await tab(page, 'Account');
    await expect(page.getByText('Sign in with Nostr', { exact: true })).toHaveCount(0);
    await currencyBox(page, 'BTC').click();
    await expect(section(page, 'Sign in with Nostr').getByPlaceholder('bunker://…')).toBeVisible();
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
    await expect(page.getByText(WELCOME)).toBeVisible();
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
    // An account that already exists isn't asked its UPI ID: that's Wallet's, if it has one.
    await expect(page.getByText(UPI_STEP)).toHaveCount(0);
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
    await expect(page.getByText('What are you splitting?')).toBeVisible();
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
    await expect(page.getByText(WELCOME)).toBeVisible();
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
    await expect(page.getByText(WELCOME)).toBeVisible();
  });

  test('/restore opens it on a brand-new device with no tour first', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/restore');
    await expect(page.getByText('Restore a group', { exact: true })).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
    await back(page);
    await expect(page).toHaveURL(/\/$/);
    // Back is the app at /: the first screen. The tour waits until there's an account.
    await expect(page.getByText(WELCOME)).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });
});
