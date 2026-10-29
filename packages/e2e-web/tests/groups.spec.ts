/**
 * Groups: making one, what the groups list says about them, who is in them,
 * managing them, and a group kept in bitcoin.
 */

import {
  ancestor,
  back,
  button,
  confirm,
  createGroup,
  debtCard,
  expenseForm,
  groupHeader,
  groupTab,
  inviteLink,
  memberRow,
  openGroup,
  openManage,
  section,
} from '../src/actions';
import { expect, test } from '../src/fixtures';
import { addSpend, disabled, goToGroup, joinAs, saveExpense } from '../src/groups.helpers';

test.describe('New group', () => {
  test('refuses a group with no name', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    await button(page, 'Create group').click();
    await expect(page.getByText('Give the group a name.')).toBeVisible();
    await expect(page.getByPlaceholder('Goa trip')).toBeVisible();
  });

  test('trims the name and leaves out blank people', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await page.getByPlaceholder('Goa trip').fill('   Goa trip   ');
    await page.getByPlaceholder('Their name').fill('Priya');
    await button(page, 'Add another person').click();
    await button(page, 'Add another person').click();
    await page.getByPlaceholder('Their name').nth(2).fill('   ');
    await button(page, 'Create group').click();
    await expect(page.getByText('2 members · 0 expenses')).toBeVisible();
    const [group] = await yash.api.groups();
    expect(group.name).toBe('Goa trip');
    expect((await yash.api.members(group.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya']);
  });

  test('Enter goes from the name to the people, down the list, and adds a field after the last', async ({ person }) => {
    const { page } = await person('Yash');
    await button(page, 'New group').click();
    const names = page.getByPlaceholder('Their name');
    await page.getByPlaceholder('Goa trip').fill('Goa trip');
    await page.getByPlaceholder('Goa trip').press('Enter');
    await expect(names.first()).toBeFocused();
    await names.first().fill('Priya');
    await names.first().press('Enter');
    await expect(names).toHaveCount(2);
    await expect(names.nth(1)).toBeFocused();
    // Enter on an empty field is "done": nothing is added.
    await names.nth(1).press('Enter');
    await expect(names).toHaveCount(2);
  });

  test('says what each currency means, and keeps the one picked', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await expect(page.getByRole('radio', { name: 'Rupees' })).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.getByText('Amounts are in rupees, and people settle up by UPI or over Lightning. This can’t be changed later.')
    ).toBeVisible();
    await page.getByRole('radio', { name: 'Bitcoin' }).click();
    await expect(page.getByText('Amounts are in sats, and people settle up over Lightning. This can’t be changed later.')).toBeVisible();
    await page.getByPlaceholder('Goa trip').fill('Sats trip');
    await button(page, 'Create group').click();
    await expect(groupHeader(page)).toBeVisible();
    expect((await yash.api.groups())[0].currency).toBe('BTC');
  });

  test('explains simplifying debts, and keeps it off when turned off', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await button(page, 'Learn more').click();
    await expect(
      page.getByText(
        'Say Aman owes Priya, and Priya owes Om the same. Simplified, Aman pays Om and Priya is done: one payment instead of two. Nobody pays more or less either way, only to different people.'
      )
    ).toBeVisible();
    await button(page, 'Show less').click();
    await expect(page.getByText('Say Aman owes Priya', { exact: false })).toBeHidden();
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Everyone pays back the people who paid for them.')).toBeVisible();
    await expect(page.getByText('Anyone in the group can change this later, under Manage.')).toBeVisible();
    await page.getByPlaceholder('Goa trip').fill('Flat');
    await button(page, 'Create group').click();
    await expect(groupHeader(page)).toBeVisible();
    expect((await yash.api.groups())[0].simplifyDebts).toBe(false);
  });

  test('a new group is empty everywhere it shows', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya', 'Aman'] });
    await expect(page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(page.getByText('3 members · 0 expenses')).toBeVisible();
    await expect(page.getByText('No expenses yet')).toBeVisible();
    await expect(page.getByText("Add the first one and you'll see who owes what.")).toBeVisible();
    await expect(page.getByText('Nothing yet. Add the first one below.')).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(page.getByText('All settled.')).toBeVisible();
    await back(page);
    await expect(page.getByText('No expenses yet')).toBeVisible();
    await expect(page.getByText('Add one to a group and what you owe or are owed shows here.')).toBeVisible();
    await expect(page.getByText('3 members', { exact: true })).toBeVisible();
    await expect(page.getByText('No expenses', { exact: true })).toBeVisible();
    await expect(button(page, 'New group')).toBeVisible();
    await expect(button(page, 'Join with a link')).toBeVisible();
  });

  test('a double tap on Create group makes one group', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await button(page, 'New group').click();
    await page.getByPlaceholder('Goa trip').fill('Once');
    await button(page, 'Create group').dblclick();
    await expect(groupHeader(page)).toBeVisible();
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
    await expect(page.getByText('You are owed', { exact: true })).toBeVisible();
    await expect(page.getByText('₹100', { exact: true })).toHaveCount(2);
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
    const labels = page.getByText(/^(You are owed|You owe|All settled)$/);
    await expect(labels).toHaveCount(2);
    await expect(page.getByText('₹150', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('500 sats', { exact: true }).first()).toBeVisible();
    // Rupees first, as everywhere in the app.
    const amounts = await page.getByText(/^(₹150|500 sats)$/).allTextContents();
    expect(amounts.slice(0, 2)).toEqual(['₹150', '500 sats']);
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
    await expect(page.getByText('All settled', { exact: true })).toBeVisible();
    await expect(page.getByText('settled', { exact: true })).toHaveCount(2);
    const row = ancestor(page.getByText('Flat 4B', { exact: true }), 2);
    await expect(row.getByText('you owe')).toHaveCount(0);
    await openGroup(page, 'Flat 4B');
    await expect(page.getByText('All settled', { exact: true })).toBeVisible();
    await expect(page.getByText('settled', { exact: true })).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(page.getByText('All settled.')).toBeVisible();
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
    await expect(me.getByText('In app')).toBeVisible();
    await expect(me.getByText('gets back')).toBeVisible();
    await expect(me.getByText('₹200')).toBeVisible();
    const priya = memberRow(page, 'Priya');
    await expect(priya.getByText('Not joined')).toBeVisible();
    await expect(priya.getByText('No app')).toBeVisible();
    await expect(priya.getByText('owes')).toBeVisible();
    await expect(priya.getByText('₹100')).toBeVisible();
    await expect(memberRow(page, 'Aman').getByText('No app')).toBeVisible();
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
    await expect(memberRow(alice.page, 'Bob').getByText('Not joined')).toBeVisible();
    await joinAs(alice, group.id, bob, 'Bob');
    // The group screen keeps itself current every 4 s.
    await expect(memberRow(alice.page, 'Bob').getByText('In app')).toBeVisible({ timeout: 15_000 });
    await expect(memberRow(alice.page, 'Bob').getByText('No app')).toHaveCount(0);
    await goToGroup(bob.page, 'Trip');
    await groupTab(bob.page, 'Members');
    await expect(memberRow(bob.page, 'Bob (you)').getByText('In app')).toBeVisible();
    await expect(memberRow(bob.page, 'Alice').getByText('In app')).toBeVisible();
  });

  test('adds someone by name', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip', people: ['Priya'] });
    await groupTab(page, 'Members');
    await disabled(button(page, 'Add'));
    await button(page, 'Add').click();
    await expect(page.getByText('2 members · 0 expenses')).toBeVisible();
    const field = page.getByPlaceholder('Add someone by name');
    await field.fill('  Aman  ');
    await button(page, 'Add').click();
    await expect(memberRow(page, 'Aman').getByText('Not joined')).toBeVisible();
    await expect(page.getByText('3 members · 0 expenses')).toBeVisible();
    await expect(field).toHaveValue('');
    await disabled(button(page, 'Add'));
    // Enter adds too.
    await field.fill('Riya');
    await field.press('Enter');
    await expect(memberRow(page, 'Riya')).toBeVisible();
    await expect(page.getByText('4 members · 0 expenses')).toBeVisible();
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
    await expect(page.getByText('2 members · 0 expenses')).toBeVisible();
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
      await expect(memberRow(page, name).getByText('Not joined')).toBeVisible();
    }
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.title()).toBe('sattle');
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
    await disabled(save);
    await field.fill('   ');
    await disabled(save);
    await field.fill('  Goa, again  ');
    await save.click();
    await expect(page.getByText('Goa, again', { exact: true })).toBeVisible();
    await expect(field).toHaveValue('Goa, again');
    await disabled(save);
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
    await expect(debtCard(page, 'Carl owes you').getByText('₹200')).toBeVisible();
    await expect(page.getByText('Bob owes you')).toHaveCount(0);
    await openManage(page);
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Everyone pays back the people who paid for them.')).toBeVisible();
    expect((await yash.api.groups())[0].simplifyDebts).toBe(false);
    await back(page);
    // Direct: everyone pays back whoever paid for them. Bob and Carl each owe Yash ₹100 for the villa.
    await expect(debtCard(page, 'Bob owes you').getByText('₹100')).toBeVisible();
    await expect(debtCard(page, 'Carl owes you').getByText('₹100')).toBeVisible();
    await expect(page.getByText('₹200', { exact: true })).toHaveCount(1); // the headline: still owed ₹200 in all
    await openManage(page);
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await back(page);
    await expect(debtCard(page, 'Carl owes you').getByText('₹200')).toBeVisible();
  });

  test('approving who joins is a switch with its own words', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Goa trip' });
    await openManage(page);
    await expect(page.getByText('Whoever opens the group’s link picks their name and is in.')).toBeVisible();
    const joining = section(page, 'Joining');
    await button(joining, 'Learn more').click();
    await expect(joining.getByText(/The link can be forwarded, and whoever holds it can take any name nobody has joined as/)).toBeVisible();
    await page.getByRole('switch', { name: 'Approve who joins' }).click();
    await expect(page.getByText('Someone here lets each person in, after checking a four-digit code.')).toBeVisible();
    await expect.poll(async () => (await yash.api.groups())[0].approveJoins).toBe(true);
    await page.getByRole('switch', { name: 'Approve who joins' }).click();
    await expect(page.getByText('Whoever opens the group’s link picks their name and is in.')).toBeVisible();
    await expect.poll(async () => (await yash.api.groups())[0].approveJoins).toBe(false);
  });

  test('the group link section says when there is none, and shows it once Invite made one', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Goa trip' });
    await openManage(page);
    await expect(page.getByText('No link yet. Invite on the group screen makes one.')).toBeVisible();
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
    await addSpend(page, { description: 'Villa', amount: '300' });
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
    await addSpend(page, { description: 'Cab', amount: '60' });
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
    await addSpend(bob.page, { description: 'Cab', amount: '60', paidBy: 'Bob' });
    await goToGroup(alice.page, 'Trip');
    await groupTab(alice.page, 'Members');
    await expect(memberRow(alice.page, 'Bob').getByText('In app')).toBeVisible();

    await openManage(bob.page);
    await expect(button(bob.page, 'Delete this group')).toHaveCount(0); // Alice owes Bob ₹30
    await button(bob.page, 'Leave this group').click();
    await expect(bob.page.getByText('Anything owed to you can then be marked settled by whoever owes it.')).toBeVisible();
    await button(bob.page, 'Yes, leave').click();
    await expect(bob.page.getByText('No groups yet')).toBeVisible();
    expect(await bob.api.groups()).toHaveLength(0);

    await expect(memberRow(alice.page, 'Bob').getByText('Not joined')).toBeVisible({ timeout: 15_000 });
    await expect(alice.page.getByText('2 members · 1 expenses')).toBeVisible();
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
    await expect(alice.page.getByText('No groups yet')).toBeVisible();

    // Bob's list is from before: tapping the row finds nothing there.
    await bob.page.getByText('Trip', { exact: true }).click();
    await expect(button(bob.page, 'Try again')).toBeVisible();
    await bob.page.reload();
    await expect(bob.page.getByText('No groups yet')).toBeVisible();
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
    await expect(page.getByText('Remainder is spread a sat at a time, so the split always adds up.')).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText('1,001 sats', { exact: true })).toBeVisible();
    await expect(page.getByText('You are owed', { exact: true })).toBeVisible();
    await expect(page.getByText('500 sats', { exact: true })).toBeVisible();
    await addSpend(page, { description: 'A sat', amount: '1' });
    await expect(page.getByText('1 sat', { exact: true })).toBeVisible();
    await back(page);
    await expect(page.getByText('500 sats', { exact: true })).toHaveCount(2); // the headline and the row
  });
});
