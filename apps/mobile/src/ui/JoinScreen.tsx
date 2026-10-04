/**
 * Joining a group from an invite: arrive on /join/<token> or paste the link,
 * see who invited you to what, say which of the people in it you are, and join.
 *
 * Joining makes you that member, with the balance already on that name, and
 * from then on you can see and add to everything in the group. The screen
 * says so above the button.
 *
 * Nobody on the list types who they are. The group already has a row for each
 * person, so the page lists the ones nobody has joined as yet and the person
 * picks one. Someone the group hasn't listed taps + and gives their name, and
 * joins as a new member.
 */

import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SattleError, parseInviteToken, type JoinAs } from '@sattle/core';
import { clearToken, writeToken } from '../account/tokenStore';
import { createAccount } from '../client/ApiClient';
import { API_URL, buildClient, useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { Avatar, Button, Card, Divider, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface JoinScreenProps {
  /** From the link. Without one, the screen asks for the link first. */
  token?: string;
  onBack: () => void;
  onJoined: (groupId: string) => void;
}

/** For someone who already has an account on this device. */
export function JoinScreen({ token, onBack, onJoined }: JoinScreenProps) {
  const client = useClient();
  // A retry after a lost response replays the join instead of finding the name taken.
  const keys = useActionKeys();
  const [active, setActive] = useState(token ?? null);
  // What they're already called, for the name field if they add themselves.
  const me = useAsync(() => client.getCurrentUser(), [client]);

  return (
    <Screen title="Join a group" onBack={onBack}>
      {active ? (
        <WhoAreYou
          token={active}
          note="Once you join, you can see everything in this group and add to it."
          suggestedName={me.data?.displayName}
          join={async (as) => {
            const input = { token: active, as };
            const group = await keys.run('join', input, (k) => client.acceptInvite(input.token, input.as, k));
            onJoined(group.id);
          }}
          otherwise={{ label: 'Use a different link', onPress: () => setActive(null) }}
        />
      ) : (
        <PasteInvite onToken={setActive} />
      )}
    </Screen>
  );
}

/**
 * For someone who opened an invite with no account on this device. Saying who
 * they are is also how they get one: the account takes the name they picked,
 * or the one they gave if they added themselves.
 */
export function JoinAsNewScreen({
  token,
  onJoined,
  onSkip,
}: {
  token: string;
  /**
   * `accountToken` is the new account's, already saved on this device.
   * `groupId` is null when the account was made, the connection dropped, and they gave up on the invite.
   */
  onJoined: (accountToken: string, groupId: string | null) => void;
  /** The invite is no use to them, and they have no account yet. They start the app without it. */
  onSkip: () => void;
}) {
  // The account made for a join that hasn't gone through, and the name it was made under.
  // It exists to be that member. If they can't be, or they pick someone else, it is deleted,
  // so nobody ends up with an account named after a person they didn't join as.
  const made = useRef<{ token: string; name: string } | null>(null);
  const keys = useActionKeys();

  const forget = async () => {
    const stale = made.current;
    if (!stale) return;
    made.current = null;
    await clearToken();
    // Best effort: an account whose token nobody holds can't do anything.
    await buildClient(stale.token)
      .deleteAccount()
      .catch(() => {});
  };

  return (
    <Screen title="Sattle" subtitle="Split bills in sats. Only one of you needs the app.">
      <WhoAreYou
        // Another link starts its answers over. The screen itself stays, and with it the account in `made`.
        key={token}
        token={token}
        note="Once you join, you can see everything in this group and add to it. No email, phone or password: your account lives on this device, so if you clear its data or lose it, you lose access to your groups."
        join={async (as, name) => {
          if (made.current && made.current.name !== name) await forget();
          if (!made.current) {
            const account = await createAccount(API_URL, name);
            await writeToken(account.token);
            made.current = { token: account.token, name };
          }
          const accountToken = made.current.token;
          const input = { token, as };
          const group = await keys
            .run('join', input, (k) => buildClient(accountToken).acceptInvite(input.token, input.as, k))
            .catch(async (e) => {
              // A lost connection is worth keeping the account for: the retry replays this join.
              // Anything else means they can't be this person, so the account goes.
              if (!(e instanceof SattleError && e.code === 'network')) await forget();
              throw e;
            });
          onJoined(accountToken, group.id);
        }}
        otherwise={{
          label: 'Start without it',
          onPress: () => (made.current ? onJoined(made.current.token, null) : onSkip()),
        }}
      />
    </Screen>
  );
}

function PasteInvite({ onToken }: { onToken: (token: string) => void }) {
  const color = useColors();
  const s = useStyles();
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

/** The row that isn't anyone on the list. Refs are base64url or the mock's, so this is never one. */
const NEW = '+';

/**
 * Who invited you to what, the people you could be, and Join. Someone who
 * isn't one of them taps + and gives their own name. `join` does the joining
 * and leaves the screen; if it throws, the message is shown and the list is
 * read again, since the name may just have been taken.
 */
function WhoAreYou({
  token,
  note,
  suggestedName,
  join,
  otherwise,
}: {
  token: string;
  /** What joining means, above the button. */
  note: string;
  /** What someone adding themselves is already called, if they have an account. */
  suggestedName?: string;
  /** `name` is what they will be called in the group: the member's, or the one they typed. */
  join: (as: JoinAs, name: string) => Promise<void>;
  /** The way on when this invite can't be used. */
  otherwise: { label: string; onPress: () => void };
}) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const { data, loading, error, reload, refresh } = useAsync(() => client.getInvite(token), [token]);
  const [picked, setPicked] = useState<string | null>(null);
  // Null until they type, so a name that arrives late still fills the field.
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (loading) return <Loading lines={3} />;

  if (error || !data) {
    // Only a network failure is worth retrying; a dead link stays dead.
    const retry = error instanceof SattleError && error.code === 'network' ? reload : undefined;
    return (
      <>
        <ErrorState message={error?.message ?? 'Couldn’t load this invite.'} onRetry={retry} />
        <Button label={otherwise.label} onPress={otherwise.onPress} />
      </>
    );
  }

  // With nobody left to pick, adding yourself is the only way in.
  const adding = picked === NEW || data.members.length === 0;
  const member = adding ? null : (data.members.find((m) => m.ref === picked) ?? null);
  const draft = typed ?? suggestedName ?? '';
  const name = adding ? draft.trim() : (member?.name ?? '');

  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await join(member ? { ref: member.ref } : { displayName: name }, name);
    } catch (e) {
      // The choice stays. After a dropped connection the retry is one tap, with the name still
      // in the field; a name that was just taken leaves the list when it is read again.
      setFailed(e instanceof Error ? e.message : 'Couldn’t join. Try again.');
      setBusy(false);
      refresh();
    }
  };

  return (
    <>
      <Card style={{ gap: space.xs }}>
        <Text style={s.label}>{data.invitedBy} invited you to</Text>
        <Text style={s.group}>{data.groupName}</Text>
      </Card>

      <View>
        <SectionLabel>Who are you?</SectionLabel>
        <Card style={{ padding: 0 }}>
          {data.members.map((m, i) => {
            const on = m.ref === member?.ref;
            return (
              <View key={m.ref}>
                {i > 0 && <Divider />}
                <Pressable
                  onPress={() => setPicked(m.ref)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [s.row, i === 0 && s.rowFirst, (on || pressed) && s.rowOn]}
                >
                  <Avatar name={m.name} dim={!on} />
                  <Text style={s.name}>{m.name}</Text>
                  <View style={[s.radio, on && s.radioOn]}>{on && <View style={s.radioDot} />}</View>
                </Pressable>
              </View>
            );
          })}
          {data.members.length > 0 && <Divider />}
          <Pressable
            onPress={() => setPicked(NEW)}
            disabled={busy}
            accessibilityRole="radio"
            accessibilityState={{ selected: adding }}
            style={({ pressed }) => [
              s.row,
              data.members.length === 0 && s.rowFirst,
              !adding && s.rowLast,
              (adding || pressed) && s.rowOn,
            ]}
          >
            <View style={[s.plus, adding && { backgroundColor: color.surface }]}>
              <Text style={s.plusText}>+</Text>
            </View>
            <Text style={s.name}>{data.members.length === 0 ? 'Add yourself' : 'I’m not on this list'}</Text>
            <View style={[s.radio, adding && s.radioOn]}>{adding && <View style={s.radioDot} />}</View>
          </Pressable>
          {adding && (
            <View style={[s.adding, s.rowLast]}>
              <TextInput
                style={s.input}
                value={draft}
                onChangeText={setTyped}
                onSubmitEditing={submit}
                returnKeyType="done"
                placeholder="Your name"
                placeholderTextColor={color.inkFaint}
                maxLength={40}
                editable={!busy}
                autoFocus
              />
            </View>
          )}
        </Card>
        <Text style={s.hint}>
          {adding
            ? 'You’re added to the group as a new member, with nothing owed either way.'
            : 'You take over that name as it is, with the balance already on it.'}
        </Text>
      </View>

      <Text style={s.note}>{note}</Text>
      {failed && <ErrorState message={failed} />}
      <Button label={name ? `Join as ${name}` : 'Join'} variant="primary" busy={busy} disabled={!name} onPress={submit} />
    </>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  group: { ...type.display, color: color.ink },
  hint: { ...type.caption, color: color.inkFaint, lineHeight: 18, marginTop: space.sm },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  error: { ...type.caption, color: color.danger },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  // The card's corners are rounded and it doesn't clip, so the rows at its ends are too.
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowOn: { backgroundColor: color.accentWash },
  // The same circle an avatar is, for the row that has no name yet.
  plus: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusText: { ...type.heading, color: color.accent },
  adding: { backgroundColor: color.accentWash, paddingHorizontal: space.lg, paddingBottom: space.lg },
  name: { ...type.body, flex: 1, fontWeight: '500', color: color.ink },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: color.accent },
  radioDot: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: color.accent },
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
}));
