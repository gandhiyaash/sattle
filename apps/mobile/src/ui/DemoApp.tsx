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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Debt, Expense, HistoryEntry, Member, PayWays } from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import type { AppData } from '../data/AppData';
import { useAppData, useNotices, useView } from '../data/useAppData';
import { SattleProvider, isMock, useClient } from '../react/SattleProvider';
import { AccountPageScreen, type AccountPage } from './AccountPages';
import { AccountScreen } from './AccountScreen';
import { ActivityScreen } from './ActivityScreen';
import { AddExpenseScreen } from './AddExpenseScreen';
import { useHistoryDepth } from './backNavigation';
import { FaqScreen } from './FaqScreen';
import { GetPaidSheet, useAskToGetPaid } from './GetPaidSheet';
import { GroupDetailScreen } from './GroupDetailScreen';
import { GroupGuestScreen } from './GroupGuestScreen';
import { GroupSettingsScreen } from './GroupSettingsScreen';
import { GroupsListScreen } from './GroupsListScreen';
import { GuestPayScreen } from './GuestPayScreen';
import { HistoryEntrySheet, HistoryScreen } from './HistoryScreen';
import { JoinScreen } from './JoinScreen';
import { NewGroupScreen } from './NewGroupScreen';
import { AboveBottomBar, Loading, Screen, Sheet, Toast, useToast } from './primitives';
import { RestoreScreen } from './RestoreScreen';
import { SettleUpSheet } from './SettleUpSheet';
import { OfflineBanner } from './OfflineBanner';
import { UpdateBanner } from './UpdateBanner';
import { TabBar, useTabBarSpace, type TabItem } from './TabBar';
import { makeStyles, radius, space, type } from './theme';

type Route =
  | { name: 'groups' }
  /** `example`: a name of the kind picked on Home, suggested in the name field. */
  | { name: 'newGroup'; example?: string }
  /**
   * `sharing`: just made, so it opens on Add people with the link ready to send.
   * `from`: opened from Activity, which is where back goes.
   */
  | { name: 'group'; groupId: string; sharing?: boolean; from?: 'activity' }
  | {
      name: 'addExpense';
      groupId: string;
      groupName: string;
      members: Member[];
      currency: string;
      userId: string;
      /** An added expense that didn't save, to start the form from. */
      draft?: { expense: Expense; changeId: string };
    }
  | {
      name: 'editExpense';
      groupId: string;
      groupName: string;
      members: Member[];
      currency: string;
      expense: Expense;
      userId: string;
    }
  | { name: 'groupSettings'; groupId: string }
  | { name: 'history'; groupId: string }
  | { name: 'activity' }
  | { name: 'faq'; ways: PayWays }
  /** Without `page`, the list of settings; with one, that setting's page. */
  | { name: 'account'; page?: AccountPage }
  | { name: 'join'; token?: string }
  | { name: 'shared'; token: string }
  | { name: 'restore'; groupId: string; backupKey: string }
  | { name: 'guest'; token: string };

