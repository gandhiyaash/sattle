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
    await expect(c.acceptInvite(invite.token, aman.ref)).rejects.toMatchObject({ code: 'conflict' });
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('is not_found for a token nobody made', async () => {
    await expect(client().getInvite('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
