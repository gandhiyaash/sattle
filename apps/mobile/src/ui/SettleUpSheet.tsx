/**
 * Settle up.
 *
 * Three screens in one sheet, chosen by flow.step:
 *
 *   opening           nothing asked yet; with one way to pay, it starts on its own
 *   choosing          rails, or the blocked screen if the recipient can't receive
 *   entering_address  paste an address for someone who never installed the app
 *   paying / done     lifecycle; on the invoice rail, the invoice to pay
 *   upi / upi_sent    what to pay in a UPI app, then waiting on the payee
 *
 * The blocked screen is not an error state. It offers the routes to the
 * same outcome that can work here, ordered by how likely they are to: get an
 * address (fastest, no install), invite them (best long-term), remind them to
 * connect a wallet, or record that it was handled outside the app. Which ones
 * apply comes from resolveSettlementOptions.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatFiat, type Debt, type Member } from '@sattle/core';
import { useSettleFlow } from '../react/useSettleFlow';
import { InvoicePanel } from './InvoicePanel';
import { Button, Card, ErrorState, QuoteBreakdown, SatLine } from './primitives';
import { share } from './share';
import { makeStyles, radius, space, type, useColors } from './theme';
import { UpiPanel } from './UpiPanel';

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
  const color = useColors();
  const s = useStyles();
  const flow = useSettleFlow(debt, members, groupName, currency);
  const [draft, setDraft] = useState('');
  // The quote ran out on screen before the server marked the invoice expired.
  const [lapsed, setLapsed] = useState(false);
  useEffect(() => setLapsed(false), [flow.settlement?.id]);
  const [invite, setInvite] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'sent'; url: string; note: string } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });

  const sendInvite = async () => {
    setInvite({ kind: 'busy' });
    try {
      const { url, message, sentNote } = await flow.createInvite(groupName);
      setInvite({ kind: 'sent', url, note: await share(message, sentNote) });
    } catch (e) {
      setInvite({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make the link. Try again.' });
    }
  };

  const recipient = members.find((m) => m.id === debt.toMemberId);
  const amount = formatFiat(debt.amount, currency);
  const [reminder, setReminder] = useState<string | null>(null);

  const sendReminder = async () => {
    if (!recipient) return;
    const message = `${recipient.displayName}, I want to pay you ${amount} for ${groupName} on Sattle. Set up receiving from Wallet in the app, with a wallet or your Lightning address, so it has somewhere to land.`;
    setReminder(await share(message, 'Sent.'));
  };

  if (!recipient || !flow.options) return null;

  // -- UPI -----------------------------------------------------------------

  if (flow.step === 'upi_sent') {
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Waiting for {recipient.displayName}</Text>
        <Text style={s.body}>
          You’ve told {recipient.displayName} you paid {amount} by UPI. It’s settled once they confirm it arrived.
        </Text>
        {flow.upiClaim?.reference && (
          <View style={s.receipt}>
            <Text style={s.receiptLabel}>UPI reference</Text>
            <Text style={s.receiptValue} numberOfLines={1}>
              {flow.upiClaim.reference}
            </Text>
          </View>
        )}
        <Button label="Done" variant="primary" onPress={onClose} />
      </View>
    );
  }

  if (flow.step === 'upi' && flow.upi) {
    // Only Android hears back from the UPI app. Whatever it said short of success leaves it to the payer.
    const said = flow.openUpiApp ? flow.upi.outcome?.status : undefined;
    const instructions =
      said === 'failed'
        ? 'Your UPI app says the payment didn’t go through. Nothing was recorded, and you can try again.'
        : said === 'pending'
          ? 'Your UPI app says the payment is still going through. Once it has, mark it as paid.'
          : said === 'unknown'
            ? 'Your UPI app didn’t say whether the payment went through. If it did, mark it as paid.'
            : flow.openUpiApp
              ? 'Your UPI app opens with the amount filled in. Pay there and you’re brought back here.'
              : `Pay ${amount} to ${recipient.displayName} in your UPI app, then come back here and mark it as paid.`;
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Pay {recipient.displayName} by UPI</Text>
        <View style={s.amountBlock}>
          <Text style={s.amount}>{amount}</Text>
        </View>
        <Text style={s.body}>{instructions}</Text>

        <UpiPanel payee={flow.upi.payee} uri={flow.upi.uri} busy={flow.busy} onOpen={flow.openUpiApp ?? undefined} />
        {flow.error && <ErrorState message={flow.error.message} />}

        <Button
          label="I’ve paid"
          variant={Platform.OS === 'web' ? 'primary' : 'secondary'}
          hint={`Tells ${recipient.displayName}, who confirms once it arrives.`}
          busy={flow.busy}
          onPress={flow.claimUpi}
        />
        <Button label="Back" variant="quiet" onPress={flow.leaveUpi} />
      </View>
    );
  }

  // -- paying / done -------------------------------------------------------

  // The payer pays this from their own wallet, so show them what to pay.
  const invoice =
    flow.step === 'paying' &&
    flow.settlement?.rail === 'invoice' &&
    flow.settlement.status === 'awaiting_payment' &&
    flow.settlement.destination
      ? flow.settlement
      : null;

  if (invoice) {
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Pay {recipient.displayName}</Text>
        <View style={s.amountBlock}>
          <Text style={s.amount}>{amount}</Text>
          {invoice.quote && <SatLine sats={invoice.quote.amountSat} />}
        </View>
        {invoice.quote && !lapsed && <QuoteBreakdown quote={invoice.quote} />}

        {lapsed ? (
          <>
            <Text style={s.body}>
              This invoice expired. Lightning invoices only last a few minutes, and the sats price moves. Nothing
              moved.
            </Text>
            <Button
              label="Get a new invoice"
              variant="primary"
              busy={flow.busy}
              onPress={() => flow.choose('invoice')}
            />
          </>
        ) : (
          <>
            <InvoicePanel
              invoice={invoice.destination!}
              expiresAt={invoice.quote?.expiresAt}
              onExpired={() => setLapsed(true)}
            />
            <View style={s.waitingInline}>
              <ActivityIndicator color={color.accent} size="small" />
              <Text style={s.waitingNote}>Waiting for the payment. This updates on its own.</Text>
            </View>
          </>
        )}
      </View>
    );
  }

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
          onChangeText={(text) => {
            setDraft(text);
            if (flow.error) flow.clearError();
          }}
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

  // -- opening: one way to pay starts itself, so there's nothing to tap yet --

  if (flow.opening) {
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Pay {recipient.displayName} {amount}</Text>
        <View style={s.waiting}>
          <ActivityIndicator color={color.accent} />
        </View>
      </View>
    );
  }

  // -- blocked: recipient has nowhere to receive ---------------------------

  if (flow.options.blocked) {
    const { message, remedies } = flow.options.blocked;
    const first = remedies[0];
    return (
      <View style={s.sheet}>
        <Text style={s.title}>You owe {recipient.displayName} {amount}</Text>
        <Text style={s.body}>{message}</Text>

        {remedies.includes('add_address') && (
          <Button
            label="Add their Lightning address"
            variant={first === 'add_address' ? 'primary' : 'secondary'}
            hint="Fastest route. Works with any wallet they already have."
            onPress={flow.startAddressEntry}
          />
        )}

        {remedies.includes('remind') && (
          <>
            <Button
              label={reminder ? `Remind ${recipient.displayName} again` : `Remind ${recipient.displayName}`}
              variant={first === 'remind' ? 'primary' : 'secondary'}
              hint="Sends them a note to set up receiving."
              onPress={sendReminder}
            />
            {reminder && <Text style={s.inviteNote}>{reminder}</Text>}
          </>
        )}

        {remedies.includes('invite') && (
          <>
            <Button
              label={invite.kind === 'sent' ? `Invite ${recipient.displayName} again` : `Invite ${recipient.displayName}`}
              variant={first === 'invite' ? 'primary' : 'secondary'}
              hint="They see the group and can get paid here from then on."
              busy={invite.kind === 'busy'}
              onPress={sendInvite}
            />
            {invite.kind === 'sent' && (
              <View style={s.inviteResult}>
                <Text style={s.inviteNote}>{invite.note}</Text>
                <Text style={s.inviteUrl} selectable numberOfLines={1}>
                  {invite.url}
                </Text>
              </View>
            )}
            {invite.kind === 'failed' && <Text style={s.error}>{invite.message}</Text>}
          </>
        )}

        {remedies.includes('mark_settled') && (
          <Button
            label="Mark as settled"
            hint="Paid in cash, or forgiven."
            busy={flow.busy}
            onPress={() => flow.markManual('Settled outside the app')}
          />
        )}

        <Button label="Close" variant="quiet" onPress={onClose} />
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
          // A greyed-out button says why, not what it would have done.
          hint={option.availability.available ? option.detail : (option.availability.reason ?? option.detail)}
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

const useStyles = makeStyles((color) => ({
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
  inviteResult: { gap: space.xs, marginLeft: space.xs, marginBottom: space.sm },
  inviteNote: { ...type.caption, color: color.inkMuted },
  inviteUrl: { ...type.amountSm, color: color.inkFaint },

  waiting: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  waitingInline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, marginTop: space.md },
  amountBlock: { alignItems: 'center', gap: space.xs, marginBottom: space.md },
  amount: { ...type.amountLg, color: color.ink },
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
}));
