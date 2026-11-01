/**
 * Asked once, at launch, of someone with nowhere yet to be paid: no Lightning
 * address, no UPI ID, and no wallet connected under Wallet either. Until they
 * add one, nobody who owes them can pay them in Sattle, and the group screen
 * only says so (GetPaidCard) once somebody does owe them.
 *
 * It offers the two ways most people have, typed in right here: a Lightning
 * address to be paid in bitcoin and a UPI ID to be paid in rupees, only those
 * that go with the currencies they use (payWays). Both are under Wallet
 * afterwards, to change or remove.
 *
 * Saving answers it, and so do Skip and closing the sheet any other way: the
 * device remembers (getPaidStore) and never asks again. Someone who leaves
 * the app with it up is asked at the next launch, and so is someone whose app
 * opened on something else, a link say: it's only asked over the groups list,
 * and not once the app has been anywhere else.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { parseUpiId, upiIdHasPhoneNumber, type PayWays } from '@sattle/core';
import { useScreenView } from '../analytics/useScreenView';
import type { SattleClient } from '../client/SattleClient';
import { usePayWays } from '../prefs/useCurrencyPrefs';
import { useClient } from '../react/SattleProvider';
import { readGetPaidAsked, writeGetPaidAsked } from './getPaidStore';
import { Button, Glyph, SheetBody } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

/**
 * Whether to ask now, and `done` for once it's answered. `home`: the groups
 * list is what's showing. The answers it waits on come a moment after launch,
 * and if the app has gone elsewhere by then, it's left for the next one.
 */
export function useAskToGetPaid(home: boolean): { asking: boolean; done: () => void } {
  const client = useClient();
  const [due, setDue] = useState(false);
  const [launching, setLaunching] = useState(home);
  useEffect(() => {
    if (!home) setLaunching(false);
  }, [home]);
  useEffect(() => {
    let live = true;
    // Offline, or the server can't say: it's asked at a launch that can tell.
    shouldAsk(client).then((ask) => live && ask && setDue(true), () => {});
    return () => {
      live = false;
    };
  }, [client]);
  const done = useCallback(() => {
    setDue(false);
    // If that can't be kept, it's asked once more.
    void writeGetPaidAsked().catch(() => {});
  }, []);
  return { asking: due && launching && home, done };
}

/** A device that hasn't asked, and an account with nowhere to be paid. */
async function shouldAsk(client: SattleClient): Promise<boolean> {
  if (await readGetPaidAsked()) return false;
  const [wallet, address, upi] = await Promise.all([
    client.getWalletConnection(),
    client.getReceiveAddress(),
    client.getUpiId(),
  ]);
  return !wallet.connected && !address.address && !upi.upiId;
}

/** One way to be paid, as the sheet holds it. */
interface Field {
  input: string;
  /** What the server kept, once it has. The field shows that in place of the input. */
  saved: string | null;
  error: string | null;
}

const EMPTY: Field = { input: '', saved: null, error: null };

/** What the server kept, or why it didn't. */
async function attempt(save: () => Promise<string | null>): Promise<Pick<Field, 'saved' | 'error'>> {
  try {
    return { saved: await save(), error: null };
  } catch (e) {
    return { saved: null, error: e instanceof Error ? e.message : 'Couldn’t save that. Try again.' };
  }
}

const SUBTITLES = {
  both: 'Add a Lightning address to be paid in bitcoin, a UPI ID to be paid in rupees, or both. People who owe you pay you there, straight from their own app.',
  lightning: 'Add your Lightning address, and people who owe you pay you there, straight from their own wallet.',
  upi: 'Add your UPI ID, and people who owe you pay you there, straight from GPay, PhonePe or any UPI app.',
};

const subtitleFor = (ways: PayWays) => SUBTITLES[ways.lightning && ways.upi ? 'both' : ways.lightning ? 'lightning' : 'upi'];

/**
 * Save sends what's typed, both at once. A field the server took shows what
 * it kept. One it refused keeps what was typed, with why, to fix and save
 * again, or to leave: Skip, which becomes Done once something is saved.
 */
