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

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Debt, Expense, HistoryEntry, Member, PayWays } from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import { SattleProvider, isMock, useClient } from '../react/SattleProvider';
import { AccountScreen } from './AccountScreen';
import { AddExpenseScreen } from './AddExpenseScreen';
import { FaqScreen } from './FaqScreen';
import { GroupDetailScreen, type GroupTab } from './GroupDetailScreen';
import { GroupGuestScreen } from './GroupGuestScreen';
import { GroupSettingsScreen } from './GroupSettingsScreen';
import { GroupsListScreen } from './GroupsListScreen';
import { GuestPayScreen } from './GuestPayScreen';
import { HistoryEntrySheet, HistoryScreen } from './HistoryScreen';
import { JoinScreen } from './JoinScreen';
import { NewGroupScreen } from './NewGroupScreen';
import { AboveBottomBar, Loading, Screen } from './primitives';
import { RestoreScreen } from './RestoreScreen';
import { SettleUpSheet } from './SettleUpSheet';
import { UpdateBanner } from './UpdateBanner';
import { WalletScreen } from './WalletScreen';
import { layout, makeStyles, radius, space, type } from './theme';

type Route =
  | { name: 'groups' }
  | { name: 'newGroup' }
  | { name: 'group'; groupId: string }
  | { name: 'addExpense'; groupId: string; members: Member[]; currency: string; userId: string; lastCurrency?: string }
  | { name: 'editExpense'; groupId: string; members: Member[]; currency: string; expense: Expense; userId: string }
  | { name: 'groupSettings'; groupId: string }
  | { name: 'history'; groupId: string }
  | { name: 'wallet' }
  | { name: 'faq'; ways: PayWays }
  | { name: 'account' }
  | { name: 'join'; token?: string }
  | { name: 'shared'; token: string }
  | { name: 'restore'; groupId: string; backupKey: string }
  | { name: 'guest'; token: string };

export interface DemoAppProps {
  client?: SattleClient;
  /** The token from a /join/<token> link. Opened with one, the app starts on the join screen; tapped later, it goes there. */
  joining?: string | null;
  /** The join screen is finished with that link, whether or not anyone asked to join. */
  onJoinDone?: () => void;
  /**
   * The token from the group's shared link, /g/<token>, tapped on a phone with the app. Someone in
   * the group gets the group, on what there is to settle. Anyone else gets the group's page.
   */
  shared?: string | null;
  /** The app is finished with that link: it has opened the group, gone on to joining, or been left. */
  onSharedDone?: () => void;
  /** The account was deleted on the server. Whoever holds its token should forget it. */
  onAccountDeleted?: () => void;
  /** The account has a new sign-in key, already saved. The client passed in should be swapped for one with it. */
  onKeyReplaced?: (token: string) => void;
}

export function DemoApp({
  client,
  joining,
  onJoinDone,
  shared,
  onSharedDone,
  onAccountDeleted,
  onKeyReplaced,
}: DemoAppProps) {
  return (
    <SattleProvider client={client}>
      <Navigator
        joining={joining ?? null}
        onJoinDone={onJoinDone}
        shared={shared ?? null}
        onSharedDone={onSharedDone}
        onAccountDeleted={onAccountDeleted}
        onKeyReplaced={onKeyReplaced}
      />
    </SattleProvider>
  );
}

