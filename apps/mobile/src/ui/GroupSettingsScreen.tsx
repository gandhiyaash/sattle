/**
 * Managing a group: its name, its link, its backup, leaving it, deleting it.
 * Who is in it is on the group screen, under Members.
 *
 * Everything here follows one rule, the server's (groupRules.ts): nobody can
 * undo what someone else is owed. So a group is deleted only once it's
 * settled, and what a person can always do is take themselves out.
 *
 * The screen says little until asked. What a thing is sits behind Learn more;
 * what an action leaves behind is said between the first tap and the second.
 */

import React, { useState } from 'react';
import { Linking, Platform, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  computeBalances,
  groupLinkPath,
  isInProgress,
  simplifyDebts,
  UPI_CURRENCY,
  type GroupLink,
  type UpiOnGroupLink,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  Divider,
  ErrorState,
  LearnMore,
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
  /** People with an account, the user included. */
  accounts: number;
  settled: boolean;
  /** A payment in the group hasn't finished. The server won't delete the group until it has. */
  paying: boolean;
  /** The group's link, if someone has made one. */
  link: GroupLink | null;
  /**
   * Whether that link may show the user's UPI ID. Null where there's nothing
   * to choose: the group isn't in rupees, or they have no UPI ID.
   */
  linkUpi: UpiOnGroupLink | null;
}

