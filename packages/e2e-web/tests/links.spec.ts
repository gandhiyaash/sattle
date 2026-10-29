/**
 * The group's one link: the Invite dialog that hands it out, Manage where it
 * is replaced or turned off, the page it opens for someone with no app
 * (/g/<token>), paying from that page over Lightning and by UPI, and joining
 * through it: straight in, with someone letting you in, and taking a name
 * back from a device you lost.
 */

import {
  ancestor,
  back,
  button,
  confirm,
  debtCard,
  groupHeader,
  groupTab,
  inviteLink,
  memberRow,
  openGroup,
  openManage,
  section,
  skipTour,
  tab,
  tokenOf,
  clipboard,
} from '../src/actions';
import { expect, test } from '../src/fixtures';
import {
  JOIN_CODE,
  groupLinkToken,
  groupWhereGhostOwesMe,
  openGroupPage,
  who,
} from '../src/links.helpers';

test.describe('Invite and the group link', () => {
  test('Invite shows the link as a QR code and copies the message; Manage shows the same link', async ({ person }) => {
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await openGroup(yash.page, 'Goa trip', { reload: true });

    await button(yash.page, 'Invite').click();
    await expect(yash.page.getByText('Invite to Goa trip')).toBeVisible();
    await expect(yash.page.locator('svg path[fill="#000000"]').first()).toBeVisible();
    await expect(yash.page.getByText('Scan to see the group and join.', { exact: true })).toBeVisible();
    const url = (await yash.page.getByText(/\/g\/[A-Za-z0-9_-]+$/).textContent())!.trim();
    expect(url).toBe(`http://127.0.0.1:8900/g/${(await yash.api.groupLink(group.id))!.token}`);

    await button(yash.page, 'Share link').click();
    await expect(yash.page.getByText('Copied. Paste it in a chat.')).toBeVisible();
    const copied = await clipboard(yash.page);
    expect(copied).toContain('Here’s what we’ve split in "Goa trip"');
    expect(copied).toContain('pick your name');
    expect(copied).toContain(url);

    await button(yash.page, 'Done').click();
    await expect(yash.page.getByText('Invite to Goa trip')).toBeHidden();

    // Inviting again hands out the same link, not a new one that kills the one in the chat.
    expect(await inviteLink(yash.page)).toBe(url);

    await openManage(yash.page);
    const link = section(yash.page, 'Group link');
    await expect(link.getByText(url)).toBeVisible();
    await button(link, 'Learn more').click();
    await expect(
      link.getByText(
        'Anyone holding this link can see the group’s spends and who owes what, and pay a debt, with no app. They can’t change anything. They can join the group, or ask to, as Joining below says.'
      )
    ).toBeVisible();
  });

  test('with approving joins on, the invite says you let them in', async ({ person }) => {
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await yash.api.setApproveJoins(group.id, true);
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await button(yash.page, 'Invite').click();
    await expect(yash.page.getByText('Scan to see the group and join. You let them in.')).toBeVisible();
    await button(yash.page, 'Share link').click();
    expect(await clipboard(yash.page)).toContain('I’ll let you in');
  });

  test('a share sheet closed without sending says so and keeps the link on screen', async ({ person }) => {
    const yash = await person('Yash', { shareSheet: 'dismissed' });
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await openGroup(yash.page, 'Goa trip', { reload: true });
    const url = await inviteLink(yash.page, { done: false });
    await button(yash.page, 'Share link').click();
    await expect(yash.page.getByText('Not sent. Here’s the link:')).toBeVisible();
    await expect(yash.page.getByText(url)).toBeVisible();
    expect(await clipboard(yash.page)).not.toContain(url);
  });

  test('a new link replaces the old one, which stops working', async ({ person, device }) => {
    const yash = await person('Yash');
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await openGroup(yash.page, 'Goa trip', { reload: true });
    const oldUrl = await inviteLink(yash.page);

    const guest = await device();
    await openGroupPage(guest.page, tokenOf(oldUrl));
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();

    await openManage(yash.page);
    const link = section(yash.page, 'Group link');
    await button(link, 'Make a new link').click();
    await expect(link.getByText('The old one stops working for everyone who has it.')).toBeVisible();
    await button(link, 'Yes, replace the link').click();
    await expect(link.getByText(oldUrl)).toBeHidden();
    const newUrl = (await link.getByText(/\/g\/[A-Za-z0-9_-]+$/).textContent())!.trim();
    expect(newUrl).not.toBe(oldUrl);

    await guest.page.reload();
    await expect(guest.page.getByText('This link is no longer valid.')).toBeVisible();
    await expect(guest.page.getByText('Try again')).toBeHidden();

    const other = await device();
    await openGroupPage(other.page, tokenOf(newUrl));
    await expect(other.page.getByText('Goa trip', { exact: true })).toBeVisible();
  });

  test('turning the link off kills it, and Invite makes a fresh one', async ({ person, device }) => {
    const yash = await person('Yash');
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await openGroup(yash.page, 'Goa trip', { reload: true });
    const oldUrl = await inviteLink(yash.page);

    await openManage(yash.page);
    const link = section(yash.page, 'Group link');
    await button(link, 'Turn off the link').click();
    await expect(
      link.getByText('Nobody can open the group with it or join, until someone shares the group again.')
    ).toBeVisible();
    await button(link, 'Yes, turn it off').click();
    await expect(link.getByText('No link yet. Invite on the group screen makes one.')).toBeVisible();

    const guest = await device();
    await guest.page.goto(`/g/${tokenOf(oldUrl)}`);
    await expect(guest.page.getByText('This link is no longer valid.')).toBeVisible();

    await back(yash.page);
    await expect(groupHeader(yash.page)).toBeVisible();
    const fresh = await inviteLink(yash.page);
    expect(fresh).not.toBe(oldUrl);
    await openGroupPage(guest.page, tokenOf(fresh));
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
  });
});

