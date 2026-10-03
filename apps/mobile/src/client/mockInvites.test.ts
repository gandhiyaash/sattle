import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient invites', () => {
  it('makes a link for a ghost, and the page it opens shows names only', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa', 'm-goa-aman');
    expect(invite).toMatchObject({ groupId: 'g-goa', memberId: 'm-goa-aman' });
    expect(await c.getInvite(invite.token)).toEqual({ groupName: 'Goa trip', memberName: 'Aman', invitedBy: 'Yash' });
  });

  it('refuses to invite someone who has already joined', async () => {
    await expect(client().createInvite('g-goa', 'm-goa-om')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('only honours the newest link for a ghost', async () => {
    const c = client();
    const first = await c.createInvite('g-goa', 'm-goa-aman');
    const second = await c.createInvite('g-goa', 'm-goa-aman');
    await expect(c.getInvite(first.token)).rejects.toMatchObject({ code: 'not_found' });
    expect((await c.getInvite(second.token)).memberName).toBe('Aman');
  });

  it('won’t let its one user join a group they’re already in', async () => {
    const c = client();
    const invite = await c.createInvite('g-goa', 'm-goa-aman');
    await expect(c.acceptInvite(invite.token)).rejects.toMatchObject({ code: 'conflict' });
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-aman')?.status).toBe('ghost');
  });

  it('is not_found for a token nobody made', async () => {
    await expect(client().getInvite('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
