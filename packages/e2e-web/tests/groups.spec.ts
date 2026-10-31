/**
 * Groups: making one, what the groups list says about them, who is in them,
 * managing them, and a group kept in bitcoin.
 */

import {
  addExpense,
  ancestor,
  back,
  button,
  confirm,
  createGroup,
  debtCard,
  expectDisabled,
  expenseForm,
  goToGroup,
  groupHeader,
  groupTab,
  inviteLink,
  keptIn,
  memberLine,
  closePeople,
  joinAs,
  memberRow,
  openGroup,
  openManage,
  saveExpense,
  section,
} from '../src/actions';
import { expect, test } from '../src/fixtures';

test.describe('New group', () => {
  test('refuses a group with no name', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    await button(page, 'Create and share the link').click();
    await expect(page.getByText('Give the group a name.')).toBeVisible();
    await expect(page.getByPlaceholder('Name your group')).toBeVisible();
  });

  test('trims the name, and takes whoever is typed but not yet added', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await page.getByPlaceholder('Name your group').fill('   Goa trip   ');
    await page.getByPlaceholder('Add a name').fill('Priya');
    await page.getByPlaceholder('Add a name').press('Enter');
    await expect(page.getByText('Priya', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Add a name').fill('   ');
    await page.getByPlaceholder('Add a name').press('Enter');
    await page.getByPlaceholder('Add a name').fill('Aman');
    await expect(page.getByText('3 people', { exact: true })).toBeVisible();
    await button(page, 'Create and share the link').click();
    await closePeople(page);
    await expect(memberLine(page, 'You, Priya, Aman')).toBeVisible();
    const [group] = await yash.api.groups();
    expect(group.name).toBe('Goa trip');
    expect((await yash.api.members(group.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Aman']);
  });

  test('the cover takes its colour and letter from the name as it’s typed', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    await expect(page.getByText('Just you', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Name your group').fill('Goa trip');
    await expect(page.getByText('G', { exact: true })).toBeVisible();
    // coverFor('Goa trip') is the red cover.
    await expect(ancestor(page.getByText('New group', { exact: true }), 2)).toHaveCSS('background-color', 'rgb(155, 35, 53)');
    await page.getByPlaceholder('Add a name').fill('Priya');
    await button(page, 'Add').click();
    await expect(page.getByText('2 people', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Priya', exact: true }).click();
    await expect(page.getByText('Just you', { exact: true })).toBeVisible();
  });

  test('Enter goes from the name to the people, and adds each one, staying for the next', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    const add = page.getByPlaceholder('Add a name');
    await page.getByPlaceholder('Name your group').fill('Goa trip');
    await page.getByPlaceholder('Name your group').press('Enter');
    await expect(add).toBeFocused();
    await add.fill('Priya');
    await add.press('Enter');
    await expect(page.getByText('Priya', { exact: true })).toBeVisible();
    await expect(add).toHaveValue('');
    await expect(add).toBeFocused();
    // Enter on an empty field is "done": nothing is added.
    await add.press('Enter');
    await expect(page.getByText('2 people', { exact: true })).toBeVisible();
  });

  test('says what each currency means, and keeps the one picked', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await expect(page.getByRole('button', { name: 'Kept in Rupees. Change' })).toBeVisible();
    await expect(
      page.getByText('Amounts are in rupees, and people settle up by UPI or over Lightning. This can’t be changed later.')
    ).toBeVisible();
    await keptIn(page, 'Bitcoin');
    await expect(page.getByText('Bitcoin, in sats', { exact: true })).toBeVisible();
    await expect(page.getByText('Amounts are in sats, and people settle up over Lightning. This can’t be changed later.')).toBeVisible();
    await page.getByPlaceholder('Name your group').fill('Sats trip');
    await button(page, 'Create and share the link').click();
    await closePeople(page);
    expect((await yash.api.groups())[0].currency).toBe('BTC');
  });

  test('starts without simplifying debts', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await expect(page.getByRole('switch', { name: 'Simplify debts' })).toHaveCount(0);
    await page.getByPlaceholder('Name your group').fill('Flat');
    await button(page, 'Create and share the link').click();
    await closePeople(page);
    expect((await yash.api.groups())[0].simplifyDebts).toBe(false);
  });

  test('a new group opens on its link, and is empty everywhere it shows', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    await page.getByPlaceholder('Name your group').fill('Goa trip');
    await page.getByPlaceholder('Add a name').fill('Priya');
    await page.getByPlaceholder('Add a name').press('Enter');
    await page.getByPlaceholder('Add a name').fill('Aman');
    await button(page, 'Create and share the link').click();
    await expect(page.getByText('Share the group link', { exact: true })).toBeVisible();
    await expect(page.getByText(/\/g\/[A-Za-z0-9_-]+$/)).toBeVisible();
    await closePeople(page);
    await expect(page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(memberLine(page, 'You, Priya, Aman')).toBeVisible();
    await expect(page.getByText('No expenses yet')).toBeVisible();
    await expect(page.getByText('Add the first one and you’ll see who owes what.')).toBeVisible();
    await expect(page.getByText('Nothing yet. Add the first one below.')).toBeVisible();
    await expect(page.getByText('Who pays whom', { exact: true })).toHaveCount(0);
    // Back on the group later, Add people stays closed.
    await openManage(page);
    await back(page);
    await expect(page.getByText('Share the group link', { exact: true })).toBeHidden();
    await back(page);
    await expect(page.getByText('Nothing to settle yet.', { exact: false })).toBeVisible();
    await expect(page.getByText('3 people', { exact: true })).toBeVisible();
    await expect(page.getByText('No expenses yet', { exact: true })).toBeVisible();
    await expect(button(page, 'New group')).toBeVisible();
    await expect(button(page, 'Join with a link')).toBeVisible();
  });

  test('a double tap on Create makes one group', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await page.getByPlaceholder('Name your group').fill('Once');
    await button(page, 'Create and share the link').dblclick();
    await closePeople(page);
    expect(await yash.api.groups()).toHaveLength(1);
  });
});

test.describe('Groups list', () => {
  test('the headline and each row follow the balances', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Goa trip',
      people: ['Priya', 'Aman'],
      spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }],
    });
    await yash.api.seedGroup({
      name: 'Flat 4B',
      people: ['Priya', 'Aman'],
      spends: [{ description: 'Power', amount: 30_000, paidBy: 'Priya' }],
    });
    await page.goto('/');
    // Owed ₹200 in one, owing ₹100 in the other: ₹100 owed in all.
    await expect(page.getByText('You’re owed', { exact: true })).toBeVisible();
    await expect(page.getByText('₹100', { exact: true })).toHaveCount(3); // the headline, you owe, and Flat 4B's row
    const goa = ancestor(page.getByText('Goa trip', { exact: true }), 2);
    await expect(goa.getByText('you’re owed')).toBeVisible();
    await expect(goa.getByText('₹200')).toBeVisible();
    const flat = ancestor(page.getByText('Flat 4B', { exact: true }), 2);
    await expect(flat.getByText('you owe')).toBeVisible();
    await expect(flat.getByText('₹100')).toBeVisible();
  });

  test('one total per currency, in the order the app lists them', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Sats trip',
      people: ['Aman'],
      currency: 'BTC',
      spends: [{ description: 'Beers', amount: 1000, paidBy: 'Yash' }],
    });
    await yash.api.seedGroup({
      name: 'Goa trip',
      people: ['Priya'],
      spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }],
    });
    await page.goto('/');
    const labels = page.getByText(/^(You’re owed|You owe|All square)$/);
    await expect(labels).toHaveCount(2);
    await expect(page.getByText('₹150', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('500 sats', { exact: true }).first()).toBeVisible();
    // Rupees first, as everywhere in the app.
    const amounts = await page.getByText(/^(₹150|500 sats)$/).allTextContents();
    expect(amounts.indexOf('₹150')).toBeLessThan(amounts.indexOf('500 sats'));
  });

  test('a group that has been settled reads as settled', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    const { group, idOf } = await yash.api.seedGroup({
      name: 'Flat 4B',
      people: ['Priya'],
      spends: [{ description: 'Power', amount: 20_000, paidBy: 'Priya' }],
    });
    // Priya never joined, so the person who owes her may record a cash payment.
    await yash.api.markSettled({ groupId: group.id, fromMemberId: idOf('Yash'), toMemberId: idOf('Priya'), amount: 10_000 });
    await page.goto('/');
    await expect(page.getByText('All square', { exact: true })).toHaveCount(2); // the headline and the row
    const row = ancestor(page.getByText('Flat 4B', { exact: true }), 2);
    await expect(row.getByText('you owe')).toHaveCount(0);
    await openGroup(page, 'Flat 4B');
    await expect(page.getByText('All square', { exact: true })).toBeVisible();
    await expect(page.getByText('Everyone’s square. Nothing to pay.', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Priya').getByText('settled', { exact: true })).toBeVisible();
  });
});