test.describe('The group page', () => {
  test('shows the spends, who owes whom, and how to join', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group, owed } = await groupWhereGhostOwesMe(yash, { name: 'Goa trip', me: 'Yash', debtor: 'Om', others: ['Priya'] });
    const token = await groupLinkToken(yash, group.id);

    const guest = await device({ toured: false });
    await openGroupPage(guest.page, token);
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('1 spend · shared by link')).toBeVisible();

    await expect(guest.page.getByText('Who owes what')).toBeVisible();
    await expect(guest.page.getByText('Om owes Yash', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('₹300', { exact: true }).first()).toBeVisible();
    void owed;
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden();

    await expect(guest.page.getByText('Spends', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Dinner', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Yash paid', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Yash ₹300 · Om ₹300')).toBeVisible();

    // The way in is at the top, beside the group's name, and nothing else on the page is about joining.
    const join = guest.page.locator(`a[href="/join/${token}"]`);
    await expect(join).toBeVisible();
    await expect(join).toContainText('Join group');
    await expect(guest.page.getByText('In this group?')).toHaveCount(0);
    await expect(
      guest.page.getByText(
        'You’re seeing this group through its shared link. You can pay what you owe from here, but only the people in the group can change it.'
      )
    ).toBeVisible();
    // No tour on this page, and nothing of the app around it.
    await expect(guest.page.getByText('Skip', { exact: true })).toBeHidden();
    await expect(guest.page.getByText('Groups', { exact: true })).toBeHidden();
  });

  test('says when nothing has been added and nobody owes anything', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Flat 4B', people: ['Om'] });
    const token = await groupLinkToken(yash, group.id);

    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(guest.page.getByText('0 spends · shared by link')).toBeVisible();
    await expect(guest.page.getByText('All settled. Nobody owes anything.')).toBeVisible();
    await expect(guest.page.getByText('Nothing has been added yet.')).toBeVisible();
  });

  test('a debt owed to someone who never joined can’t be paid here', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({
      name: 'Goa trip',
      people: ['Om'],
      spends: [{ description: 'Villa', amount: 80_000, paidBy: 'Om' }],
    });
    const token = await groupLinkToken(yash, group.id);
    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(guest.page.getByText('Yash owes Om', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Om can’t be paid here yet. Settle with them directly.')).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning')).toBeHidden();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden();
  });

  test('keeps itself current: a spend added in the app shows up without a reload', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group, idOf } = await yash.seedGroup({ name: 'Goa trip', people: ['Om'] });
    const token = await groupLinkToken(yash, group.id);
    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(guest.page.getByText('Nothing has been added yet.')).toBeVisible();

    await yash.addExpense({
      groupId: group.id,
      description: 'Cabs',
      amount: 45_000,
      paidByMemberId: idOf('Yash'),
      splitMode: 'equal',
      parts: [{ memberId: idOf('Yash') }, { memberId: idOf('Om') }],
    });
    await expect(guest.page.getByText('Cabs', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('1 spend · shared by link')).toBeVisible();
    await expect(guest.page.getByText('Om owes Yash', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('₹225', { exact: true }).first()).toBeVisible();
  });
});

