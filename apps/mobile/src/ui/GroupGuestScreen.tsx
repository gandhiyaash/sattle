/**
 * The group page: what someone sees when they open /g/<token>.
 *
 * The pay page shows one debt. This shows the group: every spend with each
 * person's share, and who owes whom, so anyone in the chat the link went to
 * can check the numbers and pay what they owe. No app, no account.
 *
 * It only reads. Paying with Lightning hands one debt to the pay page
 * (GuestPayScreen), which is where the invoice is made and the wallet opens.
 * Paying by UPI, offered when the person owed allows it from shared links,
 * opens the UPI app or shows a QR here; then the page says it was paid, and
 * the person owed confirms it in the app. Nothing here can change the group,
 * and the page can't tell who is looking, so every debt gets the same
 * buttons: paying someone else's is allowed and harmless.
 *
 * It is also the way in. Join opens /join/<token>, with the same token,
 * where someone says which of the people in the group they are and asks to
 * join; someone already in it lets them in (JoinScreen). For someone who has
 * joined, that opens the group.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  SattleError,
  formatFiat,
  joinPath,
  upiPayUri,
  type GroupGuestDebt,
  type GroupGuestExpense,
  type UpiPayee,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { GuestPayScreen } from './GuestPayScreen';
import { UpiPanel } from './UpiPanel';
import { Amount, Avatar, Button, Card, Divider, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type, useColors } from './theme';

export interface GroupGuestScreenProps {
  /** From /g/<token>. The only thing the page knows on arrival. */
  token: string;
}

const REFRESH_MS = 4000;