export interface DemoAppProps {
  client?: SattleClient;
  /** The account's AppData, made with the client (buildAppData). */
  data?: AppData;
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
  data,
  joining,
  onJoinDone,
  shared,
  onSharedDone,
  onAccountDeleted,
  onKeyReplaced,
}: DemoAppProps) {
  return (
    <SattleProvider client={client} data={data}>
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
  // For a moment after the expense form saves or closes, taps go nowhere: the second tap of a double
  // tap on Save or × would land on whatever the group behind it has in that place.
  const [guarded, setGuarded] = useState(false);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guard = useCallback(() => {
    setGuarded(true);
    if (guardTimer.current) clearTimeout(guardTimer.current);
    guardTimer.current = setTimeout(() => setGuarded(false), 400);
  }, []);
  useEffect(() => () => {
    if (guardTimer.current) clearTimeout(guardTimer.current);
  }, []);
  const [settling, setSettling] = useState<{
    debt: Debt;
    members: Member[];
    groupName: string;
    currency: string;
  } | null>(null);
  // The entry of a group's history that is open in full, over the list it was tapped in.
  const [viewing, setViewing] = useState<{ entry: HistoryEntry; members: Member[]; currency: string } | null>(null);
  const appData = useAppData();
  // Once, over the groups list at launch, for someone with nowhere yet to be paid. See GetPaidSheet.
  const getPaid = useAskToGetPaid(route.name === 'groups');
  const barSpace = useTabBarSpace();
  const insets = useSafeAreaInsets();
  // On a phone the link can arrive after the first screen is up, or while the app is in use.
  useEffect(() => {
    if (joining) setRoute({ name: 'join', token: joining });
  }, [joining]);
  useEffect(() => {
    if (shared) setRoute({ name: 'shared', token: shared });
  }, [shared]);

  // After a change made elsewhere (joining, a payment, Manage): the server is asked again, and the
  // screens update where they are. Nothing is remounted or read again from scratch.
  const refresh = () => void appData.sync();

  // The settling and history sheets are counted by the sheets themselves, as every open sheet is.
  useHistoryDepth(depthOf(route));

  const openGroup = (groupId: string) => setRoute({ name: 'group', groupId });

  const body = (() => {
    switch (route.name) {
      case 'groups':
        return (
          <GroupsListScreen
            onOpenGroup={openGroup}
            onNewGroup={(example) => setRoute({ name: 'newGroup', example })}
            onJoin={() => setRoute({ name: 'join' })}
          />
        );

      case 'shared':
        return (
          <SharedGroup
            // A second link starts over.
            key={route.token}
            token={route.token}
            // Already in it: the group, where who pays whom is near the top.
            onIn={(groupId) => {
              onSharedDone?.();
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
            example={route.example}
            onBack={() => setRoute({ name: 'groups' })}
            onCreated={(groupId) => {
              refresh();
              setRoute({ name: 'group', groupId, sharing: true });
            }}
          />
        );

      case 'group':
        return (
          <GroupDetailScreen
            key={route.groupId}
            groupId={route.groupId}
            sharing={route.sharing}
            // Once, on arriving: coming back to the group later shouldn't open it again.
            onShared={() => route.sharing && setRoute({ name: 'group', groupId: route.groupId })}
            onBack={() => setRoute(route.from === 'activity' ? { name: 'activity' } : { name: 'groups' })}
            onAddExpense={(members, currency, userId, groupName, draft) =>
              setRoute({ name: 'addExpense', groupId: route.groupId, groupName, members, currency, userId, draft })
            }
            onEditExpense={(expense, members, currency, userId, groupName) =>
              setRoute({ name: 'editExpense', groupId: route.groupId, groupName, members, currency, expense, userId })
            }
            onManage={() => setRoute({ name: 'groupSettings', groupId: route.groupId })}
            onHistory={() => setRoute({ name: 'history', groupId: route.groupId })}
            onOpenWallet={() => setRoute({ name: 'account' })}
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
            groupName={route.groupName}
            members={route.members}
            currency={route.currency}
            expense={route.expense}
            userId={route.userId}
            onBack={() => {
              guard();
              setRoute({ name: 'group', groupId: route.groupId });
            }}
            // Already on the group: AppData shows the change at once and sends it behind.
            onAdded={() => {
              guard();
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
            onBack={() => setRoute({ name: 'group', groupId: route.groupId })}
            onOpen={(entry, members, currency) => setViewing({ entry, members, currency })}
          />
        );

      case 'addExpense':
        return (
          <AddExpenseScreen
            // A second draft opened starts the form afresh.
            key={route.draft?.changeId ?? 'new'}
            groupId={route.groupId}
            groupName={route.groupName}
            members={route.members}
            currency={route.currency}
            userId={route.userId}
            draft={route.draft}
            onBack={() => {
              guard();
              setRoute({ name: 'group', groupId: route.groupId });
            }}
            onAdded={() => {
              guard();
              openGroup(route.groupId);
            }}
          />
        );

      case 'activity':
        return <ActivityScreen onOpenGroup={(groupId) => setRoute({ name: 'group', groupId, from: 'activity' })} />;

      case 'faq':
        return <FaqScreen ways={route.ways} onBack={() => setRoute({ name: 'account' })} />;

      case 'account':
        return route.page ? (
          <AccountPageScreen
            key={route.page}
            page={route.page}
            onBack={() => setRoute({ name: 'account' })}
            onDeleted={() => onAccountDeleted?.()}
            onKeyReplaced={onKeyReplaced}
          />
        ) : (
          <AccountScreen
            onOpen={(page) => setRoute({ name: 'account', page })}
            onOpenFaq={(ways) => setRoute({ name: 'faq', ways })}
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

  // The bar is on the tabs themselves, not on what's opened from them. It floats over the screen,
  // so the screen is told how much of its bottom the bar covers, and keeps its last row clear.
  const tab = tabOf(route);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} pointerEvents={guarded ? 'none' : 'auto'}>
        <AboveBottomBar bottom={tab ? barSpace : undefined}>{body}</AboveBottomBar>
      </View>

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

      <Sheet visible={getPaid.asking} onClose={getPaid.done}>
        {getPaid.asking && <GetPaidSheet upiOnLinks={getPaid.upiOnLinks} onDone={getPaid.done} />}
      </Sheet>

      {/* Over the bar where there is one, so it never hides them; at the bottom, clear of the home indicator, where there isn't. */}
      {tab ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: barSpace }}>
          <OfflineBanner />
          <UpdateBanner />
        </View>
      ) : (
        <>
          <OfflineBanner inset={insets.bottom} />
          <UpdateBanner inset={insets.bottom} />
        </>
      )}
      <Notices />
      {tab && <TabBar tabs={TABS} current={tab} onSelect={(key) => setRoute(TAB_ROUTES[key])} />}
    </View>
  );
}

type TabKey = 'groups' | 'activity' | 'account' | 'guest';

/**
 * Groups, Activity and Account. In demo mode, also a Guest link tab, so a judge can jump
 * straight to the guest page without a second device. It opens the seeded
 * `demo` link and Flat 4B fixtures, which only the mock has.
 */
const TABS: ReadonlyArray<TabItem<TabKey>> = [
  { key: 'groups', label: 'Groups', icon: 'groups' },
  { key: 'activity', label: 'Activity', icon: 'activity' },
  { key: 'account', label: 'Account', icon: 'account' },
  ...(isMock() ? [{ key: 'guest', label: 'Guest link', icon: 'link' } as const] : []),
];

const TAB_ROUTES: Record<TabKey, Route> = {
  groups: { name: 'groups' },
  activity: { name: 'activity' },
  account: { name: 'account' },
  guest: { name: 'guest', token: 'demo' },
};

/** The tab this route is, if it's one of them: a tab's own screen, not anything opened from it. */
function tabOf(route: Route): TabKey | null {
  switch (route.name) {
    case 'groups':
    case 'activity':
      return route.name;
    case 'account':
      return route.page ? null : 'account';
    case 'guest':
      return isMock() ? 'guest' : null;
    default:
      return null;
  }
}

/**
 * A change of the user's that the server refused, said wherever they are,
 * with the group it was in: by the time the server answers, they may have
 * moved on from the screen they made it on. The expense shows as the server
 * has it.
 */
function Notices() {
  const appData = useAppData();
  const notices = useNotices();
  const view = useView();
  const [text, show] = useToast();
  useEffect(() => {
    const notice = notices[0];
    if (!notice) return;
    const name = view?.groups.find((g) => g.group.id === notice.groupId)?.group.name;
    show(`Couldn’t save that${name ? ` in ${name}` : ''}: ${notice.text}`);
    appData.dismiss(notice.id);
  }, [notices, view, appData, show]);
  return <Toast text={text} bottom={150} />;
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

/**
 * How many backs it takes to reach the groups list, for the browser's back button to walk.
 * The guest page has no way back in the app, so the browser's leaves from there.
 */
function depthOf(route: Route): number {
  switch (route.name) {
    case 'groups':
    case 'guest':
      return 0;
    case 'addExpense':
    case 'editExpense':
    case 'groupSettings':
    case 'history':
    case 'faq':
      return 2;
    case 'account':
      return route.page ? 2 : 1;
    case 'restore':
      return 3;
    default:
      return 1;
  }
}

/**
 * Demo only: jump the guest page into each state it can be in. Links are for
 * Priya's debt in Flat 4B, since the seeded demo link already covers Om's,
 * and come from the group's page as every pay link does, so Fresh link is
 * the same link until it's paid. Set EXPO_PUBLIC_MOCK_ALWAYS_FAIL=true to
 * see a fresh link fail.
 */
function GuestScenarios({ onOpen }: { onOpen: (token: string) => void }) {
  const sheet = useSheet();
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  /** The page's link for what Priya still owes, with the debt, or null once it's all paid. */
  const linkFor = async () => {
    const debt = (await client.getDebts('g-flat')).find(
      (d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash'
    );
    if (!debt) return null;
    const onPage = (await client.getGroupGuestView('demo-group')).debts.find((d) => d.from === 'Priya' && d.to === 'Yash')!;
    const { token } = await client.payFromGroupLink('demo-group', onPage.ref);
    return { token, debt };
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
    { label: 'Fresh link', make: async () => (await linkFor())?.token ?? null },
    {
      label: 'Already settled',
      make: async () => {
        const link = await linkFor();
        if (!link) return null;
        const { groupId, fromMemberId, toMemberId, amount } = link.debt;
        await client.markSettledManually({ groupId, fromMemberId, toMemberId, amount, note: 'cash' });
        return link.token;
      },
    },
    { label: 'Unknown link', make: async () => 'no-such-link' },
  ];

  return (
    <View style={sheet.scenarios}>
      {scenarios.map((sc) => (
        <Pressable key={sc.label} disabled={busy} onPress={run(sc.make)} style={sheet.chip} accessibilityRole="button">
          <Text style={sheet.chipText}>{sc.label}</Text>
        </Pressable>
      ))}
      {note && <Text style={sheet.note}>{note}</Text>}
    </View>
  );
}

const useSheet = makeStyles((color) => ({
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
