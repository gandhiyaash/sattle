/**
 * Settle up.
 *
 * Three screens in one sheet, chosen by flow.step:
 *
 *   opening           nothing asked yet; with one way to pay, it starts on its own
 *   choosing          rails, or the blocked screen if the recipient can't receive
 *   entering_address  paste an address for someone who never installed the app
 *   paying / done     lifecycle; on the invoice rail, the invoice to pay
 *   upi               what to pay in a UPI app. On Android, the phone's UPI
 *                     apps to pick from; one that says the payment went
 *                     through settles it there and then, and the sheet goes
 *                     to done
 *   upi_copied        the same, under a popup saying the UPI ID was copied
 *                     for an app that refuses links (GPay, PhonePe), with
 *                     the button that opens it. Why they refuse is for the
 *                     FAQ, not the popup
 *   upi_ask           "Did the payment go through?", asked when the payer
 *                     comes back from a UPI app that says nothing (an iPhone,
 *                     a browser) and from "I've paid". Yes settles it, with
 *                     the reference their UPI app showed if they type it in
 *
 * The blocked screen is not an error state. It offers the routes to the
 * same outcome that can work here, ordered by how likely they are to: get an
 * address (fastest, no install), invite them (best long-term), remind them to
 * connect a wallet, or record that it was handled outside the app. Which ones
 * apply comes from resolveSettlementOptions.
 *
 * In a group kept in bitcoin the debt is in sats, so the invoice is for that
 * many and there is no rate to show.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatAmount, isBitcoin, type Debt, type Member, type PayWays } from '@sattle/core';
import { useSettleFlow } from '../react/useSettleFlow';
import { InvoicePanel } from './InvoicePanel';
import { refusesLinks } from '../upi/upiApps';
import { Button, Card, Dialog, ErrorState, QuoteBreakdown, SatLine } from './primitives';
import { share } from './share';
import { makeStyles, radius, space, type, useColors } from './theme';
import { UpiPanel } from './UpiPanel';
import { UpiReceiptRows } from './UpiReceiptRows';

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
  // The reference the payer may type in for a UPI payment they say went through.
  const [reference, setReference] = useState('');
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
  const amount = formatAmount(debt.amount, currency);
  const sats = isBitcoin(currency);
  const [reminder, setReminder] = useState<string | null>(null);

  const sendReminder = async () => {
    if (!recipient) return;
    const message = `${recipient.displayName}, I want to pay you ${amount} for ${groupName} on Sattle. ${howToGetPaid(flow.ways)}`;
    setReminder(await share(message, 'Sent.'));
  };

  if (!recipient || !flow.options) return null;

  // -- UPI -----------------------------------------------------------------

  if (flow.step === 'upi_ask') {
    const name = recipient.displayName;
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Did the payment go through?</Text>
        <Text style={s.body}>
          {amount} to {name}
        </Text>

        {!flow.paidByHand && (
          <>
            <TextInput
              style={[s.input, flow.error && s.inputError]}
              value={reference}
              onChangeText={(text) => {
                setReference(text);
                if (flow.error) flow.clearError();
              }}
              placeholder="UPI reference, if you have it"
              placeholderTextColor={color.inkFaint}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Text style={s.fieldNote}>
              The 12-digit number your UPI app shows.
            </Text>
          </>
        )}
        {flow.error && <Text style={s.error}>{flow.error.message}</Text>}

        <Button
          label="Yes, it went through"
          variant="primary"
          busy={flow.busy}
          onPress={() => flow.confirmPaid(flow.paidByHand ? '' : reference)}
        />
        <Button label="No, it didn’t go through" variant="quiet" disabled={flow.busy} onPress={flow.notPaid} />
      </View>
    );
  }

  if ((flow.step === 'upi' || flow.step === 'upi_copied') && flow.upi) {
    // Only Android hears back from the UPI app. Whatever it said short of success leaves it to the payer.
    const said = flow.payWith ? flow.upi.outcome?.status : undefined;
    const instructions =
      said === 'success'
        ? // Only still on this step if telling the server failed: otherwise the sheet has gone to Settled.
          'Paid, but not saved here yet. Tap Try again. Don’t pay twice.'
        : said === 'failed'
          ? 'It didn’t go through. Try again.'
          : said === 'pending'
            ? 'Still going through. Tap I’ve paid once it has.'
            : said === 'unknown'
              ? 'Did it go through? If so, tap I’ve paid.'
              : flow.upi.apps?.length
                ? pickAppLine(flow.upi.apps.filter(refusesLinks).map((app) => app.name))
                : // No list at all: the one button that opens whatever takes the link. An empty list is a
                  // phone with no UPI app, which the panel says, so it reads as an iPhone does.
                  flow.payWith && !flow.upi.apps
                  ? 'Your UPI app opens with the amount filled in.'
                  : `Pay in any UPI app, then tap I’ve paid.`;
    return (
      <View style={s.sheet}>
        <Text style={s.title}>Pay {recipient.displayName} by UPI</Text>
        <View style={s.amountBlock}>
          <Text style={s.amount}>{amount}</Text>
        </View>
        <Text style={s.body}>{instructions}</Text>

        <UpiPanel
          payee={flow.upi.payee}
          uri={flow.upi.uri}
          busy={flow.busy}
          apps={flow.upi.apps}
          onPay={flow.payWith ?? undefined}
          onOpened={flow.leftForUpi}
        />
        {flow.error && <ErrorState message={flow.error.message} />}

        {flow.recordUpiSuccess ? (
          <Button label="Try again" variant="primary" busy={flow.busy} onPress={flow.recordUpiSuccess} />
        ) : (
          <Button
            label="I’ve paid"
            variant={Platform.OS === 'web' ? 'primary' : 'secondary'}
            disabled={flow.busy}
            onPress={flow.askPaid}
          />
        )}
        <Button label="Back" variant="quiet" onPress={flow.leaveUpi} />

        {flow.copiedFor && (
          <Dialog visible={flow.step === 'upi_copied'} title="UPI ID copied" onClose={flow.dismissCopied}>
            <Text style={s.body}>
              Paste it in {flow.copiedFor.name} and pay {amount}. Then come back and tap I’ve paid.
            </Text>
            <Text style={s.copiedId} selectable>
              {flow.upi.payee.upiId}
            </Text>
            <Button label={`Open ${flow.copiedFor.name}`} variant="primary" onPress={flow.openCopiedApp} />
            <Button label="Cancel" variant="quiet" onPress={flow.dismissCopied} />
          </Dialog>
        )}
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
          {/* Under a rupee amount, what it comes to. A sats amount says it already. */}
          {invoice.quote && !sats && <SatLine sats={invoice.quote.amountSat} />}
        </View>
        {invoice.quote && !lapsed && <QuoteBreakdown quote={invoice.quote} />}

        {lapsed ? (
          <>
            <Text style={s.body}>
              {sats
                ? 'Expired. Get a new invoice if you haven’t paid.'
                : 'Expired, and the rate has moved. Get a new invoice if you haven’t paid.'}
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
              sats={sats}
            />
            <View style={s.waitingInline}>
              <ActivityIndicator color={color.accent} size="small" />
              <Text style={s.waitingNote}>Waiting for the payment…</Text>
            </View>
          </>
        )}
      </View>
    );
  }

  if (flow.step === 'paying' || flow.step === 'done') {
    const done = flow.step === 'done';
    // Set when it was settled because the payer's UPI app said the payment went through.
    const upiReceipt = done ? flow.settlement?.upi : undefined;
    return (
      <View style={s.sheet}>
        <Text style={s.title}>{done ? 'Settled' : 'Waiting for payment'}</Text>
        <Text style={s.body}>
          {upiReceipt
            ? `${
                upiReceipt.byPayer
                  ? `${amount} to ${recipient.displayName} is settled.`
                  : `Your UPI app says ${amount} went to ${recipient.displayName}, so it’s settled.`
              } ${recipient.displayName} has nothing to confirm.`
            : done
              ? `${amount} to ${recipient.displayName} is settled.`
              : `Sending ${amount} to ${recipient.displayName}.`}
        </Text>

        {!done && (
          <View style={s.waiting}>
            <ActivityIndicator color={color.accent} />
            <Text style={s.waitingStep}>
              {flow.settlement?.status === 'in_flight'
                ? 'Sending'
                : 'Getting ready'}
            </Text>
            <Text style={s.waitingNote}>
              This updates on its own.
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

        {/* What the UPI app handed back, or the reference the payer gave, and the app it was paid in:
            kept with the payment and shown in the group's history. A payer who gave none has nothing to show here. */}
        {upiReceipt && !(upiReceipt.byPayer && !upiReceipt.reference && !upiReceipt.paidWith) && (
          <View style={s.receiptRows}>
            <UpiReceiptRows receipt={upiReceipt} />
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
          Ask {recipient.displayName} for their Lightning address.
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
            onPress={flow.startAddressEntry}
          />
        )}

        {remedies.includes('remind') && (
          <>
            <Button
              label={reminder ? `Remind ${recipient.displayName} again` : `Remind ${recipient.displayName}`}
              variant={first === 'remind' ? 'primary' : 'secondary'}
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

/** What the reminder asks the person owed to do, in terms of the ways this payer could then pay them. */
function howToGetPaid(ways: PayWays): string {
  if (!ways.lightning) return 'Add your UPI ID in Sattle, under Wallet, so I can pay you.';
  return ways.upi
    ? 'Set up getting paid in Sattle, under Wallet, so I can pay you.'
    : 'Set up getting paid in Sattle, under Wallet, so I can pay you.';
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
  fieldNote: { ...type.caption, color: color.inkFaint, marginBottom: space.sm },
  inviteResult: { gap: space.xs, marginLeft: space.xs, marginBottom: space.sm },
  inviteNote: { ...type.caption, color: color.inkMuted },
  inviteUrl: { ...type.amountSm, color: color.inkFaint },

  waiting: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  waitingInline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, marginTop: space.md },
  amountBlock: { alignItems: 'center', gap: space.xs, marginBottom: space.md },
  amount: { ...type.amountLg, color: color.ink },
  copiedId: { ...type.amountMd, color: color.ink, marginBottom: space.sm },
  waitingStep: { ...type.body, color: color.ink },
  waitingNote: { ...type.caption, color: color.inkFaint, textAlign: 'center' },

  receipt: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
    marginBottom: space.md,
  },
  receiptRows: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    marginBottom: space.md,
  },
  receiptLabel: { ...type.caption, color: color.inkFaint },
  receiptValue: { ...type.amountSm, color: color.inkMuted },
}));

/** The line over the apps: what picking one does, naming any that are paid in by hand instead. */
function pickAppLine(refusing: string[]): string {
  if (!refusing.length) return 'Pick your UPI app.';
  const one = refusing.length === 1;
  const names = one ? refusing[0] : `${refusing.slice(0, -1).join(', ')} and ${refusing[refusing.length - 1]}`;
  return `Pick your UPI app. ${names} ${one ? 'opens' : 'open'} with the UPI ID copied, to paste in.`;
}