test.describe('Paying from the group page over Lightning', () => {
  test('opens the pay page in place, pays, and comes back to a settled group', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    const token = await groupLinkToken(yash.api, group.id);

    const guest = await device();
    await openGroupPage(guest.page, token);
    await button(guest.page, 'Pay with Lightning').click();

    await expect(guest.page.getByText('Om, you owe Yash')).toBeVisible();
    await expect(button(guest.page, 'Back to Goa trip')).toBeVisible();
    await expect(guest.page.getByText('No account needed.', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Getting a fresh invoice…')).toBeVisible();

    await expect(button(guest.page, 'Open your wallet')).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('Works with any Lightning wallet.')).toBeVisible();
    await expect(guest.page.getByText(/Rate and invoice locked for 1:[0-5]\d/)).toBeVisible();
    await expect(button(guest.page, 'Copy invoice')).toBeVisible();
    await expect(guest.page.getByText('Demo rate. No real money moves')).toBeVisible();

    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('Yash has been paid. Nothing else to do — you can close this.')).toBeVisible();
    await expect(guest.page.getByText('Payment proof', { exact: true })).toBeVisible();

    await button(guest.page, 'Back to Goa trip').click();
    await expect(guest.page.getByText('All settled. Nobody owes anything.')).toBeVisible();

    // The group in the app agrees.
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await expect(yash.page.getByText('All settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    const settlements = await yash.api.settlements(group.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ status: 'confirmed', rail: 'invoice', amount: 30_000 });
  });

  test('two quick taps start one payment, and other debts wait while one starts', async ({ api, device }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    // Two people owe Yash, so there are two cards with a button each.
    const { group, idOf } = await yash.seedGroup({
      name: 'Goa trip',
      people: ['Om', 'Priya'],
      spends: [{ description: 'Dinner', amount: 90_000, paidBy: 'Yash' }],
    });
    void idOf;
    const token = await groupLinkToken(yash, group.id);
    const guest = await device();
    await openGroupPage(guest.page, token);

    // Hold the request that starts the payment, so what the page does meanwhile can be seen.
    let hold: (() => void) | null = null;
    let held = false;
    await guest.page.route(
      (u) => /\/g\/[^/]+\/debts\/[^/]+\/pay-link$/.test(u.pathname),
      async (route) => {
        if (held) return route.continue();
        held = true;
        await new Promise<void>((r) => (hold = r));
        await route.continue();
      }
    );
    const buttons = button(guest.page, 'Pay with Lightning');
    await expect(buttons).toHaveCount(2);
    await buttons.first().dblclick();
    // The one tapped is busy, its label gone for a spinner; the other is greyed out.
    await expect(buttons).toHaveCount(1);
    await expect(ancestor(buttons.first(), 1)).toHaveCSS('opacity', '0.4');
    await expect.poll(() => hold !== null).toBe(true);
    hold!();

    await expect(guest.page.getByText(/, you owe Yash$/)).toBeVisible();
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await yash.settlements(group.id)).length, { timeout: 10_000 }).toBe(1);
  });
});

