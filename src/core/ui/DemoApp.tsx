/**
 * Demo navigator.
 *
 * A deliberately dumb state machine rather than expo-router, so the whole
 * flow is clickable before any routing is configured. Drop <DemoApp /> into
 * App.tsx and the app runs on iOS, Android and web against the mock client.
 *
 * When expo-router lands, each case below becomes a route file and this
 * file gets deleted. Nothing inside the screens changes — they only ever
 * take props and callbacks.
 */

import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Debt, Member } from '../domain/types';
import { SattleProvider } from '../react/SattleProvider';
import { AddExpenseScreen } from './AddExpenseScreen';
import { GroupDetailScreen } from './GroupDetailScreen';
import { GroupsListScreen } from './GroupsListScreen';
import { GuestPayScreen } from './GuestPayScreen';
import { SettleUpSheet } from './SettleUpSheet';
import { WalletScreen } from './WalletScreen';
import { color, radius, space, type } from './theme';

type Route =
  | { name: 'groups' }
  | { name: 'group'; groupId: string }
  | { name: 'addExpense'; groupId: string; members: Member[]; currency: string }
  | { name: 'wallet' }
  | { name: 'guest'; settlementId: string };

export function DemoApp() {
  return (
    <SattleProvider>
      <Navigator />
    </SattleProvider>
  );
}

function Navigator() {
  const [route, setRoute] = useState<Route>({ name: 'groups' });
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
            onSettle={(debt, members, groupName) => setSettling({ debt, members, groupName })}
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

      case 'guest':
        return (
          <GuestPayScreen
            settlementId={route.settlementId}
            payerName="Om"
            payeeName="Yash"
            reason="Dinner at Thalassa, split 4 ways"
          />
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

      <DemoBar route={route} onNavigate={setRoute} />
    </View>
  );
}

/**
 * Only exists so a judge can jump straight to the guest page during a demo
 * without a second device. Delete before shipping.
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
    { label: 'Guest link', route: { name: 'guest', settlementId: 'demo' } },
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
});
