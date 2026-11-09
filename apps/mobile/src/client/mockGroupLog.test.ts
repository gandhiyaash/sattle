import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

/** The group as sync has it. Asked with no version, the answer is never "unchanged". */
async function synced(c: MockClient, groupId: string) {
  const answer = await c.sync();
  if (answer.unchanged) throw new Error('asked with no version, yet unchanged');
  return answer.groups.find((g) => g.group.id === groupId)!;
}

describe('MockClient’s group log, kept as the server keeps it', () => {
  it('notes each change to the group, with the user’s member as who made it, and nothing for no change', async () => {
    const c = client();
    const goa = await synced(c, 'g-goa');
    const me = goa.members.find((m) => m.displayName === 'Yash')!.id;
    expect(goa.log).toEqual([]);

    await c.setSimplifyDebts('g-goa', !goa.group.simplifyDebts);
    await c.setApproveJoins('g-goa', goa.group.approveJoins);
    await c.renameGroup('g-goa', 'Goa 2026');
    await c.createGroupLink('g-goa');
    await c.createGroupLink('g-goa');
    await c.removeGroupLink('g-goa');
    await c.removeGroupLink('g-goa');
    const dev = await c.addMember('g-goa', 'Dev');
    await c.removeMember('g-goa', dev.id);

    const { log } = await synced(c, 'g-goa');
    expect(log.map((l) => [l.byMemberId, l.change])).toEqual([
      [me, { kind: 'simplify_debts', on: !goa.group.simplifyDebts }],
      [me, { kind: 'renamed', from: 'Goa trip', to: 'Goa 2026' }],
      [me, { kind: 'link_made' }],
      [me, { kind: 'link_replaced' }],
      [me, { kind: 'link_off' }],
      [me, { kind: 'member_added', name: 'Dev' }],
      [me, { kind: 'member_removed', name: 'Dev' }],
    ]);
  });

  it('puts the log in the group’s history, newest first', async () => {
    const c = client();
    await c.renameGroup('g-goa', 'Goa 2026');
    const history = await c.getHistory('g-goa');
    expect(history[0]).toMatchObject({ kind: 'group_changed', change: { kind: 'renamed', to: 'Goa 2026' } });
  });
});