test.describe('Joining through the link on a brand-new device', () => {
  test('Join goes through the tour to the join page, which lists the group', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Goa trip', people: ['Priya', 'Om'] });
    const token = await groupLinkToken(yash, group.id);

    const guest = await device({ toured: false });
    await openGroupPage(guest.page, token);
    await guest.page.locator(`a[href="/join/${token}"]`).click();
    await expect(guest.page).toHaveURL(`/join/${token}`);
    await skipTour(guest.page);

    await expect(guest.page.getByText('Split bills in sats. Only one of you needs the app.')).toBeVisible();
    await expect(guest.page.getByText('You’re joining', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Who are you?')).toBeVisible();
    await expect(who(guest.page, 'Priya')).toBeVisible();
    await expect(who(guest.page, 'Om')).toBeVisible();
    // Yash has joined: shown, but not a choice here.
    await expect(guest.page.getByText('Yash', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Joined', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('I’m not on this list')).toBeVisible();
    await expect(guest.page.getByText('Pick who you are in this group.')).toBeVisible();
    await expect(
      guest.page.getByText(
        'You’re in as soon as you tap Join, and can see everything in the group and add to it. No email, phone or password: your account lives on this device. Save your sign-in key from Account to use it anywhere else.'
      )
    ).toBeVisible();
    // Nothing picked: the button has no name and does nothing.
    const join = button(guest.page, 'Join');
    await expect(join).toBeVisible();
    await expect(ancestor(join, 1)).toHaveCSS('opacity', '0.4');

    await who(guest.page, 'Priya').click();
    await expect(guest.page.getByText('You’ll take over that name as it is, with the balance already on it.')).toBeVisible();
    await expect(button(guest.page, 'Join as Priya')).toBeVisible();

    await guest.page.getByText('I’m not on this list').click();
    await expect(guest.page.getByPlaceholder('Your name')).toBeVisible();
    await expect(
      guest.page.getByText('You’ll be added to the group as a new member, with nothing owed either way.')
    ).toBeVisible();
    await expect(button(guest.page, 'Join')).toBeVisible();
    await guest.page.getByPlaceholder('Your name').fill('Kabir');
    await expect(button(guest.page, 'Join as Kabir')).toBeVisible();
  });

  test('picking a name joins as that member, and the group sees them arrive', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Priya' });
    const token = await groupLinkToken(yash.api, group.id);
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await groupTab(yash.page, 'Members');
    await expect(memberRow(yash.page, 'Priya').getByText('Not joined')).toBeVisible();
    await expect(memberRow(yash.page, 'Priya').getByText('No app')).toBeVisible();

    const guest = await device();
    await guest.page.goto(`/join/${token}`);
    await who(guest.page, 'Priya').click();
    await button(guest.page, 'Join as Priya').click();

    // In: the app opens on the groups list, with the group and the balance already on that name.
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('You owe', { exact: true })).toBeVisible();
    await expect(guest.page).toHaveURL('/');
    await openGroup(guest.page, 'Goa trip');
    await groupTab(guest.page, 'Members');
    await expect(guest.page.getByText('Priya (you)')).toBeVisible();
    await tab(guest.page, 'Account');
    await expect(guest.page.getByText('Signed in as')).toBeVisible();
    await expect(guest.page.getByText('Priya', { exact: true })).toBeVisible();

    await expect(memberRow(yash.page, 'Priya').getByText('In app')).toBeVisible({ timeout: 15_000 });
    await expect(memberRow(yash.page, 'Priya').getByText('No app')).toBeHidden();
    const members = await yash.api.members(group.id);
    expect(members.find((m) => m.displayName === 'Priya')).toMatchObject({ status: 'joined' });
  });

  test('adding yourself appends a new member', async ({ api, device }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash, group.id);
    const guest = await device();
    await guest.page.goto(`/join/${token}`);
    await guest.page.getByText('I’m not on this list').click();
    await guest.page.getByPlaceholder('Your name').fill('Kabir');
    await button(guest.page, 'Join as Kabir').click();
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('3 members', { exact: true })).toBeVisible();
    const members = await yash.members(group.id);
    expect(members.map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Kabir']);
    expect(members[2]).toMatchObject({ status: 'joined' });
  });

  test('a typed name that is already on the list, or already joined, is refused with the right words', async ({
    api,
    device,
  }) => {
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash, group.id);
    const guest = await device();
    await guest.page.goto(`/join/${token}`);
    await guest.page.getByText('I’m not on this list').click();
    const name = guest.page.getByPlaceholder('Your name');
    await name.fill('priya');
    await button(guest.page, 'Join as priya').click();
    await expect(guest.page.getByText('Priya is already in this group. Pick that name to join as them.')).toBeVisible();

    await name.fill('Yash');
    await button(guest.page, 'Join as Yash').click();
    await expect(
      guest.page.getByText(
        'Yash has already joined. If that’s you, pick Yash on the list. Otherwise give a name that tells you apart.'
      )
    ).toBeVisible();
    // Still here, still asking: the choice stays.
    await expect(guest.page.getByText('You’re joining', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(/Join as Yash$/)).toBeVisible();
  });

  test('two guests racing for the same name: the second is told, and sees the name taken', async ({ api, device }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash, group.id);
    const first = await device();
    const second = await device();
    await first.page.goto(`/join/${token}`);
    await second.page.goto(`/join/${token}`);
    await who(first.page, 'Priya').click();
    await who(second.page, 'Priya').click();
    await button(first.page, 'Join as Priya').click();
    await expect(first.page.getByText('Goa trip', { exact: true })).toBeVisible();

    await button(second.page, 'Join as Priya').click();
    await expect(
      second.page.getByText('Priya has already joined. To take the name back, ask, and someone in the group lets you in.')
    ).toBeVisible();
    // The list is read again: Priya is under the joined now, still picked, so the page offers to ask for the name back.
    await expect(second.page.getByText('Joined', { exact: true })).toHaveCount(2);
    await expect(who(second.page, 'Priya')).toBeVisible();
    await expect(button(second.page, 'Ask to be Priya again')).toBeVisible();
    await expect(second.page.getByText('I’m not on this list')).toBeVisible();
    // The account made for the join that failed is gone from this device.
    expect(await second.page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();
    expect((await yash.members(group.id)).filter((m) => m.displayName === 'Priya')).toHaveLength(1);
  });

  test('a dead link on the join page says so and offers a way on', async ({ device }) => {
    const guest = await device();
    await guest.page.goto('/join/no-such-link-at-all');
    await expect(guest.page.getByText('This link is no longer valid.')).toBeVisible();
    await expect(button(guest.page, 'Try again')).toBeHidden();
    await button(guest.page, 'Start without it').click();
    await expect(guest.page.getByText('What should your friends call you?')).toBeVisible();
    await expect(guest.page).toHaveURL('/');
    expect(await guest.page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();
  });
});

test.describe('Joining with an account already on the device', () => {
  test('Join with a link takes the pasted link, or the whole message, or the token', async ({ person, api }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash, group.id);
    const url = `http://127.0.0.1:8900/g/${token}`;

    const priya = await person('Priya');
    await button(priya.page, 'Join with a link').click();
    await expect(priya.page.getByText('Join a group')).toBeVisible();
    await expect(priya.page.getByText('Paste the group link you were sent.')).toBeVisible();
    const field = priya.page.getByPlaceholder('https://…/g/…');
    await expect(ancestor(button(priya.page, 'Continue'), 1)).toHaveCSS('opacity', '0.4');
    await field.fill('not a link');
    await button(priya.page, 'Continue').click();
    await expect(priya.page.getByText('That doesn’t look like a group link.')).toBeVisible();

    await field.fill(`Here’s what we’ve split in "Goa trip". See what you owe and pay it, no app needed: ${url}`);
    await button(priya.page, 'Continue').click();
    await expect(priya.page.getByText('You’re joining', { exact: true })).toBeVisible();
    await expect(priya.page.getByText('Goa trip', { exact: true })).toBeVisible();
    // The name they already go by is offered for adding themselves.
    await priya.page.getByText('I’m not on this list').click();
    await expect(priya.page.getByPlaceholder('Your name')).toHaveValue('Priya');

    // A link that leads nowhere offers the way back to pasting another.
    await priya.page.goto('/');
    await button(priya.page, 'Join with a link').click();
    await priya.page.getByPlaceholder('https://…/g/…').fill('http://127.0.0.1:8900/g/nothing-here-really');
    await button(priya.page, 'Continue').click();
    await expect(priya.page.getByText('This link is no longer valid.')).toBeVisible();
    await button(priya.page, 'Use a different link').click();
    await expect(priya.page.getByText('Paste the group link you were sent.')).toBeVisible();
    await priya.page.getByPlaceholder('https://…/g/…').fill(token);
    await button(priya.page, 'Continue').click();
    await who(priya.page, 'Priya').click();
    await button(priya.page, 'Join as Priya').click();
    // In: straight into the group this time.
    await expect(groupHeader(priya.page)).toBeVisible();
    await expect(priya.page.getByText('Goa trip', { exact: true })).toBeVisible();
    expect((await yash.members(group.id)).find((m) => m.displayName === 'Priya')).toMatchObject({
      status: 'joined',
      claimedByUserId: priya.userId,
    });
  });

  test('a member opening the join link gets the group; an outsider gets the join screen with Back', async ({
    person,
    api,
  }) => {
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash.api, group.id);

    await yash.page.goto(`/join/${token}`);
    await expect(groupHeader(yash.page)).toBeVisible();
    await expect(yash.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(yash.page).toHaveURL('/');

    const om = await person('Om');
    await om.page.goto(`/join/${token}`);
    await expect(om.page.getByText('Join a group')).toBeVisible();
    await expect(om.page.getByText('You’re joining', { exact: true })).toBeVisible();
    await back(om.page);
    await expect(om.page.getByText('No groups yet')).toBeVisible();
    await expect(om.page).toHaveURL('/');
    void api;
  });
});