function Navigator({
  joining,
  onJoinDone,
  shared,
  onSharedDone,
  onAccountDeleted,
  onKeyReplaced,
}: {
  joining: string | null;
  onJoinDone?: () => void;
  shared: string | null;
  onSharedDone?: () => void;
  onAccountDeleted?: () => void;
  onKeyReplaced?: (token: string) => void;
}) {
  const [route, setRoute] = useState<Route>(
    joining ? { name: 'join', token: joining } : shared ? { name: 'shared', token: shared } : { name: 'groups' }
  );
  const [settling, setSettling] = useState<{
    debt: Debt;
    members: Member[];
    groupName: string;
    currency: string;
  } | null>(null);
  // The entry of a group's history that is open in full, over the list it was tapped in.
  const [viewing, setViewing] = useState<{ entry: HistoryEntry; members: Member[]; currency: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Held here, not in the group screen, which is built again after every payment and every change.
  const [groupTab, setGroupTab] = useState<GroupTab>('expenses');
  // On a phone the link can arrive after the first screen is up, or while the app is in use.
  useEffect(() => {
    if (joining) setRoute({ name: 'join', token: joining });
  }, [joining]);
  useEffect(() => {
    if (shared) setRoute({ name: 'shared', token: shared });
  }, [shared]);

  const refresh = () => setNonce((n) => n + 1);

  /** Into a group from outside it, which starts on its expenses. Coming back from one of its own screens keeps the tab. */
  const openGroup = (groupId: string) => {
    setGroupTab('expenses');
    setRoute({ name: 'group', groupId });
  };

  const body = (() => {
    switch (route.name) {
      case 'groups':
        return (
          <GroupsListScreen
            key={nonce}
            onOpenGroup={openGroup}
            onNewGroup={() => setRoute({ name: 'newGroup' })}
            onJoin={() => setRoute({ name: 'join' })}
          />
        );

      case 'shared':
        return (
          <SharedGroup
            // A second link starts over.
            key={route.token}
            token={route.token}
            // Already in it. The link is the one for seeing what's owed and paying it, so that is the tab.
            onIn={(groupId) => {
              onSharedDone?.();
              setGroupTab('settle');
              setRoute({ name: 'group', groupId });
            }}
            onJoin={() => {
              onSharedDone?.();
              setRoute({ name: 'join', token: route.token });
            }}
            onBack={() => {
              onSharedDone?.();
              setRoute({ name: 'groups' });
            }}
          />
        );

      case 'join':
        return (
          <JoinScreen
            // A second link starts over, not on top of the first one's answers.
            key={route.token}
            token={route.token}
            onBack={() => {
              onJoinDone?.();
              setRoute({ name: 'groups' });
            }}
            onAsked={() => {
              onJoinDone?.();
              refresh();
              setRoute({ name: 'groups' });
            }}
            onJoined={(groupId) => {
              onJoinDone?.();
              refresh();
              openGroup(groupId);
            }}
            onAlreadyIn={(groupId) => {
              onJoinDone?.();
              openGroup(groupId);
            }}
          />
        );

      case 'newGroup':
        return (
          <NewGroupScreen
            onBack={() => setRoute({ name: 'groups' })}
            onCreated={(groupId) => {
              refresh();
              openGroup(groupId);
            }}
          />
        );

      case 'group':
        return (
          <GroupDetailScreen
            key={`${route.groupId}-${nonce}`}
            groupId={route.groupId}
            tab={groupTab}
            onTab={setGroupTab}
            onBack={() => setRoute({ name: 'groups' })}
            onAddExpense={(members, currency, userId, lastCurrency) =>
              setRoute({ name: 'addExpense', groupId: route.groupId, members, currency, userId, lastCurrency })
            }
            onEditExpense={(expense, members, currency, userId) =>
              setRoute({ name: 'editExpense', groupId: route.groupId, members, currency, expense, userId })
            }
            onManage={() => setRoute({ name: 'groupSettings', groupId: route.groupId })}
            onHistory={() => setRoute({ name: 'history', groupId: route.groupId })}
            onOpenWallet={() => setRoute({ name: 'wallet' })}
            onSettle={(debt, members, groupName, currency) => setSettling({ debt, members, groupName, currency })}
          />
        );

      case 'restore':
        return (
          <RestoreScreen
            initialKey={route.backupKey}
            onBack={() => setRoute({ name: 'groupSettings', groupId: route.groupId })}
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
            // The mock's key is made up, so there's nothing on the relays to read.
            onReadBack={
              isMock() ? undefined : (backupKey) => setRoute({ name: 'restore', groupId: route.groupId, backupKey })
            }
          />
        );

      case 'history':
        return (
          <HistoryScreen
            groupId={route.groupId}
            // Back to Settle up, which is where it was opened from: the tab is still held above.
            onBack={() => setRoute({ name: 'group', groupId: route.groupId })}
            onOpen={(entry, members, currency) => setViewing({ entry, members, currency })}
          />
        );

      case 'addExpense':
        return (
          <AddExpenseScreen
            groupId={route.groupId}
            members={route.members}
            currency={route.currency}
            userId={route.userId}
            lastCurrency={route.lastCurrency}
            onBack={() => setRoute({ name: 'group', groupId: route.groupId })}
            onAdded={() => {
              refresh();
              // Whichever tab Add expense was tapped from, the new one is what they came back to see.
              openGroup(route.groupId);
            }}
          />
        );

      case 'wallet':
        return (
          <WalletScreen
            onBack={() => setRoute({ name: 'groups' })}
            onOpenFaq={(ways) => setRoute({ name: 'faq', ways })}
          />
        );

      case 'faq':
        return <FaqScreen ways={route.ways} onBack={() => setRoute({ name: 'wallet' })} />;

      case 'account':
        return (
          <AccountScreen
            onBack={() => setRoute({ name: 'groups' })}
            onDeleted={() => onAccountDeleted?.()}
            onKeyReplaced={onKeyReplaced}
          />
        );

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
      <AboveBottomBar>{body}</AboveBottomBar>

      <Sheet visible={settling !== null} onClose={() => setSettling(null)}>
        {settling && (
          <SettleUpSheet
            debt={settling.debt}
            members={settling.members}
            groupName={settling.groupName}
            currency={settling.currency}
            onClose={() => {
              setSettling(null);
              refresh();
            }}
          />
        )}
      </Sheet>

      <Sheet visible={viewing !== null} onClose={() => setViewing(null)}>
        {viewing && (
          <HistoryEntrySheet
            entry={viewing.entry}
            members={viewing.members}
            currency={viewing.currency}
            onClose={() => setViewing(null)}
          />
        )}
      </Sheet>

      <UpdateBanner />
      <DemoBar
        route={route}
        onNavigate={(next) => {
          // A tab is a way off the join screen too. Left set, the link would do nothing when tapped again.
          if (route.name === 'join') onJoinDone?.();
          if (route.name === 'shared') onSharedDone?.();
          setRoute(next);
        }}
      />
    </View>
  );
}

/**
 * The group's shared link, opened in the app by someone who has an account.
 *
 * If they're in the group, the link is just a way to the group: `onIn`. If
 * they aren't, they get the page the link is for, the same one a browser
 * shows: what's been split, who owes whom, a way to pay, and Join, which here
 * goes on to the app's own join screen. Holding the link is all that page
 * ever asks for, so having the app installed doesn't take it away.
 */
function SharedGroup({
  token,
  onIn,
  onJoin,
  onBack,
}: {
  token: string;
  onIn: (groupId: string) => void;
  onJoin: () => void;
  onBack: () => void;
}) {
  const client = useClient();
  const [outside, setOutside] = useState(false);

  // Not being able to tell is no reason to keep the page from them, so a failure reads as not being in it.
  useEffect(() => {
    let live = true;
    client.getJoinedGroup(token).then(
      (group) => {
        if (!live) return;
        if (group) onIn(group.id);
        else setOutside(true);
      },
      () => live && setOutside(true)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, token]);

  if (!outside) {
    return (
      <Screen title="Sattle" onBack={onBack}>
        <Loading lines={3} />
      </Screen>
    );
  }
  return <GroupGuestScreen token={token} onBack={onBack} onJoin={onJoin} />;
}

/** Slides up over whatever screen is showing. Tapping outside it closes it, and so does the back button. */
function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: React.ReactNode }) {
  const sheet = useSheet();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sheet.backdrop} onPress={onClose} />
      {/* A Modal covers the whole window, past the app's column; the sheet stays as wide as the column, centred under it. */}
      <View style={sheet.frame} pointerEvents="box-none">
        {/* The sheet runs to the bottom edge; what's in it stops above the home indicator. */}
        <View style={[sheet.container, { paddingBottom: insets.bottom }]}>{children}</View>
      </View>
    </Modal>
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
  const sheet = useSheet();
  const insets = useSafeAreaInsets();
  const tabs: Array<{ label: string; route: Route }> = [
    { label: 'Groups', route: { name: 'groups' } },
    { label: 'Wallet', route: { name: 'wallet' } },
    { label: 'Account', route: { name: 'account' } },
    ...(isMock() ? [{ label: 'Guest link', route: { name: 'guest', token: 'demo' } } as const] : []),
  ];

  return (
    // The labels stay above the home indicator; the bar's colour runs under it to the edge.
    <View style={[sheet.bar, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
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
  const sheet = useSheet();
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

const useSheet = makeStyles((color) => ({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: color.scrim },
  // A flow child, not absolutely placed: native layout ignores auto margins on an absolute box.
  frame: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  container: {
    width: '100%',
    maxWidth: layout.maxWidth,
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.surface,
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
}));
