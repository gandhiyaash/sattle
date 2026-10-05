/**
 * Choosing a Nostr signer and getting a proof from it: the browser
 * extension when there is one, or a bunker:// link from a remote signer.
 * Used to sign in with Nostr (WelcomeScreen) and to link a key (AccountScreen).
 * `onProof` takes it from there; if it throws, the message shows here.
 */

import React, { useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Event } from 'nostr-tools';

import { hasExtension, proveNostrKey, type NostrSigner } from '../nostr/signer';
import { Button, ErrorState } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export function NostrKeyForm({
  path,
  action,
  onProof,
}: {
  /** Where the proof goes: NOSTR_AUTH_PATHS.signIn or .link. */
  path: string;
  /** What the buttons do, e.g. "sign in" or "link it". */
  action: string;
  onProof: (event: Event) => Promise<void>;
}) {
  const color = useColors();
  const s = useStyles();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<NostrSigner['kind'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const extension = hasExtension();

  const run = async (signer: NostrSigner) => {
    if (busy) return;
    setBusy(signer.kind);
    setError(null);
    setAuthUrl(null);
    try {
      await onProof(await proveNostrKey(signer, path, setAuthUrl));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(null);
      setAuthUrl(null);
    }
  };

  return (
    <View style={{ gap: space.md }}>
      {extension && (
        <Button
          label={`Use my Nostr extension to ${action}`}
          variant="primary"
          busy={busy === 'extension'}
          disabled={busy !== null}
          onPress={() => run({ kind: 'extension' })}
        />
      )}
      <View style={{ gap: space.sm }}>
        <Text style={s.label}>
          {extension ? 'Or paste a bunker link from your signer' : 'Paste a bunker link from your signer'}
        </Text>
        <TextInput
          style={s.input}
          value={link}
          onChangeText={setLink}
          placeholder="bunker://…"
          placeholderTextColor={color.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          editable={busy === null}
        />
        <Text style={s.note}>
          From a remote signer such as nsec.app or Amber: make a new connection there and copy its bunker:// link.
          Your private key stays in the signer.
        </Text>
        <Button
          label={`Connect and ${action}`}
          variant={extension ? 'secondary' : 'primary'}
          busy={busy === 'bunker'}
          disabled={busy !== null || !link.trim()}
          onPress={() => run({ kind: 'bunker', link })}
        />
      </View>
      {busy === 'bunker' && !authUrl && <Text style={s.note}>Waiting for your signer. Approve the request there.</Text>}
      {authUrl && (
        <View style={{ gap: space.sm }}>
          <Text style={s.note}>Your signer wants you to approve this in its own page.</Text>
          {/* A new tab on the web (react-native-web's openURL), so this page keeps waiting for the signer. */}
          <Button label="Open it" onPress={() => Linking.openURL(authUrl).catch(() => {})} />
        </View>
      )}
      {error && <ErrorState message={error} />}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
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