test.describe('A group that approves joins', () => {
  test('asking to join waits with a code both sides see, and Let in opens the group', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash.api, group.id);
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await openManage(yash.page);
    await yash.page.getByRole('switch', { name: 'Approve who joins' }).click();
    await expect(yash.page.getByText('Someone here lets each person in, after checking a four-digit code.')).toBeVisible();
    await back(yash.page);

    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(guest.page.getByText(/You pick your name, and someone in the group lets you in\./)).toBeVisible();
    await guest.page.goto(`/join/${token}`);
    await expect(guest.page.getByText('You’re asking to join', { exact: true })).toBeVisible();
    await expect(
      guest.page.getByText(/^Someone in the group lets you in\. Then you can see everything in it and add to it\./)
    ).toBeVisible();
    await who(guest.page, 'Priya').click();
    await button(guest.page, 'Ask to join as Priya').click();

    await expect(guest.page.getByText('Asked to join')).toBeVisible();
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('as Priya')).toBeVisible();
    await expect(guest.page.getByText('Waiting', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Someone in Goa trip has to let you in. If they ask, tell them your code:')).toBeVisible();
    const askerCode = (await guest.page.getByText(JOIN_CODE).textContent())!;
    await expect(guest.page.getByText('Groups', { exact: true }).first()).toBeVisible();
    await expect(guest.page.getByText('No groups yet')).toBeHidden();

    await expect(yash.page.getByText('Asking to join')).toBeVisible({ timeout: 15_000 });
    await expect(yash.page.getByText('Someone wants to join as Priya')).toBeVisible();
    await expect(yash.page.getByText(`Code ${askerCode} · just now`, { exact: true })).toBeVisible();
    await expect(yash.page.getByText('Only let in if it’s Priya. Ask which code they see.')).toBeVisible();

    await button(yash.page, 'Let in').click();
    await expect(yash.page.getByText('Asking to join')).toBeHidden();
    await groupTab(yash.page, 'Members');
    await expect(memberRow(yash.page, 'Priya').getByText('In app')).toBeVisible({ timeout: 15_000 });

    await expect(guest.page.getByText('Asked to join')).toBeHidden({ timeout: 15_000 });
    await expect(guest.page.getByText('2 members', { exact: true })).toBeVisible();
    await openGroup(guest.page, 'Goa trip');
    await groupTab(guest.page, 'Members');
    await expect(guest.page.getByText('Priya (you)')).toBeVisible();
  });

  test('someone new to the group asks too, and is turned down', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await yash.api.setApproveJoins(group.id, true);
    const token = await groupLinkToken(yash.api, group.id);
    await openGroup(yash.page, 'Goa trip', { reload: true });

    const guest = await device();
    await guest.page.goto(`/join/${token}`);
    await guest.page.getByText('I’m not on this list').click();
    await guest.page.getByPlaceholder('Your name').fill('Kabir');
    await button(guest.page, 'Ask to join as Kabir').click();
    await expect(guest.page.getByText('as Kabir')).toBeVisible();

    await expect(yash.page.getByText('Kabir wants to join', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(yash.page.getByText(/^Code \d{4} · just now · new to the group$/)).toBeVisible();
    await expect(yash.page.getByText('They’ll see and add to Goa trip.')).toBeVisible();
    await button(yash.page, 'Not them').click();
    await expect(yash.page.getByText('Asking to join')).toBeHidden();

    await expect(
      guest.page.getByText(
        'Nobody let you in as Kabir. If that is you, ask again from the group’s link, and tell someone in Goa trip your code.'
      )
    ).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('Waiting', { exact: true })).toBeHidden();
    await button(guest.page, 'OK').click();
    await expect(guest.page.getByText('Asked to join')).toBeHidden();
    await expect(guest.page.getByText('No groups yet')).toBeVisible();
    expect(await yash.api.members(group.id)).toHaveLength(2);
  });

  test('a request can be taken back, and asking again replaces it', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya', 'Om'] });
    await yash.api.setApproveJoins(group.id, true);
    const token = await groupLinkToken(yash.api, group.id);
    await openGroup(yash.page, 'Goa trip', { reload: true });

    const guest = await device();
    await guest.page.goto(`/join/${token}`);
    await who(guest.page, 'Priya').click();
    await button(guest.page, 'Ask to join as Priya').click();
    await expect(guest.page.getByText('as Priya')).toBeVisible();
    await expect(yash.page.getByText('Someone wants to join as Priya')).toBeVisible({ timeout: 15_000 });

    await button(guest.page, 'Take back my request').click();
    await expect(guest.page.getByText('Asked to join')).toBeHidden();
    await expect(guest.page.getByText('No groups yet')).toBeVisible();
    await expect(yash.page.getByText('Asking to join')).toBeHidden({ timeout: 15_000 });

    // Picked the wrong name: picking the right one leaves one request, not two.
    await guest.page.goto(`/join/${token}`);
    await who(guest.page, 'Priya').click();
    await button(guest.page, 'Ask to join as Priya').click();
    await expect(guest.page.getByText('as Priya')).toBeVisible();
    await guest.page.goto(`/join/${token}`);
    await who(guest.page, 'Om').click();
    await button(guest.page, 'Ask to join as Om').click();
    await expect(guest.page.getByText('as Om')).toBeVisible();
    await expect(guest.page.getByText('as Priya')).toBeHidden();
    await expect.poll(() => yash.api.pendingJoins(group.id)).toHaveLength(1);
    await expect(yash.page.getByText('Someone wants to join as Om')).toBeVisible({ timeout: 15_000 });
    await expect(yash.page.getByText('Someone wants to join as Priya')).toBeHidden();
  });

  test('two people asking to be one name are told apart by their codes, and one yes turns the other down', async ({
    person,
    device,
  }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    await yash.api.setApproveJoins(group.id, true);
    const token = await groupLinkToken(yash.api, group.id);

    const first = await device();
    const second = await device();
    for (const guest of [first, second]) {
      await guest.page.goto(`/join/${token}`);
      await who(guest.page, 'Priya').click();
      await button(guest.page, 'Ask to join as Priya').click();
      await expect(guest.page.getByText('as Priya')).toBeVisible();
    }
    const firstCode = (await first.page.getByText(JOIN_CODE).textContent())!;
    const secondCode = (await second.page.getByText(JOIN_CODE).textContent())!;

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await expect(yash.page.getByText('Someone wants to join as Priya')).toHaveCount(2);
    await expect(yash.page.getByText('More than one person wants to be Priya. Ask Priya which code they see.')).toHaveCount(2);
    await expect(yash.page.getByText(`Code ${firstCode} · just now`)).toBeVisible();
    await expect(yash.page.getByText(`Code ${secondCode} · just now`)).toBeVisible();

    // Let the first one in, by their code.
    await ancestor(yash.page.getByText(`Code ${firstCode} · just now`), 3).getByText('Let in', { exact: true }).click();
    await expect(yash.page.getByText('Asking to join')).toBeHidden();

    await expect(first.page.getByText('Asked to join')).toBeHidden({ timeout: 15_000 });
    await expect(first.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(second.page.getByText(/^Nobody let you in as Priya\./)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Taking a name back from a lost device', () => {
  test('the old device sees the request as its own, the maker vouches, and the name moves', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Priya' });
    const token = await groupLinkToken(yash.api, group.id);

    const oldPhone = await device();
    await oldPhone.page.goto(`/join/${token}`);
    await who(oldPhone.page, 'Priya').click();
    await button(oldPhone.page, 'Join as Priya').click();
    await openGroup(oldPhone.page, 'Goa trip');

    const newPhone = await device();
    await newPhone.page.goto(`/join/${token}`);
    const priya = who(newPhone.page, 'Priya');
    await expect(priya.getByText('Joined', { exact: true })).toBeVisible();
    await priya.click();
    await expect(
      newPhone.page.getByText(
        /^Priya has already joined\. Pick this only if it’s you, on a new phone or browser\. Someone in the group, or your old device, has to let you in; then you take over Priya as it is, and the old device leaves the group\./
      )
    ).toBeVisible();
    await button(newPhone.page, 'Ask to be Priya again').click();
    await expect(newPhone.page.getByText('as Priya')).toBeVisible();
    await expect(
      newPhone.page.getByText(
        'Someone in Goa trip, or the device you joined with, has to let you in. Then you’re Priya here again, and the old device leaves the group. If they ask, tell them your code:'
      )
    ).toBeVisible();
    const code = (await newPhone.page.getByText(JOIN_CODE).textContent())!;

    // The device that has the name is asked whether it's them.
    await expect(oldPhone.page.getByText('Someone wants to take over your place')).toBeVisible({ timeout: 15_000 });
    await expect(oldPhone.page.getByText('Only if it’s you on a new device. This one then leaves Goa trip.')).toBeVisible();
    await expect(oldPhone.page.getByText(`Code ${code} · just now`)).toBeVisible();

    // Whoever made the group can vouch instead.
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await expect(yash.page.getByText('Someone says they’re Priya, on a new device')).toBeVisible({ timeout: 15_000 });
    await expect(
      yash.page.getByText('Only if you’ve checked with Priya: their old device leaves Goa trip. Ask which code they see.')
    ).toBeVisible();
    await button(yash.page, 'Let in').click();
    await expect(yash.page.getByText('Asking to join')).toBeHidden();

    await expect(newPhone.page.getByText('Asked to join')).toBeHidden({ timeout: 15_000 });
    await openGroup(newPhone.page, 'Goa trip');
    await groupTab(newPhone.page, 'Members');
    await expect(newPhone.page.getByText('Priya (you)')).toBeVisible();
    await expect(newPhone.page.getByText('You owe', { exact: true })).toBeVisible();
    await tab(newPhone.page, 'Account');
    await expect(newPhone.page.getByText('Priya', { exact: true })).toBeVisible();

    // The old device: its open group screen keeps what it last read (see the test below), and the group is gone once it looks again.
    await back(oldPhone.page);
    await expect(oldPhone.page.getByText('No groups yet')).toBeVisible();
    const members = await yash.api.members(group.id);
    expect(members.filter((m) => m.displayName === 'Priya')).toHaveLength(1);
  });

  test('the device whose place was taken is told it has left the group', async ({ person, device }) => {
    test.slow();
    test.fail(
      true,
      'BUG: a group screen left open on the old device keeps its last reading for good, request card and Let in button included. Its 4 s refresh gets 404 (not a member any more) and useAsync.refresh swallows the failure, so nothing says the group is gone until Back is tapped. GroupDetailScreen.tsx refresh(), SattleProvider.tsx useAsync refresh().'
    );
    const yash = await person('Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya'] });
    const token = await groupLinkToken(yash.api, group.id);
    const oldPhone = await device();
    await oldPhone.page.goto(`/join/${token}`);
    await who(oldPhone.page, 'Priya').click();
    await button(oldPhone.page, 'Join as Priya').click();
    await openGroup(oldPhone.page, 'Goa trip');

    const newPhone = await device();
    await newPhone.page.goto(`/join/${token}`);
    await who(newPhone.page, 'Priya').click();
    await button(newPhone.page, 'Ask to be Priya again').click();
    await expect(newPhone.page.getByText('as Priya')).toBeVisible();
    await expect(oldPhone.page.getByText('Someone wants to take over your place')).toBeVisible({ timeout: 15_000 });

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await button(yash.page, 'Let in').click();
    await expect(yash.page.getByText('Asking to join')).toBeHidden();
    await expect(newPhone.page.getByText('Asked to join')).toBeHidden({ timeout: 15_000 });

    // The old device has left the group. Within a couple of its own refreshes it should say so, or at least stop offering to let someone in.
    await expect(oldPhone.page.getByText('Someone wants to take over your place')).toBeHidden({ timeout: 12_000 });
  });
});

