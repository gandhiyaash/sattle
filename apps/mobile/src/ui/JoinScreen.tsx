/**
 * Joining a group from an invite: arrive on /join/<token> or paste the link,
 * see who invited you to what, and accept.
 *
 * Accepting makes you the member the invite names, with the balance already
 * on that name, and from then on you can see and add to everything in the
 * group. The screen says so above the button.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { SattleError, parseInviteToken } from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { Button, Card, ErrorState, Loading, Screen } from './primitives';
import { color, radius, space, type } from './theme';

export interface JoinScreenProps {
  /** From the link. Without one, the screen asks for the link first. */
  token?: string;
  onBack: () => void;
  onJoined: (groupId: string) => void;
}

export function JoinScreen({ token, onBack, onJoined }: JoinScreenProps) {
  const [active, setActive] = useState(token ?? null);

  return (
    <Screen title="Join a group" onBack={onBack}>
      {active ? (
        <AcceptInvite token={active} onJoined={onJoined} onOtherLink={() => setActive(null)} />
      ) : (
        <PasteInvite onToken={setActive} />
      )}
    </Screen>
  );
}

function PasteInvite({ onToken }: { onToken: (token: string) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const token = parseInviteToken(draft);
    if (token) onToken(token);
    else setError('That doesn’t look like an invite link.');
  };

  return (
    <>
      <Card style={{ gap: space.sm }}>
        <Text style={s.label}>Paste the invite link you were sent.</Text>
        <TextInput
          style={[s.input, error !== null && { borderColor: color.danger }]}
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            setError(null);
          }}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder="https://…/join/…"
          placeholderTextColor={color.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {error && <Text style={s.error}>{error}</Text>}
      </Card>
      <Button label="Continue" variant="primary" disabled={!draft.trim()} onPress={submit} />
    </>
  );
}

function AcceptInvite({
  token,
  onJoined,
  onOtherLink,
}: {
  token: string;
  onJoined: (groupId: string) => void;
  onOtherLink: () => void;
}) {
  const client = useClient();
  // A retry after a lost response replays the join instead of finding the invite used.
  const keys = useActionKeys();
  const { data, loading, error, reload } = useAsync(() => client.getInvite(token), [token]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const join = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const group = await keys.run('join', { token }, (k) => client.acceptInvite(token, k));
      onJoined(group.id);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Couldn’t join. Try again.');
      setBusy(false);
    }
  };

  if (loading) return <Loading lines={2} />;

  if (error || !data) {
    // Only a network failure is worth retrying; a dead link stays dead.
    const retry = error instanceof SattleError && error.code === 'network' ? reload : undefined;
    return (
      <>
        <ErrorState message={error?.message ?? 'Couldn’t load this invite.'} onRetry={retry} />
        <Button label="Use a different link" onPress={onOtherLink} />
      </>
    );
  }

  return (
    <>
      <InviteCard invitedBy={data.invitedBy} groupName={data.groupName} memberName={data.memberName} />
      <Text style={s.note}>Once you join, you can see everything in this group and add to it.</Text>
      {failed && <ErrorState message={failed} />}
      <Button label={`Join ${data.groupName}`} variant="primary" busy={busy} onPress={join} />
    </>
  );
}

/**
 * Who invited you to what, on its own. The welcome screen shows it above the
 * name field, where there's no account yet to join with.
 */
export function InviteSummary({ token }: { token: string }) {
  const client = useClient();
  const { data, loading, error } = useAsync(() => client.getInvite(token), [token]);

  if (loading) return <Loading lines={1} />;
  if (error || !data) return <ErrorState message={error?.message ?? 'Couldn’t load this invite.'} />;
  return <InviteCard invitedBy={data.invitedBy} groupName={data.groupName} memberName={data.memberName} />;
}

function InviteCard({ invitedBy, groupName, memberName }: { invitedBy: string; groupName: string; memberName: string }) {
  return (
    <Card style={{ gap: space.xs }}>
      <Text style={s.label}>{invitedBy} invited you to</Text>
      <Text style={s.group}>{groupName}</Text>
      <Text style={s.body}>You’ll join as {memberName}, with the balance already on that name.</Text>
    </Card>
  );
}

const s = StyleSheet.create({
  label: { ...type.label, color: color.inkMuted },
  group: { ...type.display, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  error: { ...type.caption, color: color.danger },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
  },
});
