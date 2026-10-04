import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient invites', () => {
  it('makes one link for the group, and the page it opens offers everyone in it', async () => {
    const c = client();
    expect(await c.getGroupInvite('g-goa')).toBeNull();
    const invite = await c.createInvite('g-goa');
    expect(invite).toEqual({ token: expect.any(String), groupId: 'g-goa', createdAt: expect.any(String), expiresAt: expect.any(String) });
    expect(await c.getGroupInvite('g-goa')).toEqual(invite);

    const view = await c.getInvite(invite.token);
    expect(view).toMatchObject({ groupName: 'Goa trip', invitedBy: 'Yash' });
    // Everyone, in the group's order, with whether someone has joined as them.
    expect(view.members.map((m) => [m.name, m.joined])).toEqual([
      ['Yash', true],
      ['Om', true],
      ['Aman', false],
      ['Priya', true],
    ]);
    // Names and refs only: nothing on the page is a member id.
    for (const m of view.members) expect(m.ref).not.toMatch(/^m-/);
  });

  it('only honours the newest link for a group', async () => {
    const c = client();
    const first = await c.createInvite('g-goa');
    const second = await c.createInvite('g-goa');
    await expect(c.getInvite(first.token)).rejects.toMatchObject({ code: 'not_found' });
    expect((await c.getInvite(second.token)).groupName).toBe('Goa trip');
  });

  it('can be turned off', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa');
    await c.removeInvite('g-goa');
    expect(await c.getGroupInvite('g-goa')).toBeNull();
    await expect(c.getInvite(invite.token)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('won’t let its one user join a group they’re already in', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa');
    const aman = (await c.getInvite(invite.token)).members.find((m) => m.name === 'Aman')!;
    await expect(c.acceptInvite(invite.token, { ref: aman.ref })).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.acceptInvite(invite.token, { displayName: 'Someone new' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await c.getMembers('g-goa')).toHaveLength((await c.getGroup('g-goa')).memberIds.length);
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('turns away an empty or overlong name before anything else, as the server does', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa');
    await expect(c.acceptInvite(invite.token, { displayName: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.acceptInvite(invite.token, { displayName: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.acceptInvite('nope', { displayName: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is not_found for a token nobody made', async () => {
    await expect(client().getInvite('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