export function GroupGuestScreen({ token }: GroupGuestScreenProps) {
  const s = useStyles();
  const client = useClient();
  const { data, loading, error, reload, refresh } = useAsync(() => client.getGroupGuestView(token), [token]);
  /** The pay link for the debt being paid. While set, the pay page is up. */
  const [paying, setPaying] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // A ref as well as the state: two taps can land before the state has updated.
  const settling = useRef(false);
  const [failed, setFailed] = useState<{ ref: string; message: string } | null>(null);
  /** The debt being paid by UPI, and who to pay, once the page has asked. */
  const [upi, setUpi] = useState<{ ref: string; payee: UpiPayee | null } | null>(null);
  const keys = useActionKeys();
  const [saying, setSaying] = useState(false);

  // Someone else in the chat may pay while this is open. Keep the list current.
  useEffect(() => {
    if (paying) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh, paying]);

  // One debt at a time: a second Settle while the first is starting would swap the pay page under the reader.
  const settle = async (ref: string) => {
    if (settling.current) return;
    settling.current = true;
    setStarting(ref);
    setFailed(null);
    try {
      setPaying((await client.payFromGroupLink(token, ref)).token);
    } catch (e) {
      setFailed({ ref, message: e instanceof Error ? e.message : 'Couldn’t start that. Try again.' });
      // Most likely it was just paid by someone else: show what's owed now.
      refresh();
    } finally {
      settling.current = false;
      setStarting(null);
    }
  };

  const openUpi = async (ref: string) => {
    if (upi?.ref === ref) return setUpi(null);
    setFailed(null);
    setUpi({ ref, payee: null });
    try {
      const payee = await client.getGroupLinkUpi(token, ref);
      setUpi((now) => (now?.ref === ref ? { ref, payee } : now));
    } catch (e) {
      setUpi(null);
      setFailed({ ref, message: e instanceof Error ? e.message : 'Couldn’t get the UPI details. Try again.' });
      refresh();
    }
  };

  // Moves nothing: the person owed is asked whether it arrived.
  const sayPaid = async (ref: string) => {
    setSaying(true);
    setFailed(null);
    try {
      await keys.run('upi-claim', { token, ref }, (k) => client.claimUpiFromGroupLink(token, ref, k));
      setUpi(null);
    } catch (e) {
      setFailed({ ref, message: e instanceof Error ? e.message : 'Couldn’t send that. Try again.' });
    } finally {
      setSaying(false);
      refresh();
    }
  };

  if (paying) {
    return (
      <View style={s.payPage}>
        <GuestPayScreen token={paying} fromGroup />
        <View style={s.backBar}>
          <Button
            label={`Back to ${data?.groupName ?? 'the group'}`}
            onPress={() => {
              setPaying(null);
              refresh();
            }}
          />
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <Screen title="Sattle">
        <Loading lines={3} />
      </Screen>
    );
  }

  if (error || !data) {
    // A link that was replaced or turned off stays dead; only a network failure is worth retrying.
    const retry = error instanceof SattleError && error.code === 'network' ? reload : undefined;
    return (
      <Screen title="Sattle">
        <ErrorState message={error?.message ?? 'Couldn’t load this group.'} onRetry={retry} />
      </Screen>
    );
  }

  const spends = [...data.expenses].reverse();

  return (
    <Screen title={data.groupName} subtitle={`${spends.length} ${spends.length === 1 ? 'spend' : 'spends'} · shared by link`}>
      <View>
        <SectionLabel>Who owes what</SectionLabel>
        {data.debts.length === 0 ? (
          <Card>
            <Text style={s.body}>All settled. Nobody owes anything.</Text>
          </Card>
        ) : (
          <View style={{ gap: space.sm }}>
            {data.debts.map((debt) => (
              <DebtCard
                key={debt.ref}
                debt={debt}
                currency={data.currency}
                groupName={data.groupName}
                busy={starting === debt.ref}
                disabled={starting !== null && starting !== debt.ref}
                error={failed?.ref === debt.ref ? failed.message : null}
                onSettle={() => settle(debt.ref)}
                upi={upi?.ref === debt.ref ? { payee: upi.payee, saying } : null}
                onUpi={() => openUpi(debt.ref)}
                onPaidByUpi={() => sayPaid(debt.ref)}
              />
            ))}
          </View>
        )}
      </View>

      <Card style={s.joinCard}>
        <Text style={s.joinTitle}>In this group?</Text>
        <Text style={s.body}>
          Join it to add what you’ve spent and settle up in the app. You pick your name, and someone in the group
          lets you in. Already joined? This opens the group.
        </Text>
        {/* A real link, not a change of screen: Back returns here, and a phone with the app installed
            can hand /join/ links to it. This page is only ever shown in a browser. */}
        <Button label={`Join ${data.groupName}`} variant="primary" href={joinPath(token)} />
      </Card>

      <View>
        <SectionLabel>Spends</SectionLabel>
        {spends.length === 0 ? (
          <Text style={s.note}>Nothing has been added yet.</Text>
        ) : (
          <Card style={{ padding: 0 }}>
            {spends.map((expense, i) => (
              <View key={`${expense.createdAt}-${i}`}>
                {i > 0 && <Divider />}
                <Spend expense={expense} currency={data.currency} />
              </View>
            ))}
          </Card>
        )}
      </View>

      <Text style={s.note}>
        You’re seeing this group through its shared link. You can pay what you owe from here, but only the people in
        the group can change it.
      </Text>
    </Screen>
  );
}

