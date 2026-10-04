/**
 * The group page: what someone sees when they open /g/<token>.
 *
 * The pay page shows one debt. This shows the group: every spend with each
 * person's share, and who owes whom, so anyone in the chat the link went to
 * can check the numbers and pay what they owe. No app, no account.
 *
 * It only reads. Settle hands one debt to the pay page (GuestPayScreen),
 * which is where the invoice is made and the wallet opens. Nothing here can
 * change the group, and the page can't tell who is looking, so every debt
 * gets the same button: paying someone else's is allowed and harmless.
 */

import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SattleError, formatFiat, type GroupGuestDebt, type GroupGuestExpense } from '@sattle/core';
import { useAsync, useClient } from '../react/SattleProvider';
import { GuestPayScreen } from './GuestPayScreen';
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
  const { data, loading, error, reload, refresh } = useAsync((client) => client.getGroupGuestView(token), [token]);
  /** The pay link for the debt being paid. While set, the pay page is up. */
  const [paying, setPaying] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // A ref as well as the state: two taps can land before the state has updated.
  const settling = useRef(false);
  const [failed, setFailed] = useState<{ ref: string; message: string } | null>(null);

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
                busy={starting === debt.ref}
                disabled={starting !== null && starting !== debt.ref}
                error={failed?.ref === debt.ref ? failed.message : null}
                onSettle={() => settle(debt.ref)}
              />
            ))}
          </View>
        )}
      </View>

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
        You’re seeing this group through a shared link. You can pay what you owe from any Lightning wallet, but only
        the people in the group can change it.
      </Text>
    </Screen>
  );
}

function DebtCard({
  debt,
  currency,
  busy,
  disabled,
  error,
  onSettle,
}: {
  debt: GroupGuestDebt;
  currency: string;
  busy: boolean;
  /** Another debt's Settle is starting. */
  disabled: boolean;
  error: string | null;
  onSettle: () => void;
}) {
  const color = useColors();
  const s = useStyles();
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
        {debt.payable && <Button label="Settle" variant="primary" busy={busy} disabled={disabled} onPress={onSettle} />}
      </View>
      {!debt.payable && (
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
  spend: { padding: space.lg, gap: space.sm },
  spendTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  spendName: { ...type.body, fontWeight: '500', color: color.ink },
  spendMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  shares: { ...type.amountSm, color: color.inkMuted, lineHeight: 20 },
}));
