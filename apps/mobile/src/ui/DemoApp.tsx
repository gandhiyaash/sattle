/**
 * Demo navigator.
 *
 * A deliberately dumb state machine rather than expo-router, so the whole
 * flow is clickable before any routing is configured. App.tsx renders it
 * with the signed-in account's client, or bare against the mock in demo mode.
 *
 * When expo-router lands, each case below becomes a route file and this
 * file gets deleted. Nothing inside the screens changes — they only ever
 * take props and callbacks.
 */

import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Debt, Expense, Member } from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import { SattleProvider, isMock, useClient } from '../react/SattleProvider';
import { AccountScreen } from './AccountScreen';
import { AddExpenseScreen } from './AddExpenseScreen';
import { GroupDetailScreen } from './GroupDetailScreen';
import { GroupSettingsScreen } from './GroupSettingsScreen';
import { GroupsListScreen } from './GroupsListScreen';
import { GuestPayScreen } from './GuestPayScreen';
import { JoinScreen } from './JoinScreen';
import { NewGroupScreen } from './NewGroupScreen';
import { SettleUpSheet } from './SettleUpSheet';
import { UpdateBanner } from './UpdateBanner';
import { WalletScreen } from './WalletScreen';
import { color, radius, space, type } from './theme';

type Route =
  | { name: 'groups' }
  | { name: 'newGroup' }
  | { name: 'group'; groupId: string }
  | { name: 'addExpense'; groupId: string; members: Member[]; currency: string }
  | { name: 'editExpense'; groupId: string; members: Member[]; currency: string; expense: Expense; userId: string }
  | { name: 'groupSettings'; groupId: string }
  | { name: 'wallet' }
  | { name: 'account' }
  | { name: 'join'; token?: string }
  | { name: 'guest'; token: string };

export interface DemoAppProps {
  client?: SattleClient;
  /** The token from a /join/<token> link the app was opened with. It starts on the join screen. */
  invite?: string | null;
  /** The join screen is finished with that link, whether or not anyone joined. */
  onInviteDone?: () => void;
  /** The account was deleted on the server. Whoever holds its token should forget it. */
  onAccountDeleted?: () => void;
}

export function DemoApp({ client, invite, onInviteDone, onAccountDeleted }: DemoAppProps) {
  return (
    <SattleProvider client={client}>
      <Navigator invite={invite ?? null} onInviteDone={onInviteDone} onAccountDeleted={onAccountDeleted} />
    </SattleProvider>
  );
}

function Navigator({
  invite,
  onInviteDone,
  onAccountDeleted,
}: {
  invite: string | null;
  onInviteDone?: () => void;
  onAccountDeleted?: () => void;
}) {
  const [route, setRoute] = useState<Route>(invite ? { name: 'join', token: invite } : { name: 'groups' });
  const [settling, setSettling] = useState<{
    debt: Debt;
    members: Member[];
    groupName: string;
  } | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = () => setNonce((n) => n + 1);

  const body = (() => {
    switch (route.name) {
      case 'groups':
        return (
          <GroupsListScreen
            key={nonce}
            onOpenGroup={(groupId) => setRoute({ name: 'group', groupId })}
            onOpenWallet={() => setRoute({ name: 'wallet' })}
            onNewGroup={() => setRoute({ name: 'newGroup' })}
            onJoin={() => setRoute({ name: 'join' })}
          />
        );

      case 'join':
        return (
          <JoinScreen
            token={route.token}
            onBack={() => {
              onInviteDone?.();
              setRoute({ name: 'groups' });
            }}
            onJoined={(groupId) => {
              onInviteDone?.();
              refresh();
              setRoute({ name: 'group', groupId });
            }}
          />
        );

      case 'newGroup':
        return (
          <NewGroupScreen
            onBack={() => setRoute({ name: 'groups' })}
            onCreated={(groupId) => {
              refresh();
              setRoute({ name: 'group', groupId });
            }}
          />
        );

      case 'group':
        return (
          <GroupDetailScreen
            key={`${route.groupId}-${nonce}`}
            groupId={route.groupId}
            onBack={() => setRoute({ name: 'groups' })}
            onAddExpense={(members, currency) =>
              setRoute({ name: 'addExpense', groupId: route.groupId, members, currency })
            }
            onEditExpense={(expense, members, currency, userId) =>
              setRoute({ name: 'editExpense', groupId: route.groupId, members, currency, expense, userId })
            }
            onManage={() => setRoute({ name: 'groupSettings', groupId: route.groupId })}
            onSettle={(debt, members, groupName) => setSettling({ debt, members, groupName })}
          />
        );

      case 'editExpense':
        return (
          <AddExpenseScreen
            groupId={route.groupId}
            members={route.members}
            currency={route.currency}
            expense={route.expense}
            userId={route.userId}
            onBack={() => setRoute({ name: 'group', groupId: route.groupId })}
            onAdded={() => {
              refresh();
              setRoute({ name: 'group', groupId: route.groupId });
            }}
          />
        );

      case 'groupSettings':
        return (
          <GroupSettingsScreen
            groupId={route.groupId}
            onBack={() => {
              refresh();
              setRoute({ name: 'group', groupId: route.groupId });
            }}
            onGone={() => {
              refresh();
              setRoute({ name: 'groups' });
            }}
          />
        );

      case 'addExpense':
        return (
          <AddExpenseScreen
            groupId={route.groupId}
            members={route.members}
            currency={route.currency}
            onBack={() => setRoute({ name: 'group', groupId: route.groupId })}
            onAdded={() => {
              refresh();
              setRoute({ name: 'group', groupId: route.groupId });
            }}
          />
        );

      case 'wallet':
        return <WalletScreen onBack={() => setRoute({ name: 'groups' })} />;

      case 'account':
        return <AccountScreen onBack={() => setRoute({ name: 'groups' })} onDeleted={() => onAccountDeleted?.()} />;

      case 'guest':
        return (
          <View style={{ flex: 1 }}>
            <GuestPayScreen key={route.token} token={route.token} />
            <GuestScenarios onOpen={(token) => setRoute({ name: 'guest', token })} />
          </View>
        );
    }
  })();

  return (
    <View style={{ flex: 1 }}>
      {body}

      <Modal
        visible={settling !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setSettling(null)}
      >
        <Pressable style={sheet.backdrop} onPress={() => setSettling(null)} />
        <View style={sheet.container}>
          {settling && (
            <SettleUpSheet
              debt={settling.debt}
              members={settling.members}
              groupName={settling.groupName}
              onClose={() => {
                setSettling(null);
                refresh();
              }}
            />
          )}
        </View>
      </Modal>

      <UpdateBanner />
      <DemoBar route={route} onNavigate={setRoute} />
    </View>
  );
}