function DebtCard({
  debt,
  currency,
  groupName,
  busy,
  disabled,
  error,
  onSettle,
  upi,
  onUpi,
  onPaidByUpi,
}: {
  debt: GroupGuestDebt;
  currency: string;
  groupName: string;
  busy: boolean;
  /** Another debt's payment is starting. */
  disabled: boolean;
  error: string | null;
  onSettle: () => void;
  /** Open when this debt is being paid by UPI; `payee` is null while the page asks who to pay. */
  upi: { payee: UpiPayee | null; saying: boolean } | null;
  onUpi: () => void;
  onPaidByUpi: () => void;
}) {
  const color = useColors();
  const s = useStyles();
  // Someone said it was paid by UPI. Paying again would pay twice, so the buttons wait with it.
  const claimed = debt.upiClaim === 'pending';
  const canPay = (debt.payable || debt.upi) && !claimed;
  return (
    <Card style={{ padding: space.md, gap: space.sm }}>
      <View style={s.debtRow}>
        <Avatar name={debt.from} />
        <View style={{ flex: 1 }}>
          <Text style={s.debtText}>
            {debt.from} owes {debt.to}
          </Text>
          <Amount minor={debt.amount} currency={currency} size="sm" />
        </View>
      </View>
      {claimed && (
        <Text style={s.indented}>
          Someone said this was paid by UPI. Waiting for {debt.to} to confirm it arrived.
        </Text>
      )}
      {debt.upiClaim === 'declined' && (
        <Text style={[s.indented, { color: color.danger }]}>
          {debt.to} says the UPI payment didn’t arrive. Check with them before paying again.
        </Text>
      )}
      {canPay && (
        <View style={[s.payButtons, s.indentedBlock]}>
          {debt.upi && (
            <Button label="Pay by UPI" variant={upi ? 'secondary' : 'primary'} disabled={disabled} onPress={onUpi} />
          )}
          {debt.payable && (
            <Button
              label="Pay with Lightning"
              variant={debt.upi ? 'secondary' : 'primary'}
              busy={busy}
              disabled={disabled}
              onPress={onSettle}
            />
          )}
        </View>
      )}
      {upi && !claimed && (
        <View style={[s.indentedBlock, { gap: space.sm }]}>
          {upi.payee ? (
            <>
              <UpiPanel
                payee={upi.payee}
                uri={upiPayUri({ upiId: upi.payee.upiId, name: upi.payee.name, amount: debt.amount, note: groupName })}
              />
              <Text style={s.caption}>
                Pay {formatFiat(debt.amount, currency)}, then tap below. {debt.to} confirms it arrived, and then it’s
                settled.
              </Text>
              <Button label="I’ve paid" variant="primary" busy={upi.saying} onPress={onPaidByUpi} />
            </>
          ) : (
            <Loading lines={2} />
          )}
        </View>
      )}
      {!debt.payable && !debt.upi && (
        <Text style={s.indented}>
          {debt.to} can’t be paid here yet. Settle with them directly.
        </Text>
      )}
      {error && <Text style={[s.indented, { color: color.danger }]}>{error}</Text>}
    </Card>
  );
}

function Spend({ expense, currency }: { expense: GroupGuestExpense; currency: string }) {
  const s = useStyles();
  return (
    <View style={s.spend}>
      <View style={s.spendTop}>
        <View style={{ flex: 1 }}>
          <Text style={s.spendName}>{expense.description}</Text>
          <Text style={s.spendMeta}>{expense.paidBy} paid</Text>
        </View>
        <Amount minor={expense.amount} currency={currency} size="md" />
      </View>
      <Text style={s.shares}>
        {expense.shares.map((share) => `${share.name} ${formatFiat(share.amount, currency)}`).join('  ·  ')}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  payPage: { flex: 1, backgroundColor: color.paper },
  backBar: { padding: space.lg, paddingBottom: space.xl },
  body: { ...type.body, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  debtRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  debtText: { ...type.body, color: color.ink },
  // Lines up under the names: avatar, gap.
  indented: { ...type.caption, color: color.inkMuted, marginLeft: 36 + space.md },
  indentedBlock: { marginLeft: 36 + space.md },
  payButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  caption: { ...type.caption, color: color.inkMuted },
  // The other thing the page is for, after paying: set apart, so it isn't read as one more debt.
  joinCard: { gap: space.sm, backgroundColor: color.accentWash, borderColor: color.accent },
  joinTitle: { ...type.body, fontWeight: '600', color: color.ink },
  spend: { padding: space.lg, gap: space.sm },
  spendTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  spendName: { ...type.body, fontWeight: '500', color: color.ink },
  spendMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  shares: { ...type.amountSm, color: color.inkMuted, lineHeight: 20 },
}));
