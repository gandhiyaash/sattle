import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient invites', () => {
  it('makes one link for the group, and the page it opens offers everyone who hasn’t joined', async () => {
    const c = client();
    expect(await c.getGroupInvite('g-goa')).toBeNull();
    const invite = await c.createInvite('g-goa');
    expect(invite).toEqual({ token: expect.any(String), groupId: 'g-goa', createdAt: expect.any(String), expiresAt: expect.any(String) });
    expect(await c.getGroupInvite('g-goa')).toEqual(invite);

    const ghosts = (await c.getMembers('g-goa')).filter((m) => !m.claimedByUserId).map((m) => m.displayName);
    const view = await c.getInvite(invite.token);
    expect(view).toMatchObject({ groupName: 'Goa trip', invitedBy: 'Yash' });
    expect(view.members.map((m) => m.name)).toEqual(ghosts);
    expect(view.members.map((m) => m.name)).toContain('Aman');
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
    await expect(c.askToJoin(invite.token, { ref: aman.ref })).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.askToJoin(invite.token, { displayName: 'Someone new' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await c.getMembers('g-goa')).toHaveLength((await c.getGroup('g-goa')).memberIds.length);
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('turns away an empty or overlong name before anything else, as the server does', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa');
    await expect(c.askToJoin(invite.token, { displayName: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.askToJoin(invite.token, { displayName: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.askToJoin('nope', { displayName: '' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('is not_found for a token nobody made', async () => {
    await expect(client().getInvite('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('has someone waiting to be let into Goa trip, and letting them in makes them Aman', async () => {
    const c = client();
    const [waiting] = await c.getPendingJoins('g-goa');
    expect(waiting).toMatchObject({ name: 'Aman', existing: true, code: expect.stringMatching(/^\d{4}$/) });

    const aman = await c.approveJoin(waiting.id);
    expect(aman).toMatchObject({ id: 'm-goa-aman', status: 'joined', claimedByUserId: expect.any(String) });
    expect(await c.getPendingJoins('g-goa')).toEqual([]);
    await expect(c.approveJoin(waiting.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('can turn someone down, and then they can’t be let in', async () => {
    const c = client();
    const [waiting] = await c.getPendingJoins('g-goa');
    await c.declineJoin(waiting.id);
    expect(await c.getPendingJoins('g-goa')).toEqual([]);
    await expect(c.approveJoin(waiting.id)).rejects.toMatchObject({ code: 'conflict' });
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('lets its user ask back into a group they left, and waits for a yes', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa');
    await c.leaveGroup('g-goa');
    const yash = (await c.getInvite(invite.token)).members.find((m) => m.name === 'Yash')!;
    const asked = await c.askToJoin(invite.token, { ref: yash.ref });
    expect(asked).toMatchObject({ groupName: 'Goa trip', name: 'Yash', status: 'pending' });
    expect(await c.getMyJoinRequests()).toEqual([asked]);
    expect((await c.getGroups()).map((g) => g.id)).not.toContain('g-goa');

    await c.withdrawJoinRequest(asked.id);
    expect(await c.getMyJoinRequests()).toEqual([]);
  });
});
