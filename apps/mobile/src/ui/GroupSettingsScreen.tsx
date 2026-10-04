/**
 * Managing a group: its name, who is in it, leaving it, deleting it.
 *
 * Everything here follows one rule, the server's (groupRules.ts): nobody can
 * undo what someone else is owed. So the only member who can be removed is
 * one nothing has been built on, a group is deleted only once it's settled,
 * and what a person can always do is take themselves out. Each action says
 * what it leaves behind before the second tap.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import {
  computeBalances,
  invitePath,
  isInProgress,
  simplifyDebts,
  type Invite,
  type Member,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
import {
  Avatar,
  Button,
  Card,
  ConfirmButton,
  Divider,
  ErrorState,
  Loading,
  Screen,
  SectionLabel,
} from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface GroupSettingsScreenProps {
  groupId: string;
  onBack: () => void;
  /** The user left the group, or it was deleted: there's nothing to go back to. */
  onGone: () => void;
}

interface Settings {
  name: string;
  members: Member[];
  myMemberId: string | null;
  /** Ghosts that no expense or payment names. */
  removable: Set<string>;
  /** People with an account, the user included. */
  accounts: number;
  settled: boolean;
  /** A payment in the group hasn't finished. The server won't delete the group until it has. */
  paying: boolean;
  /** The group's invite, if it has one that still works. */
  invite: Invite | null;
}