test.describe('Members', () => {
  test('each row says whether they have the app and where they stand', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Goa trip',
      people: ['Priya', 'Aman'],
      spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }],
    });
    await goToGroup(page, 'Goa trip');
    await groupTab(page, 'Members');
    const me = memberRow(page, 'Yash (you)');
    await expect(me.getByText('Joined', { exact: true })).toBeVisible();
    await expect(me.getByText('gets back')).toBeVisible();
    await expect(me.getByText('₹200')).toBeVisible();
    const priya = memberRow(page, 'Priya');
    await expect(priya.getByText('Hasn’t joined · pays from links')).toBeVisible();
    await expect(priya.getByText('owes')).toBeVisible();
    await expect(priya.getByText('₹100')).toBeVisible();
  });

  test('before any expense, nobody owes or is owed anything', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await groupTab(page, 'Members');
    await expect(page.getByText('owes', { exact: true })).toHaveCount(0);
    await expect(page.getByText('gets back', { exact: true })).toHaveCount(0);
    await expect(page.getByText('settled', { exact: true })).toHaveCount(0);
  });

  test('someone who joins through the link shows up as In app on the other device', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await goToGroup(alice.page, 'Trip');
    await groupTab(alice.page, 'Members');
    await expect(memberRow(alice.page, 'Bob').getByText('Hasn’t joined · pays from links')).toBeVisible();
    await joinAs(alice, group.id, bob, 'Bob');
    // The group screen keeps itself current every 4 s.
    await expect(memberRow(alice.page, 'Bob').getByText('Joined', { exact: true })).toBeVisible({ timeout: 15_000 });
    await goToGroup(bob.page, 'Trip');
    await groupTab(bob.page, 'Members');
    await expect(memberRow(bob.page, 'Bob (you)').getByText('Joined', { exact: true })).toBeVisible();
    await expect(memberRow(bob.page, 'Alice').getByText('Joined', { exact: true })).toBeVisible();
  });

  test('adds someone by name', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await groupTab(page, 'Members');
    await expectDisabled(button(page, 'Add'));
    await expect(page.getByText('In this group · 2')).toBeVisible();
    const field = page.getByPlaceholder('Their name');
    await field.fill('  Aman  ');
    await button(page, 'Add').click();
    await expect(memberRow(page, 'Aman').getByText('Hasn’t joined · pays from links')).toBeVisible();
    await expect(page.getByText('In this group · 3')).toBeVisible();
    await expect(page.getByText('Aman starts at nothing owed and isn’t in earlier expenses. Add them to any they shared.')).toBeVisible();
    await expect(field).toHaveValue('');
    await expectDisabled(button(page, 'Add'));
    // Enter adds too.
    await field.fill('Riya');
    await field.press('Enter');
    await expect(memberRow(page, 'Riya')).toBeVisible();
    await expect(page.getByText('In this group · 4')).toBeVisible();
    await closePeople(page);
    await expect(memberLine(page, 'You, Priya, Aman, Riya')).toBeVisible();
  });

  test('removes a ghost nobody has built on, with a second tap', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya', 'Aman'] });
    await groupTab(page, 'Members');
    await button(page, 'Remove Priya').click();
    await expect(button(page, 'Yes, remove Priya')).toBeVisible();
    await button(page, 'Cancel').click();
    await expect(button(page, 'Yes, remove Priya')).toBeHidden();
    await expect(memberRow(page, 'Priya')).toBeVisible();
    await confirm(page, 'Remove Priya', 'Yes, remove Priya');
    await expect(memberRow(page, 'Priya')).toBeHidden();
    await expect(page.getByText('In this group · 2')).toBeVisible();
    await expect(button(page, 'Remove Aman')).toBeVisible();
  });

  test('neither a ghost in an expense nor someone who joined can be removed', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({
      name: 'Trip',
      people: ['Bob', 'Priya', 'Aman'],
      spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Alice', between: ['Alice', 'Priya'] }],
    });
    await joinAs(alice, group.id, bob, 'Bob');
    await goToGroup(alice.page, 'Trip');
    await groupTab(alice.page, 'Members');
    await expect(button(alice.page, 'Remove Aman')).toBeVisible();
    await expect(button(alice.page, 'Remove Priya')).toHaveCount(0);
    await expect(button(alice.page, 'Remove Bob')).toHaveCount(0);
    await expect(button(alice.page, 'Remove Alice')).toHaveCount(0);
  });

  test('names of every shape are shown as written', async ({ person }) => {
    const { page } = await person('Yash');
    const long = 'Bartholomew Montgomery Fitzgerald-Smythe';
    expect(long).toHaveLength(40);
    const html = '<img src=x onerror=document.title=1>';
    await createGroup(page, {
      name: '<b>x</b><img src=x onerror="document.title=\'pwned\'">',
      people: [long, 'प्रिया शर्मा', '🦊 Fox', html],
    });
    await expect(page.getByText('<b>x</b><img src=x onerror="document.title=\'pwned\'">', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    for (const name of [long, 'प्रिया शर्मा', '🦊 Fox', html]) {
      await expect(memberRow(page, name).getByText('Hasn’t joined · pays from links')).toBeVisible();
    }
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.title()).toBe('sattle');
    await closePeople(page);
    await back(page);
    await expect(page.getByText('<b>x</b><img src=x onerror="document.title=\'pwned\'">', { exact: true })).toBeVisible();
    expect(await page.title()).toBe('sattle');
  });
});

