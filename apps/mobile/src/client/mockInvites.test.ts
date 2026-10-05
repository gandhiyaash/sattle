import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient joining, with the group’s link', () => {
  it('offers everyone who hasn’t joined, on the join page the group’s link opens', async () => {
    const c = client();
    const link = await c.createGroupLink('g-goa');

    const ghosts = (await c.getMembers('g-goa')).filter((m) => !m.claimedByUserId).map((m) => m.displayName);
    const view = await c.getInvite(link.token);
    expect(view.groupName).toBe('Goa trip');
    expect(view.members.map((m) => m.name)).toEqual(ghosts);
    expect(view.members.map((m) => m.name)).toContain('Aman');
    // The ones who have joined are named too, with nothing to pick them by.
    expect(view.joined).toEqual(['Yash', 'Om', 'Priya']);
    // Names and refs only: nothing on the page is a member id.
    for (const m of view.members) expect(m.ref).not.toMatch(/^m-/);
  });

  it('only honours the newest link for a group', async () => {
    const c = client();
    const first = await c.createGroupLink('g-goa');
    const second = await c.createGroupLink('g-goa');
    await expect(c.getInvite(first.token)).rejects.toMatchObject({ code: 'not_found' });
    expect((await c.getInvite(second.token)).groupName).toBe('Goa trip');
  });

  it('can be turned off', async () => {
    const c = client();
    const link = await c.createGroupLink('g-goa');
    await c.removeGroupLink('g-goa');
    expect(await c.getGroupLink('g-goa')).toBeNull();
    await expect(c.getInvite(link.token)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('names the group behind an link for its one user, who is in it', async () => {
    const c = client();
    const link = await c.createGroupLink('g-goa');
    expect((await c.getJoinedGroup(link.token))?.id).toBe('g-goa');

    await c.leaveGroup('g-goa');
    expect(await c.getJoinedGroup(link.token)).toBeNull();
    await expect(c.getJoinedGroup('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('won’t let its one user join a group they’re already in', async () => {
    const c = client();
    const link = await c.createGroupLink('g-goa');
    const aman = (await c.getInvite(link.token)).members.find((m) => m.name === 'Aman')!;
    await expect(c.askToJoin(link.token, { ref: aman.ref })).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.askToJoin(link.token, { displayName: 'Someone new' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await c.getMembers('g-goa')).toHaveLength((await c.getGroup('g-goa')).memberIds.length);
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('turns away an empty or overlong name before anything else, as the server does', async () => {
    const c = client();
    const link = await c.createGroupLink('g-goa');
    await expect(c.askToJoin(link.token, { displayName: '   ' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.askToJoin(link.token, { displayName: 'x'.repeat(41) })).rejects.toMatchObject({ code: 'invalid_input' });
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
    const link = await c.createGroupLink('g-goa');
    await c.leaveGroup('g-goa');
    const yash = (await c.getInvite(link.token)).members.find((m) => m.name === 'Yash')!;
    const asked = await c.askToJoin(link.token, { ref: yash.ref });
    expect(asked).toMatchObject({ groupName: 'Goa trip', name: 'Yash', status: 'pending' });
    expect(await c.getMyJoinRequests()).toEqual([asked]);
    expect((await c.getGroups()).map((g) => g.id)).not.toContain('g-goa');

    await c.withdrawJoinRequest(asked.id);
    expect(await c.getMyJoinRequests()).toEqual([]);
  });
});