export function GroupSettingsScreen({ groupId, onBack, onGone }: GroupSettingsScreenProps) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();

  const { data, loading, error, reload } = useAsync<Settings>(async () => {
    const [user, group, members, expenses, settlements, invite] = await Promise.all([
      client.getCurrentUser(),
      client.getGroup(groupId),
      client.getMembers(groupId),
      client.getExpenses(groupId),
      client.getSettlements(groupId),
      client.getGroupInvite(groupId),
    ]);
    const named = new Set<string>();
    for (const e of expenses) {
      named.add(e.paidByMemberId);
      for (const p of e.parts) named.add(p.memberId);
    }
    for (const s of settlements) {
      named.add(s.fromMemberId);
      named.add(s.toMemberId);
    }
    return {
      name: group.name,
      members,
      myMemberId: members.find((m) => m.claimedByUserId === user.id)?.id ?? null,
      removable: new Set(members.filter((m) => !m.claimedByUserId && !named.has(m.id)).map((m) => m.id)),
      accounts: members.filter((m) => m.claimedByUserId).length,
      settled: simplifyDebts(groupId, computeBalances(group.memberIds, expenses, settlements)).length === 0,
      paying: settlements.some(isInProgress),
      invite,
    };
  }, [groupId]);

  if (loading) {
    return (
      <Screen title="Manage group" onBack={onBack}>
        <Loading lines={3} />
      </Screen>
    );
  }
  if (error || !data) {
    return (
      <Screen title="Manage group" onBack={onBack}>
        <ErrorState message={error?.message ?? 'Could not load this group.'} onRetry={reload} />
      </Screen>
    );
  }

  const alone = data.accounts <= 1;

  return (
    <Screen title="Manage group" subtitle={data.name} onBack={onBack}>
      <Rename groupId={groupId} name={data.name} onRenamed={reload} />

      <View>
        <SectionLabel>Members</SectionLabel>
        <Card style={{ padding: 0 }}>
          {data.members.map((member, i) => (
            <View key={member.id}>
              {i > 0 && <Divider />}
              <View style={s.memberRow}>
                <Avatar name={member.displayName} dim={member.status === 'ghost'} />
                <Text style={s.memberName}>
                  {member.displayName}
                  {member.id === data.myMemberId ? ' (you)' : ''}
                </Text>
              </View>
              {data.removable.has(member.id) && (
                <View style={s.memberAction}>
                  <ConfirmButton
                    label={`Remove ${member.displayName}`}
                    confirmLabel={`Yes, remove ${member.displayName}`}
                    onConfirm={async () => {
                      await keys.run('remove-member', { groupId, id: member.id }, (k) =>
                        client.removeMember(groupId, member.id, k)
                      );
                      reload();
                    }}
                  />
                </View>
              )}
            </View>
          ))}
        </Card>
        <Text style={s.note}>
          Only someone added by mistake can be removed. Once a person is in an expense or a payment they stay in the
          group’s history, and someone who has joined can only leave by themselves.
        </Text>
      </View>

      <View>
        <SectionLabel>Invite</SectionLabel>
        <Card style={{ gap: space.md }}>
          {data.invite ? (
            <>
              <Text style={s.body}>
                Anyone holding this link can join, as one of the people who haven’t yet or by adding themselves,
                and from then on see everything in the group and add to it. It stops working a week after it was
                made.
              </Text>
              <Text style={s.url} selectable numberOfLines={1}>
                {`${APP_URL}${invitePath(data.invite.token)}`}
              </Text>
              <ConfirmButton
                label="Make a new invite"
                confirmLabel="Yes, replace the invite"
                hint="The old one stops working for everyone who has it."
                onConfirm={async () => {
                  await keys.run('replace-invite', { groupId, old: data.invite!.token }, (k) => client.createInvite(groupId, k));
                  reload();
                }}
              />
              <ConfirmButton
                label="Turn off the invite"
                confirmLabel="Yes, turn it off"
                onConfirm={async () => {
                  await keys.run('remove-invite', { groupId, old: data.invite!.token }, (k) => client.removeInvite(groupId, k));
                  reload();
                }}
              />
            </>
          ) : (
            <Text style={s.body}>
              This group has no invite, so nobody new can join it. The share icon on the group screen makes one.
            </Text>
          )}
        </Card>
      </View>

      <View>
        <SectionLabel>Leave</SectionLabel>
        <Card style={{ gap: space.md }}>
          <Text style={s.body}>
            {alone
              ? 'You’re the only one here with an account, so nobody could open this group after you. Delete it instead.'
              : 'You stop seeing this group. Your name and balance stay in it, and anything owed to you can then be marked settled by whoever owes it. An invite brings you back.'}
          </Text>
          {!alone && (
            <ConfirmButton
              label="Leave this group"
              confirmLabel="Yes, leave"
              onConfirm={async () => {
                await keys.run('leave', { groupId }, (k) => client.leaveGroup(groupId, k));
                onGone();
              }}
            />
          )}
        </Card>
      </View>

      <View>
        <SectionLabel>Delete</SectionLabel>
        <Card style={{ gap: space.md }}>
          <Text style={s.body}>
            {data.paying
              ? 'A payment in this group is still in progress. The group can be deleted once it has finished.'
              : data.settled
                ? 'Deletes the group and everything in it, for everyone. This can’t be undone.'
                : 'A group can only be deleted once nothing is owed in it, so that deleting it can’t erase a debt. Settle up first.'}
          </Text>
          {data.settled && !data.paying && (
            <ConfirmButton
              label="Delete this group"
              confirmLabel="Yes, delete it for everyone"
              onConfirm={async () => {
                await keys.run('delete-group', { groupId }, (k) => client.deleteGroup(groupId, k));
                onGone();
              }}
            />
          )}
        </Card>
      </View>
    </Screen>
  );
}

function Rename({ groupId, name, onRenamed }: { groupId: string; name: string; onRenamed: () => void }) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = draft.trim();
  const save = async () => {
    if (!next || next === name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await keys.run('rename', { groupId, name: next }, (k) => client.renameGroup(groupId, next, k));
      onRenamed();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t rename it. Try again.');
      setBusy(false);
    }
  };

  return (
    <View>
      <SectionLabel>Name</SectionLabel>
      <Card style={{ gap: space.sm }}>
        <View style={s.renameRow}>
          <TextInput
            style={s.input}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={save}
            returnKeyType="done"
            maxLength={80}
            placeholder="Group name"
            placeholderTextColor={color.inkFaint}
          />
          <Button label="Save" busy={busy} disabled={!next || next === name} onPress={save} />
        </View>
        {error && <Text style={s.error}>{error}</Text>}
      </Card>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  body: { ...type.body, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18, marginTop: space.sm },
  error: { ...type.caption, color: color.danger },
  url: { ...type.amountSm, color: color.inkFaint },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  memberName: { ...type.body, flex: 1, fontWeight: '500', color: color.ink },
  // Lines up under the name: row padding, avatar, gap.
  memberAction: { paddingLeft: space.lg + 36 + space.md, paddingRight: space.lg, paddingBottom: space.md },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  input: {
    flex: 1,
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
  },
}));
