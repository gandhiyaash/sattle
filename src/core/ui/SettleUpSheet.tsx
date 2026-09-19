/**
 * Settle up.
 *
 * Three screens in one sheet, chosen by flow.step:
 *
 *   choosing          rails, or the blocked screen if the recipient can't receive
 *   entering_address  paste an address for someone who never installed the app
 *   paying / done     lifecycle
 *
 * The blocked screen is not an error state. It offers three routes to the
 * same outcome, ordered by how likely they are to actually work: get an
 * address (fastest, no install), invite them (best long-term), or record
 * that it was handled outside the app.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatFiat } from '../domain/ledger';
import type { Debt, Member } from '../domain/types';
import { useSettleFlow } from '../react/useSettleFlow';
import { Button, Card, ErrorState, SatLine } from './primitives';
import { color, radius, space, type } from './theme';

export interface SettleUpSheetProps {
  debt: Debt;
  members: Member[];
  groupName: string;
  currency?: string;
  onClose: () => void;
}

export function SettleUpSheet({
  debt,
  members,
  groupName,
  currency = 'INR',
  onClose,
}: SettleUpSheetProps) {
  const flow = useSettleFlow(debt, members, groupName);
  const [draft, setDraft] = useState('');

  const recipient = members.find((m) => m.id === debt.toMemberId);
  const amount = formatFiat(debt.amount, currency);

  if (!recipient || !flow.options) return null;

  // -- paying / done -------------------------------------------------------

  if (flow.step === 'paying' || flow.step === 'done') {
    const done = flow.step === 'done';
    return (
      <View style={s.sheet}>
        <Text style={s.title}>{done ? 'Settled' : 'Waiting for payment'}</Text>
        <Text style={s.body}>
          {done
            ? `${amount} to ${recipient.displayName} is settled.`
            : `Sending ${amount} to ${recipient.displayName}.`}
        </Text>

        {!done && (
          <View style={s.waiting}>
            <ActivityIndicator color={color.accent} />
            <Text style={s.waitingStep}>
              {flow.settlement?.status === 'in_flight'
                ? 'Payment in flight'
                : 'Creating the invoice'}
            </Text>
            <Text style={s.waitingNote}>
              The balance only moves when the payment proof arrives.
            </Text>
          </View>
        )}

        {done && flow.settlement?.preimage && (
          <View style={s.receipt}>
            <Text style={s.receiptLabel}>Payment proof</Text>
            <Text style={s.receiptValue} numberOfLines={1}>
              {flow.settlement.preimage}
            </Text>
          </View>
        )}

        {done && <Button label="Done" variant="primary" onPress={onClose} />}
      </View>
    );
  }

  // -- address entry -------------------------------------------------------

  if (flow.step === 'entering_address') {
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Where should this go?</Text>
        <Text style={s.body}>
          Ask {recipient.displayName} for their Lightning address. Any wallet
          gives them one, and they don't need this app to receive.
        </Text>

        <TextInput
          style={[s.input, flow.error && s.inputError]}
          value={draft}
          onChangeText={setDraft}
          placeholder="aman@walletofsatoshi.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        {flow.error && <Text style={s.error}>{flow.error.message}</Text>}

        <Button
          label="Save address"
          variant="primary"
          busy={flow.busy}
          onPress={() => flow.savePayoutAddress(draft)}
        />
        <Button label="Back" variant="quiet" onPress={flow.cancelAddressEntry} />
      </View>
    );
  }

  // -- blocked: recipient has nowhere to receive ---------------------------

  if (flow.options.blocked) {
    const invite = flow.buildInvite(groupName);

    return (
      <View style={s.sheet}>
        <Text style={s.title}>You owe {recipient.displayName} {amount}</Text>
        <Text style={s.body}>{flow.options.blocked.message}</Text>

        <Button
          label="Add their Lightning address"
          variant="primary"
          hint="Fastest route. Works with any wallet they already have."
          onPress={flow.startAddressEntry}
        />

        {invite && (
          <Button
            label={`Invite ${recipient.displayName}`}
            hint="They see the group and can get paid here from then on."
            onPress={() => Share.share({ message: invite.message, url: invite.url })}
          />
        )}

        <Button
          label="Mark as settled"
          hint="Paid in cash, or forgiven."
          busy={flow.busy}
          onPress={() => flow.markManual('Settled outside the app')}
        />
      </View>
    );
  }

  // -- normal: pick a rail -------------------------------------------------

  return (
    <View style={s.sheet}>
      <Text style={s.title}>Pay {recipient.displayName} {amount}</Text>

      {flow.options.rails.map((option) => (
        <Button
          key={option.rail}
          label={option.label}
          hint={option.detail}
          variant={option.rank === 1 ? 'primary' : 'secondary'}
          busy={flow.busy}
          disabled={!option.availability.available}
          onPress={() => flow.choose(option.rail)}
        />
      ))}

      {flow.error && <ErrorState message={flow.error.message} />}
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { padding: space.xl, gap: space.sm, backgroundColor: color.surface },
  title: { ...type.title, color: color.ink, marginBottom: space.xs },
  body: { ...type.body, color: color.inkMuted, marginBottom: space.md },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
    marginBottom: space.sm,
  },
  inputError: { borderColor: color.danger },
  error: { ...type.caption, color: color.danger, marginBottom: space.sm },

  waiting: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  waitingStep: { ...type.body, color: color.ink },
  waitingNote: { ...type.caption, color: color.inkFaint, textAlign: 'center' },

  receipt: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
    marginBottom: space.md,
  },
  receiptLabel: { ...type.caption, color: color.inkFaint },
  receiptValue: { ...type.amountSm, color: color.inkMuted },
});