export function GroupSettingsScreen({ groupId, onBack, onGone }: GroupSettingsScreenProps) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();

  const { data, loading, error, reload } = useAsync<Settings>(async () => {
    const [group, members, expenses, settlements, link, upi, linkUpi] = await Promise.all([
      client.getGroup(groupId),
      client.getMembers(groupId),
      client.getExpenses(groupId),
      client.getSettlements(groupId),
      client.getGroupLink(groupId),
      client.getUpiId(),
      client.getUpiOnGroupLink(groupId),
    ]);
    return {
      name: group.name,
      accounts: members.filter((m) => m.claimedByUserId).length,
      settled: simplifyDebts(groupId, computeBalances(group.memberIds, expenses, settlements)).length === 0,
      paying: settlements.some(isInProgress),
      link,
      linkUpi: group.currency === UPI_CURRENCY && upi.upiId ? linkUpi : null,
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

      <GroupLinkSection groupId={groupId} link={data.link} upi={data.linkUpi} />

      <LedgerBackupSection groupId={groupId} />

      <View>
        <SectionLabel>Leave</SectionLabel>
        <Card style={{ gap: space.md }}>
          {alone ? (
            <Text style={s.body}>Only you have an account here, so delete the group instead.</Text>
          ) : (
            <>
              <ConfirmButton
                label="Leave this group"
                confirmLabel="Yes, leave"
                confirmHint="Anything owed to you can then be marked settled by whoever owes it."
                onConfirm={async () => {
                  await keys.run('leave', { groupId }, (k) => client.leaveGroup(groupId, k));
                  onGone();
                }}
              />
              <LearnMore>
                You stop seeing this group. Your name and balance stay in it, and the group’s link brings you back.
              </LearnMore>
            </>
          )}
        </Card>
      </View>

      <View>
        <SectionLabel>Delete</SectionLabel>
        <Card style={{ gap: space.md }}>
          {data.paying ? (
            <Text style={s.body}>A payment is still in progress. Delete the group once it has finished.</Text>
          ) : data.settled ? (
            <ConfirmButton
              label="Delete this group"
              confirmLabel="Yes, delete it for everyone"
              confirmHint="Everything in it goes, for everyone. This can’t be undone."
              onConfirm={async () => {
                await keys.run('delete-group', { groupId }, (k) => client.deleteGroup(groupId, k));
                onGone();
              }}
            />
          ) : (
            <>
              <Text style={s.body}>Settle up first.</Text>
              <LearnMore>
                A group can only be deleted once nothing is owed in it, so that deleting it can’t erase a debt.
              </LearnMore>
            </>
          )}
        </Card>
      </View>
    </Screen>
  );
}

/**
 * The group's one link, which the share icon on the group screen hands out.
 * Whoever holds it sees the spends and who owes whom and can pay a debt, with
 * no app and no account, and can ask to join. This is where it is replaced
 * or turned off: that is how a link that went to the wrong place is taken
 * back.
 *
 * In a rupee group, someone with a UPI ID also chooses here whether this
 * group's link may show it. Wallet holds that choice for all their groups,
 * on from the start; this is the same choice for this group alone, and it
 * wins.
 */
function GroupLinkSection({
  groupId,
  link: loaded,
  upi: loadedUpi,
}: {
  groupId: string;
  link: GroupLink | null;
  upi: UpiOnGroupLink | null;
}) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  // Kept here once loaded, so replacing it or turning it off doesn't blank the screen to read it all again.
  const [link, setLink] = useState(loaded);
  const [upi, setUpi] = useState(loadedUpi);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseUpi = async (on: boolean | null) => {
    setBusy(true);
    setError(null);
    try {
      setUpi(await client.setUpiOnGroupLink(groupId, on));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t change that. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <SectionLabel>Group link</SectionLabel>
      <Card style={{ gap: space.md }}>
        {link ? (
          <>
            <Text style={s.url} selectable numberOfLines={1}>
              {`${APP_URL}${groupLinkPath(link.token)}`}
            </Text>
            <LearnMore>
              Anyone holding this link can see the group’s spends and who owes what, and pay a debt, with no app.
              They can’t change anything. They can ask to join, and someone here has to let them in.
            </LearnMore>
            <ConfirmButton
              label="Make a new link"
              confirmLabel="Yes, replace the link"
              confirmHint="The old one stops working for everyone who has it."
              onConfirm={async () => {
                setLink(await keys.run('replace-link', { groupId, old: link.token }, (k) => client.createGroupLink(groupId, k)));
              }}
            />
            <ConfirmButton
              label="Turn off the link"
              confirmLabel="Yes, turn it off"
              confirmHint="Nobody can open the group with it or ask to join, until someone shares the group again."
              onConfirm={async () => {
                await keys.run('remove-link', { groupId, old: link.token }, (k) => client.removeGroupLink(groupId, k));
                setLink(null);
              }}
            />
          </>
        ) : (
          <Text style={s.body}>No link yet. The share icon on the group screen makes one.</Text>
        )}

        {upi && (
          <>
            <Divider />
            <Text style={s.label}>Your UPI ID on this group’s link</Text>
            <Text style={s.body}>
              {upi.choice === null
                ? `${upi.on ? 'On' : 'Off'}, as in Wallet for all your groups.`
                : `${upi.on ? 'On' : 'Off'}, chosen for this group.`}
            </Text>
            <LearnMore>
              {upi.on
                ? 'Someone paying from the link, without the app, can pay you by UPI. They see your UPI ID when they choose to pay you, so turn this off if the link has gone further than people you know.'
                : 'Someone paying from the link, without the app, can’t pay you by UPI. Turn it on and anyone holding the link can see your UPI ID, so only if the link stays with people you know.'}
            </LearnMore>
            <Button
              label={upi.on ? 'Turn off for this group' : 'Turn on for this group'}
              busy={busy}
              onPress={() => chooseUpi(!upi.on)}
            />
            {upi.choice !== null && (
              <Button label="Use my Wallet setting here" variant="quiet" disabled={busy} onPress={() => chooseUpi(null)} />
            )}
          </>
        )}
        {error && <Text style={s.error}>{error}</Text>}
      </Card>
    </View>
  );
}

/**
 * The group's ledger on Nostr: how much of it is out on relays, and the key
 * that reads it back. The key decrypts the whole group, so it's copied, not
 * shared to a chat by default.
 */
function LedgerBackupSection({ groupId }: { groupId: string }) {
  const s = useStyles();
  const client = useClient();
  const { data } = useAsync(() => client.getLedgerBackup(groupId), [groupId]);
  const [note, setNote] = useState<string | null>(null);

  // Nothing to back up before the first expense.
  if (!data || data.entries === 0) return null;

  const hosts = data.relays.map((r) => r.replace(/^wss?:\/\//, '').replace(/\/$/, '')).join(', ');
  const entries = `${data.entries} ${data.entries === 1 ? 'entry' : 'entries'}`;
  const status =
    data.relays.length === 0
      ? `${entries} signed. This server isn’t publishing to relays yet.`
      : data.published < data.entries
        ? `${data.published} of ${entries} on ${hosts}. The rest go out shortly.`
        : `${data.entries === 1 ? 'The entry is' : `All ${entries}`} on ${hosts}.`;

  const copy = async () => {
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(data.uri);
        setNote('Copied. It unlocks this group’s history, so only give it to people in the group.');
      } catch {
        setNote('Copy the key below by hand:');
      }
      return;
    }
    const r = await Share.share({ message: data.uri }).catch(() => null);
    setNote(r?.action === Share.sharedAction ? 'Saved. Keep it somewhere only you can read.' : 'Here’s the key:');
  };

  return (
    <View>
      <SectionLabel>Backup</SectionLabel>
      <Card style={{ gap: space.sm }}>
        <View style={s.backupTop}>
          <Text style={s.backupTitle}>Backed up on Nostr</Text>
          {data.relays.length > 0 && data.published === data.entries && <Badge text="Up to date" tone="accent" />}
        </View>
        <Text style={s.caption}>{status}</Text>
        <LearnMore>
          Signed and encrypted, so relays keep it without reading it. With the backup key, anyone in the group can
          rebuild these balances without Sattle.
        </LearnMore>
        <View style={s.backupActions}>
          {data.latest && (
            <Button
              label="See it on a relay"
              variant="quiet"
              onPress={() => Linking.openURL(`https://njump.me/${data.latest}`)}
            />
          )}
          <Button label="Copy backup key" variant="quiet" onPress={copy} />
        </View>
        {note && (
          <>
            <Text style={s.caption}>{note}</Text>
            <Text style={s.url} selectable numberOfLines={2}>
              {data.uri}
            </Text>
          </>
        )}
      </Card>
    </View>
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
  label: { ...type.label, color: color.inkMuted },
  caption: { ...type.caption, color: color.inkMuted },
  error: { ...type.caption, color: color.danger },
  url: { ...type.amountSm, color: color.inkFaint },
  backupTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  backupTitle: { ...type.body, fontWeight: '600', color: color.ink },
  backupActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
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