/**
 * Groups, Wallet and Account. In demo mode, also a Guest link tab, so a judge can jump
 * straight to the guest page without a second device. It opens the seeded
 * `demo` link and Flat 4B fixtures, which only the mock has.
 */
function DemoBar({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate: (r: Route) => void;
}) {
  const tabs: Array<{ label: string; route: Route }> = [
    { label: 'Groups', route: { name: 'groups' } },
    { label: 'Wallet', route: { name: 'wallet' } },
    { label: 'Account', route: { name: 'account' } },
    ...(isMock() ? [{ label: 'Guest link', route: { name: 'guest', token: 'demo' } } as const] : []),
  ];

  return (
    <View style={sheet.bar}>
      {tabs.map((tab) => (
        <Pressable
          key={tab.label}
          onPress={() => onNavigate(tab.route)}
          style={sheet.tab}
        >
          <Text
            style={[
              sheet.tabText,
              route.name === tab.route.name && sheet.tabTextActive,
            ]}
          >
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Demo only: jump the guest page into each state it can be in. Links are for
 * Priya's debt in Flat 4B, since the seeded demo link already covers Om's.
 * A fresh link takes a ₹100 slice, so several runs fit before the debt is
 * used up. Set EXPO_PUBLIC_MOCK_ALWAYS_FAIL=true to see a fresh link fail.
 */
function GuestScenarios({ onOpen }: { onOpen: (token: string) => void }) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /** A link for up to `slice` of what Priya still owes, or null once it's all paid. */
  const linkFor = async (slice: number) => {
    const debt = (await client.getDebts('g-flat')).find(
      (d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash'
    );
    if (!debt) return null;
    const { groupId, fromMemberId, toMemberId } = debt;
    return client.createPayLink({ groupId, fromMemberId, toMemberId, amount: Math.min(slice, debt.amount) });
  };

  const run = (make: () => Promise<string | null>) => async () => {
    setBusy(true);
    setNote(null);
    try {
      const token = await make();
      if (token) onOpen(token);
      else setNote('Priya’s debt is all paid. Reload to reset the demo.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scenarios: Array<{ label: string; make: () => Promise<string | null> }> = [
    { label: 'Demo link', make: async () => 'demo' },
    { label: 'Fresh link', make: async () => (await linkFor(10_000))?.token ?? null },
    {
      label: 'Already settled',
      make: async () => {
        const link = await linkFor(Infinity);
        if (!link) return null;
        const { groupId, fromMemberId, toMemberId, amount } = link;
        await client.markSettledManually({ groupId, fromMemberId, toMemberId, amount, note: 'cash' });
        return link.token;
      },
    },
    { label: 'Unknown link', make: async () => 'no-such-link' },
  ];

  return (
    <View style={sheet.scenarios}>
      {scenarios.map((sc) => (
        <Pressable key={sc.label} disabled={busy} onPress={run(sc.make)} style={sheet.chip}>
          <Text style={sheet.chipText}>{sc.label}</Text>
        </Pressable>
      ))}
      {note && <Text style={sheet.note}>{note}</Text>}
    </View>
  );
}

const sheet = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#1A171466' },
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.surface,
    paddingBottom: space.lg,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: space.md },
  tabText: { ...type.label, color: color.inkFaint },
  tabTextActive: { color: color.accent },
  scenarios: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.sm,
    padding: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.surfaceSunken,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
  },
  chipText: { ...type.caption, color: color.inkMuted },
  note: { ...type.caption, color: color.inkMuted, width: '100%', textAlign: 'center' },
});