test.describe('Paying from the group page by UPI', () => {
  test('I’ve paid is a claim the person owed confirms, and then everyone sees it settled', async ({ person, device }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    await yash.api.setUpiId('yash@okaxis');
    const token = await groupLinkToken(yash.api, group.id);

    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();

    await button(guest.page, 'Pay by UPI').click();
    await expect(guest.page.getByText('Scan with any UPI app.')).toBeVisible();
    await expect(guest.page.getByText('Yash’s UPI ID')).toBeVisible();
    await expect(guest.page.getByText('yash@okaxis', { exact: true })).toBeVisible();
    await guest.page.getByRole('button', { name: 'Copy UPI ID' }).click();
    await expect(guest.page.getByText('Copied.', { exact: true })).toBeVisible();
    expect(await clipboard(guest.page)).toBe('yash@okaxis');
    await expect(button(guest.page, 'Open a UPI app on this phone')).toBeVisible();
    await expect(guest.page.getByText('Pay ₹300, then tap below. Yash confirms it arrived, and then it’s settled.')).toBeVisible();

    // Tapping it again closes the panel; once more opens it.
    await button(guest.page, 'Pay by UPI').click();
    await expect(guest.page.getByText('Yash’s UPI ID')).toBeHidden();
    await button(guest.page, 'Pay by UPI').click();
    await expect(guest.page.getByText('Yash’s UPI ID')).toBeVisible();

    await button(guest.page, 'I’ve paid').click();
    await expect(guest.page.getByText('Someone said this was paid by UPI. Waiting for Yash to confirm it arrived.')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden();
    await expect(button(guest.page, 'Pay with Lightning')).toBeHidden();

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await groupTab(yash.page, 'Settle up');
    await expect(
      yash.page.getByText('Someone on a shared link says Om paid you ₹300 by UPI. Did it arrive? Check your UPI app.')
    ).toBeVisible({ timeout: 15_000 });
    await button(yash.page, 'Yes, I got it').click();
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('All settled. Nobody owes anything.')).toBeVisible({ timeout: 15_000 });

    await button(yash.page, 'History').click();
    await expect(yash.page.getByText('Om paid Yash', { exact: true })).toBeVisible();
    await expect(yash.page.getByText(/^Paid by UPI, confirmed by Yash · /)).toBeVisible();
  });

  test('It didn’t arrive sends the guest back to paying, and the payee can still say it arrived after all', async ({
    person,
    device,
  }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    await yash.api.setUpiId('yash@okaxis');
    const token = await groupLinkToken(yash.api, group.id);

    const guest = await device();
    await openGroupPage(guest.page, token);
    await button(guest.page, 'Pay by UPI').click();
    await button(guest.page, 'I’ve paid').click();
    await expect(guest.page.getByText(/^Someone said this was paid by UPI\./)).toBeVisible();

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await groupTab(yash.page, 'Settle up');
    await expect(yash.page.getByText(/^Someone on a shared link says Om paid you/)).toBeVisible({ timeout: 15_000 });
    await button(yash.page, 'It didn’t arrive').click();
    await expect(yash.page.getByText('You said Om’s UPI payment of ₹300 didn’t arrive.')).toBeVisible();
    await expect(button(yash.page, 'It arrived after all')).toBeVisible();
    await expect(button(yash.page, 'It didn’t arrive')).toBeHidden();

    await expect(
      guest.page.getByText('Yash says the UPI payment didn’t arrive. Check with them before paying again.')
    ).toBeVisible({ timeout: 15_000 });
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();

    await button(yash.page, 'It arrived after all').click();
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('All settled. Nobody owes anything.')).toBeVisible({ timeout: 15_000 });
  });

  test('turning UPI off for shared links takes the button off the page', async ({ person, device, api }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    await yash.api.setUpiId('yash@okaxis');
    const token = await groupLinkToken(yash.api, group.id);
    const ref = (await api.groupGuestView(token)).debts[0].ref;

    const guest = await device();
    await openGroupPage(guest.page, token);
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible();
    expect((await api.raw('GET', `/g/${token}/debts/${ref}/upi`, undefined, { token: null })).status).toBe(200);

    // For all their groups, from Wallet.
    await tab(yash.page, 'Wallet');
    const upi = section(yash.page, 'UPI');
    await button(upi, 'Turn off for shared links').click();
    await expect(upi.getByText(/^Off\. Someone paying from a group’s shared link, without the app, can’t pay you by UPI\./)).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden({ timeout: 15_000 });
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();
    const refused = await api.raw<{ code: string }>('GET', `/g/${token}/debts/${ref}/upi`, undefined, { token: null });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('member_cannot_receive');

    // Back on, then off for this group alone, from Manage.
    await button(upi, 'Let shared links show it').click();
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible({ timeout: 15_000 });
    await tab(yash.page, 'Groups');
    await openGroup(yash.page, 'Goa trip', { reload: true });
    await openManage(yash.page);
    const link = section(yash.page, 'Group link');
    await expect(link.getByText('On, as in Wallet for all your groups.')).toBeVisible();
    await button(link, 'Turn off for this group').click();
    await expect(link.getByText('Off, chosen for this group.')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden({ timeout: 15_000 });
    await button(link, 'Use my Wallet setting here').click();
    await expect(link.getByText('On, as in Wallet for all your groups.')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible({ timeout: 15_000 });
  });
});
