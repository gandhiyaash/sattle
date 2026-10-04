import { describe, expect, it } from 'vitest';

import { joinedGroupFor } from './joinedGroup';
import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('joinedGroupFor', () => {
  it('finds the group behind an invite for someone already in it', async () => {
    const c = client();
    const goa = await c.createInvite('g-goa');
    const flat = await c.createInvite('g-flat');
    expect(await joinedGroupFor(c, goa.token)).toBe('g-goa');
    expect(await joinedGroupFor(c, flat.token)).toBe('g-flat');
  });

  it('is null for an invite to a group they aren’t in, or one that was replaced', async () => {
    const c = client();
    expect(await joinedGroupFor(c, 'someone-elses')).toBeNull();
    const old = await c.createInvite('g-goa');
    await c.createInvite('g-goa');
    expect(await joinedGroupFor(c, old.token)).toBeNull();
  });

  it('still finds it when another group’s invite can’t be read', async () => {
    const c = client();
    const { token } = await c.createInvite('g-flat');
    const read = c.getGroupInvite.bind(c);
    c.getGroupInvite = (groupId) => (groupId === 'g-goa' ? Promise.reject(new Error('offline')) : read(groupId));
    expect(await joinedGroupFor(c, token)).toBe('g-flat');
  });
});