export function GetPaidSheet({ onDone }: { onDone: () => void }) {
  useScreenView('Get paid');
  const s = useStyles();
  const client = useClient();
  const ways = usePayWays();
  const [address, setAddress] = useState<Field>(EMPTY);
  const [upi, setUpi] = useState<Field>(EMPTY);
  const [busy, setBusy] = useState(false);
  const upiInput = useRef<TextInput>(null);

  const both = ways.lightning && ways.upi;
  // With the UPI ID still to fill in, Enter in the address goes on to it, rather than saving the address alone.
  const toUpi = ways.upi && !upi.saved ? () => upiInput.current?.focus() : undefined;
  const toSave = {
    address: ways.lightning && !address.saved ? address.input.trim() : '',
    upi: ways.upi && !upi.saved ? upi.input.trim() : '',
  };
  // Only once it reads as a whole UPI ID, so the warning doesn't come and go as digits are typed.
  const typed = parseUpiId(toSave.upi);
  const hasPhone = typed.ok && upiIdHasPhoneNumber(typed.upiId);

  const save = async () => {
    if (busy || (!toSave.address && !toSave.upi)) return;
    setBusy(true);
    const [a, u] = await Promise.all([
      toSave.address ? attempt(async () => (await client.setReceiveAddress(toSave.address)).address) : null,
      toSave.upi ? attempt(async () => (await client.setUpiId(toSave.upi)).upiId) : null,
    ]);
    if (a) setAddress((f) => ({ ...f, ...a }));
    if (u) setUpi((f) => ({ ...f, ...u }));
    setBusy(false);
    if (!a?.error && !u?.error) onDone();
  };

  return (
    <SheetBody title="How should people pay you?" subtitle={subtitleFor(ways)}>
      {ways.lightning && (
        <WayField
          label="Lightning address"
          use={both ? 'bitcoin' : undefined}
          field={address}
          onChange={(input) => setAddress({ ...EMPTY, input })}
          onSubmit={save}
          onNext={toUpi}
          placeholder="you@walletofsatoshi.com"
          about="Wallet of Satoshi, Phoenix, Blink and most other wallets give you one. It looks like an email."
        />
      )}
      {ways.upi && (
        <WayField
          label="UPI ID"
          use={both ? 'rupees' : undefined}
          field={upi}
          onChange={(input) => setUpi({ ...EMPTY, input })}
          onSubmit={save}
          inputRef={upiInput}
          placeholder="name@okhdfcbank"
          // Before an ID is saved, shared links show it: that is where a new one starts.
          about="People who owe you see it, and so does anyone holding one of your groups’ shared links. You can turn that off under Wallet once it’s saved."
        >
          {hasPhone && (
            <View style={s.warning}>
              <Text style={s.warningTitle}>This UPI ID has a phone number in it</Text>
              <Text style={s.warningBody}>
                Everyone shown it would see the number. Most UPI apps let you add an ID without one, like
                name@okhdfcbank, in their UPI settings. You can still save this one.
              </Text>
            </View>
          )}
        </WayField>
      )}
      <View style={{ gap: space.sm }}>
        <Button
          label={hasPhone ? 'Save anyway' : 'Save'}
          variant="primary"
          busy={busy}
          disabled={!toSave.address && !toSave.upi}
          onPress={save}
        />
        <Button label={address.saved || upi.saved ? 'Done' : 'Skip'} variant="quiet" onPress={onDone} />
      </View>
      <Text style={s.note}>
        You won’t be asked again. You can add or change {both ? 'these' : 'it'} under Wallet.
      </Text>
    </SheetBody>
  );
}

function WayField({
  label,
  use,
  field,
  onChange,
  onSubmit,
  onNext,
  inputRef,
  placeholder,
  about,
  children,
}: {
  label: string;
  /** The currency it's paid in, said beside the label when the sheet offers both. */
  use?: string;
  field: Field;
  onChange: (input: string) => void;
  /** Save: what Enter does in the last field to fill in. */
  onSubmit: () => void;
  /** There's another field to fill in after this one: Enter goes on to it, with the keyboard still up. */
  onNext?: () => void;
  inputRef?: React.Ref<TextInput>;
  placeholder: string;
  about: string;
  /** Under the input, while it's still one. */
  children?: React.ReactNode;
}) {
  const color = useColors();
  const s = useStyles();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={s.label}>
        {label}
        {use && <Text style={s.use}> · {use}</Text>}
      </Text>
      {field.saved ? (
        <View style={s.saved} accessible accessibilityLabel={`${label} saved: ${field.saved}`}>
          <Glyph name="check" ink={color.owed} size={18} weight={2.4} />
          <Text style={s.savedValue}>{field.saved}</Text>
        </View>
      ) : (
        <>
          <TextInput
            ref={inputRef}
            style={s.input}
            value={field.input}
            onChangeText={onChange}
            returnKeyType={onNext ? 'next' : 'done'}
            submitBehavior={onNext ? 'submit' : undefined}
            onSubmitEditing={onNext ?? onSubmit}
            placeholder={placeholder}
            placeholderTextColor={color.inkFaint}
            accessibilityLabel={label}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          {field.error && <Text style={s.error}>{field.error}</Text>}
          {children}
          <Text style={s.about}>{about}</Text>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.ink },
  use: { fontWeight: '400', color: color.inkFaint },
  about: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18, textAlign: 'center' },
  saved: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 46 },
  savedValue: { ...type.amountMd, flex: 1, color: color.ink },
  warning: { gap: space.xs, padding: space.md, borderRadius: radius.md, backgroundColor: color.dangerWash },
  warningTitle: { ...type.label, color: color.danger },
  warningBody: { ...type.caption, color: color.ink, lineHeight: 18 },
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
  error: { ...type.caption, color: color.danger },
}));