test.describe('Manage', () => {
  test('renames the group', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await openManage(page);
    const field = page.getByPlaceholder('Group name');
    await expect(field).toHaveValue('Goa trip');
    const save = section(page, 'Name').getByText('Save', { exact: true });
    await expectDisabled(save);
    await field.fill('   ');
    await expectDisabled(save);
    await field.fill('  Goa, again  ');
    await save.click();
    await expect(page.getByText('Goa, again', { exact: true })).toBeVisible();
    await expect(field).toHaveValue('Goa, again');
    await expectDisabled(save);
    await back(page);
    await expect(page.getByText('Goa, again', { exact: true })).toBeVisible();
    await back(page);
    await expect(page.getByText('Goa, again', { exact: true })).toBeVisible();
    expect((await yash.api.groups())[0].name).toBe('Goa, again');
  });

  test('a name stops at 80 characters', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip' });
    await openManage(page);
    const field = page.getByPlaceholder('Group name');
    await field.fill('');
    await field.pressSequentially('x'.repeat(90));
    expect(await field.inputValue()).toHaveLength(80);
  });

  test('simplifying debts changes who owes whom', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    // Yash paid ₹300 for all three; Bob paid ₹300 for Bob and Carl. Nets: Yash +200, Bob +50, Carl −250.
    await yash.api.seedGroup({
      name: 'Trip',
      people: ['Bob', 'Carl'],
      spends: [
        { description: 'Villa', amount: 30_000, paidBy: 'Yash' },
        { description: 'Cab', amount: 30_000, paidBy: 'Bob', between: ['Bob', 'Carl'] },
      ],
    });
    await goToGroup(page, 'Trip');
    await groupTab(page, 'Settle up');
    // Simplified: Carl pays Yash ₹200 and Bob ₹50. Bob owes Yash nothing.
    await expect(debtCard(page, 'Carl pays you').getByText('₹200')).toBeVisible();
    await expect(page.getByText('Bob pays you')).toHaveCount(0);
    await openManage(page);
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Everyone pays back the people who paid for them.')).toBeVisible();
    expect((await yash.api.groups())[0].simplifyDebts).toBe(false);
    await back(page);
    // Direct: everyone pays back whoever paid for them. Bob and Carl each owe Yash ₹100 for the villa.
    await expect(debtCard(page, 'Bob pays you').getByText('₹100')).toBeVisible();
    await expect(debtCard(page, 'Carl pays you').getByText('₹100')).toBeVisible();
    // The headline, still owed ₹200 in all, and what Yash lent for the villa.
    await expect(page.getByText('₹200', { exact: true })).toHaveCount(2);
    await openManage(page);
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await back(page);
    await expect(debtCard(page, 'Carl pays you').getByText('₹200')).toBeVisible();
  });

  test('approving who joins is a switch with its own words', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Goa trip' });
    await openManage(page);
    await expect(page.getByText('Whoever opens the group’s link picks their name and is in.')).toBeVisible();
    const joining = section(page, 'Joining');
    await button(joining, 'Learn more').click();
    await expect(joining.getByText(/The link can be forwarded, and whoever holds it can join as anyone in the group/)).toBeVisible();
    await page.getByRole('switch', { name: 'Approve who joins' }).click();
    await expect(page.getByText('Someone here lets each person in, after checking a four-digit code.')).toBeVisible();
    await expect.poll(async () => (await yash.api.groups())[0].approveJoins).toBe(true);
    await page.getByRole('switch', { name: 'Approve who joins' }).click();
    await expect(page.getByText('Whoever opens the group’s link picks their name and is in.')).toBeVisible();
    await expect.poll(async () => (await yash.api.groups())[0].approveJoins).toBe(false);
  });

  test('the group link section says when there is none, and shows it once Add people made one', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    // Made without the app, so nothing has opened Add people and there is no link yet.
    await yash.api.seedGroup({ name: 'Goa trip', people: [] });
    await goToGroup(page, 'Goa trip');
    await openManage(page);
    await expect(page.getByText('No link yet. Add people, on the group screen, makes one.')).toBeVisible();
    await expect(button(page, 'Make a new link')).toHaveCount(0);
    await back(page);
    const url = await inviteLink(page);
    await openManage(page);
    await expect(page.getByText(url, { exact: true })).toBeVisible();
    await expect(button(page, 'Make a new link')).toBeVisible();
    await expect(button(page, 'Turn off the link')).toBeVisible();
    const link = section(page, 'Group link');
    await button(link, 'Learn more').click();
    await expect(
      link.getByText(/Anyone holding this link can see the group’s spends and who owes what, and pay a debt, with no app/)
    ).toBeVisible();
  });

  test('the backup appears with the first entry and counts them', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await openManage(page);
    await expect(page.getByText('Manage group')).toBeVisible();
    await expect(page.getByText('Backed up on Nostr')).toHaveCount(0);
    await back(page);
    await addExpense(page, { description: 'Villa', amount: '300' });
    const [group] = await yash.api.groups();
    const entries = () => yash.api.get<{ entries: number }>(`/groups/${group.id}/ledger`).then((b) => b.entries);
    // The server signs new entries every few seconds.
    await expect.poll(entries, { timeout: 15_000 }).toBe(1);
    await openManage(page);
    await expect(page.getByText('Backed up on Nostr')).toBeVisible();
    await expect(page.getByText('1 entry signed. This server isn’t publishing to relays yet.')).toBeVisible();
    await expect(button(page, 'See it on a relay')).toHaveCount(0);
    await expect(button(page, 'Read it back')).toHaveCount(0);
    await button(page, 'Copy backup key').click();
    await expect(page.getByText('Copied. It unlocks this group’s history, so only give it to people in the group.')).toBeVisible();
    await expect(page.getByText(/^sattle-ledger:\/\//)).toBeVisible();
    await back(page);
    await addExpense(page, { description: 'Cab', amount: '60' });
    await expect.poll(entries, { timeout: 15_000 }).toBe(2);
    await openManage(page);
    await expect(page.getByText('2 entries signed. This server isn’t publishing to relays yet.')).toBeVisible();
  });

  test('the only account in a group can’t leave it', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await openManage(page);
    await expect(page.getByText('Only you have an account here, so delete the group instead.')).toBeVisible();
    await expect(button(page, 'Leave this group')).toHaveCount(0);
  });

  test('leaving keeps your name and your expenses in the group for the others', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await joinAs(alice, group.id, bob, 'Bob');
    await goToGroup(bob.page, 'Trip');
    await addExpense(bob.page, { description: 'Cab', amount: '60', paidBy: 'Bob' });
    await goToGroup(alice.page, 'Trip');
    await groupTab(alice.page, 'Members');
    await expect(memberRow(alice.page, 'Bob').getByText('Joined', { exact: true })).toBeVisible();

    await openManage(bob.page);
    await expect(button(bob.page, 'Delete this group')).toHaveCount(0); // Alice owes Bob ₹30
    await button(bob.page, 'Leave this group').click();
    await expect(bob.page.getByText('Anything owed to you can then be marked settled by whoever owes it.')).toBeVisible();
    await button(bob.page, 'Yes, leave').click();
    await expect(bob.page.getByText('What are you splitting?')).toBeVisible();
    expect(await bob.api.groups()).toHaveLength(0);

    await expect(memberRow(alice.page, 'Bob').getByText('Hasn’t joined · pays from links')).toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByText('In this group · 2')).toBeVisible();
    await expect(memberRow(alice.page, 'Bob').getByText('gets back')).toBeVisible();
    await expect(memberRow(alice.page, 'Bob').getByText('₹30')).toBeVisible();
  });

  test('a group with money owed in it can’t be deleted', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Goa trip',
      people: ['Priya'],
      spends: [{ description: 'Villa', amount: 30_000, paidBy: 'Yash' }],
    });
    await goToGroup(page, 'Goa trip');
    await openManage(page);
    await expect(page.getByText('Settle up first.')).toBeVisible();
    await expect(button(page, 'Delete this group')).toHaveCount(0);
    const del = section(page, 'Delete');
    await button(del, 'Learn more').click();
    await expect(
      del.getByText('A group can only be deleted once nothing is owed in it, so that deleting it can’t erase a debt.')
    ).toBeVisible();
  });

  test('deleting a settled group takes it from everyone', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await joinAs(alice, group.id, bob, 'Bob');
    await bob.page.goto('/');
    await expect(bob.page.getByText('Trip', { exact: true })).toBeVisible();

    await goToGroup(alice.page, 'Trip');
    await openManage(alice.page);
    await button(alice.page, 'Delete this group').click();
    await expect(alice.page.getByText('Everything in it goes, for everyone. This can’t be undone.')).toBeVisible();
    await button(alice.page, 'Yes, delete it for everyone').click();
    await expect(alice.page.getByText('What are you splitting?')).toBeVisible();

    // Bob's list is from before: tapping the row finds nothing there.
    await bob.page.getByText('Trip', { exact: true }).click();
    await expect(button(bob.page, 'Try again')).toBeVisible();
    await bob.page.reload();
    await expect(bob.page.getByText('What are you splitting?')).toBeVisible();
    expect(await bob.api.groups()).toHaveLength(0);
  });
});

test.describe('A group kept in bitcoin', () => {
  test('counts in sats from the form to the list', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Sats trip', people: ['Priya'], currency: 'Bitcoin' });
    await button(page, 'Add expense').click();
    await expect(page.getByText('sats', { exact: true })).toBeVisible();
    await expect(page.getByText('₹', { exact: true })).toHaveCount(0);
    await expenseForm.description(page).fill('Beers');
    await expenseForm.amount(page).fill('1001');
    await expect(page.getByText('501 sats', { exact: true })).toBeVisible();
    await expect(page.getByText('500 sats', { exact: true })).toBeVisible();
    await expect(page.getByText('about 500 sats each', { exact: true })).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText(/^You paid 1,001 sats · /)).toBeVisible();
    await expect(page.getByText(/^You’re owed/)).toBeVisible();
    await expect(debtCard(page, 'Priya pays you').getByText('500 sats')).toBeVisible();
    await addExpense(page, { description: 'A sat', amount: '1' });
    await expect(page.getByText(/^You paid 1 sat · /)).toBeVisible();
    await back(page);
    await expect(page.getByText('500 sats', { exact: true })).toHaveCount(3); // the headline, owed to you, and the row
  });
});
