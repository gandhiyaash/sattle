# UI/UX review: context and findings

A working brief for anyone (person or agent) reviewing or improving how Sattle looks and feels. The first half is context: who the app is for, what it's trying to look like, where every screen lives and how to see it. The second half is what a first pass found, ranked, with the file to change.

Reviewed on 2026-10-27 against `om/usage-analytics` (`5d55806`), web build in mock mode at 375×812, dark mode, plus a read of `apps/mobile/src/ui`.

---

## 1. Product context

**What it does.** Split expenses in a group, then settle up over Bitcoin Lightning or UPI. Only one person needs the app; everyone else can pay from a link in a plain browser.

**Who sees it.** Review each surface from the person who actually lands on it:

| Person | Has the app? | Lands on | What they need in under 10 seconds |
|---|---|---|---|
| Organiser (Yash) | Yes | Groups list → Group detail | Who owes whom, add an expense, chase people |
| Member who joined (Om) | Yes | Group detail → Settle up | What they owe, one tap to pay |
| Ghost (Aman) | No | `/g/<token>` group page or `/s/<token>` pay link | Trust the page, see the amount, pay with the app they already use |
| Joiner | No, or new install | `/join/<token>` | Which group this is, which name is theirs |

**The register it's aiming for** (from [theme.ts](../apps/mobile/src/ui/theme.ts)): money software, not a crypto app. Warm paper, ink, one amber accent used only where the user is meant to act, amounts in monospace. No gradients, no neon. Judge every change against that: the goal is "looks like something a person already trusts".

**Domain rules the UI must not bend** (README, *Four decisions baked in*): members aren't users; balances only move on proof; fees go on top; "Mark as settled" is always available somewhere. A UX fix that hides one of these is the wrong fix.

## 2. Surface inventory

Navigation is a hand-rolled state machine in [DemoApp.tsx](../apps/mobile/src/ui/DemoApp.tsx) with a bottom bar (Groups, Wallet, Account, and Guest link in mock mode). URL routes only exist for the guest pages, handled in [App.tsx](../apps/mobile/App.tsx).

| Surface | File | Reached from |
|---|---|---|
| Tour (3 screens, once) | `OnboardingScreen.tsx` | First launch |
| Welcome / sign-in key | `WelcomeScreen.tsx` | First launch, real API only |
| Groups list | `GroupsListScreen.tsx` | Tab |
| New group | `NewGroupScreen.tsx` | Groups list |
| Group detail (Expenses / Members / Settle up) | `GroupDetailScreen.tsx` | Groups list |
| Add / edit expense | `AddExpenseScreen.tsx` | Group detail footer |
| Settle-up sheet (rails, ghost remedies, invoice, UPI, waiting, done) | `SettleUpSheet.tsx`, `InvoicePanel.tsx`, `UpiPanel.tsx` | Settle up tab |
| History | `HistoryScreen.tsx` | Group detail footer, Settle up tab only |
| Manage group | `GroupSettingsScreen.tsx` | Group header |
| Wallet (+ appearance, trust disclosure) | `WalletScreen.tsx` | Tab |
| FAQ | `FaqScreen.tsx` | Wallet header |
| Account (+ currencies, delete) | `AccountScreen.tsx`, `CurrencyPicker.tsx` | Tab |
| Guest pay page `/s/` | `GuestPayScreen.tsx` | Shared link |
| Guest group page `/g/` | `GroupGuestScreen.tsx` | Shared link |
| Join `/join/` | `JoinScreen.tsx` | Shared link |
| Restore `/restore` | `RestoreScreen.tsx` | Manage → backup |
| Update banner | `UpdateBanner.tsx` | Android, on foreground |

## 3. Design system

All in [theme.ts](../apps/mobile/src/ui/theme.ts) and [primitives.tsx](../apps/mobile/src/ui/primitives.tsx).

- **Colour:** `paper / surface / surfaceSunken`, `ink / inkMuted / inkFaint`, `line / lineStrong`, one `accent`, money colours `owed` (green) / `owe` (red) / `settled`. Light and dark palettes; appearance follows the system or a choice on Wallet.
- **Type:** display 28, title 19, heading 16, body 15, label 13, caption 12, and `amountLg/Md/Sm` in system mono.
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32. Radius 6 / 10 / 14 / pill. Content max width 720, dialogs 480.
- **Primitives:** `Screen` (header, scroll body, sticky footer that hides under the keyboard), `Card`, `SectionLabel`, `Button` (primary / secondary / quiet, `danger`, `busy`, `hint`), `IconButton`, `Dialog`, `ConfirmButton`, `LearnMore`, `Segmented`, `Avatar`, `Badge`, `Amount`, `QuoteBreakdown`, and the three states `Loading` / `ErrorState` / `EmptyState`.

Rule for reviewers: a fix should land in a primitive or token where it can, so every screen gets it.

## 4. How to look at it

```bash
npm run web        # mock mode, seeded groups, Guest link tab
npm run dev        # real API, starts at Welcome with no groups
```

Or `preview_start` with `web` / `web-live` from `.claude/launch.json`. Check each screen at 375 px wide in both light and dark, and turn on the failure knobs (`EXPO_PUBLIC_MOCK_FAILURE_RATE=0.3`, `EXPO_PUBLIC_MOCK_ALWAYS_FAIL=true`, long `settleDelayMs`) so the error and slow paths get seen. Flows worth walking end to end:

1. Goa trip → Settle up → Pay (Om) → Lightning → Settled.
2. Goa trip → Options (Aman) → paste an invoice (rejected) → paste `aman@walletofsatoshi.com`.
3. Add expense: equal, by shares, exact; submit with fields missing.
4. Guest link tab: each scenario (demo, fresh, already settled, unknown).
5. A fresh install against the real API: tour → Welcome → New group → Invite.

---

## 5. Findings

Severity: **P0** blocks or misleads people, **P1** real friction, **P2** polish.

### P0

**1. Android's back button has nowhere to go.** There is no `BackHandler` anywhere in `apps/mobile` and no navigation library, so React Native's default runs: back from Add expense, Manage, History or any tab closes the app instead of going up a level. On the web the URL stays `/` on every screen, so the browser's back button leaves the site. For an Android-first app this is the most common gesture there is.
*Fix:* in `DemoApp.tsx`, register `BackHandler` to call the current screen's `onBack` (they all already take one), and on web push a history entry per route. The README already plans to move to expo-router, which solves both.
*Fixed:* [backNavigation.ts](../apps/mobile/src/ui/backNavigation.ts). `Screen` registers its `onBack`; open sheets and dialogs register their `onClose` and get the press first. Android's back button runs the newest one, and leaves the app only from the groups list. On the web the navigator keeps one history entry per level of depth (`depthOf` in `DemoApp.tsx`). Entries are added on the tap that goes in, because Chrome skips entries a page adds without a tap. The browser's back button walks the same path the arrow does. Checked in the browser; not yet on an Android device.

**2. Interactive elements have no role for screen readers or keyboards.** On the web, the group rows, every `Button`, the Paid-by chips, the split checkboxes and the bottom tabs are plain `div`s with `tabindex=0` and no role. A screen reader reads "Goa trip, 4 members, you owe, ₹3,100" with no hint it can be pressed; the tab bar has no selected state; checkboxes don't say checked. Only `IconButton`, `Segmented` and `LearnMore` set roles.
*Fix:* `accessibilityRole="button"` (and `accessibilityState={{ disabled, busy }}`) on the `Pressable` in `Button` ([primitives.tsx:209](../apps/mobile/src/ui/primitives.tsx:209)); `"tab"` + `selected` in `DemoBar`; `"checkbox"` + `checked` and `"radio"` for the chips in [AddExpenseScreen.tsx:256-344](../apps/mobile/src/ui/AddExpenseScreen.tsx:256); `"button"` with a label like "Goa trip, you owe ₹3,100" on group rows ([GroupsListScreen.tsx:163](../apps/mobile/src/ui/GroupsListScreen.tsx:163)).
*Fixed:* every `Pressable` in `src/ui` now has a role:
- `Button`: role, label, and disabled and busy states.
- The header arrow is "Back".
- The bottom bar has tab roles and marks the selected tab.
- In Add expense: Paid by and Split are radio groups, Between rows are checkboxes, the share steppers are buttons, and both fields carry their labels.
- Group and expense rows, the update banner and the sheet backdrop are buttons.
- `Avatar` initials are hidden from screen readers.

**3. Several token pairs fail WCAG AA contrast.** Measured:

| Pair | Ratio | Needs |
|---|---|---|
| `inkFaint` on `surface`, light | 2.99 | 4.5 |
| `inkFaint` on `paper`, light | 2.82 | 4.5 |
| `inkFaint` on `surface`, dark | 3.85 | 4.5 |
| white on `accent`, light (every primary button) | 4.15 | 4.5 |
| white on `accent`, dark | 3.17 | 4.5 |
| `lineStrong` input border on `paper`, light | 1.50 | 3.0 |

`inkFaint` is used 68 times, mostly for the 12 px captions that carry real information ("4 members", "Only Om can confirm…", "Treat it like a password"). Primary buttons are the one thing the palette says to press.
*Fix:* darken light `inkFaint` to about `#7A7268` and lift dark to about `#968D83`; darken light `accent` to about `#B05515` (or use `ink` text on dark mode's accent); give inputs a `lineStrong` that reaches 3:1. Re-check `owed`/`owe` after. Keep the warm hues; only the lightness moves.
*Fixed* in [theme.ts](../apps/mobile/src/ui/theme.ts):

| Mode | Token | Was | Now | Ratio now |
|---|---|---|---|---|
| Light | `inkFaint` / `settled` | `#9C948A` | `#726A60` | 5.0 on paper |
| Light | `inkMuted` | `#6B635A` | `#5C554D` | 6.9 on paper |
| Light | `accent` | `#C2621C` | `#AD5615` | white on it 5.1 |
| Light | `accentPressed` | `#A85315` | `#934812` | |
| Light | `lineStrong` | `#D4CCC0` | `#968D81` | 3.1 on paper |
| Dark | `inkFaint` / `settled` | `#7F776E` | `#9A9187` | 5.5 on surface |
| Dark | `lineStrong` | `#48413A` | `#746B61` | 3.2 on surface |
| Dark | `onAccent` | white | ink `#1A1714` | 5.6 on the amber |

`inkMuted` moved so it stays a step darker than `inkFaint`.

### P1

**4. "You owe ₹3,100" doesn't say to whom until you switch tabs.** The group header shows one net number; the per-person breakdown and the Pay buttons live behind the third tab, Settle up. Seeing the number is the moment someone wants to act.
*Fix:* under the balance card, list the top one or two debts inline ("You owe Om ₹1,700 · Pay") or make the card itself open Settle up.

**5. The group screen spends half the viewport before the content.** At 375×812, header + join request + balance card + tabs end at ~y 350, and the footer and bottom bar take another ~130. The tab control scrolls away with the content.
*Fix:* make the segmented tabs sticky; collapse the join request into a one-line banner that expands; hide the bottom tab bar inside a group (it's a pushed screen, not a tab).

**6. History is hard to find.** It only appears as the footer button while the Settle up tab is selected ([GroupDetailScreen.tsx:282](../apps/mobile/src/ui/GroupDetailScreen.tsx:282)). On Expenses the footer is Add expense; nothing else links to it.
*Fix:* put History in the group header next to Manage, or as a row at the end of the expense list.

**7. Expenses carry no date and no "your share".** Rows read "Scooter rental · Yash paid · split equally, 4 ways · ₹3,200". The data has `createdAt`. The question people bring to a list like this is "when was that, and what's it to me?"
*Fix:* group rows under date headers, and add a right-aligned "you lent ₹2,400" / "you owe ₹800" line in the money colours under the total.

**8. Add expense: no "you", errors land far from the field, labels aren't attached.**
- The person using the app shows as "Yash" in Paid by and Between. Show "You", and default Paid by to them (it does) visibly.
- Submitting without a name shows "Give it a name." in a box above the submit button ([AddExpenseScreen.tsx:407](../apps/mobile/src/ui/AddExpenseScreen.tsx:407)), while the field is scrolled off the top. Put the message under the field, outline it in `danger`, and scroll to it.
- Inputs get their accessible name from the placeholder ("Dinner at Thalassa", "0") instead of "What was it?" / "How much?". Pass `accessibilityLabel`.
- "Remainder is spread a paisa at a time…" shows even when the split is exact (₹1,001 ÷ 4). Show it only when there is a remainder, and say who gets it.
- No date (defaults to now, can't log yesterday's dinner) and no notes. Worth adding a date field at least.

**9. The demo skips the screen that shows the rate and fee.** Against the real API, "Pay with Lightning" opens the invoice with `QuoteBreakdown` (sats, rate, fee). In mock mode the same tap goes straight to "Sending" and then "Settled", so the demo never shows the screen that proves "fees on top", and anyone reviewing in mock mode misses it.
*Fix:* have `MockClient` return an invoice `destination` for the `invoice` rail and settle it after a delay, so the demo walks the real path.

**10. The rail picker has no visible way out.** The rails state of `SettleUpSheet` ends with the options and an error, no Close ([SettleUpSheet.tsx:433](../apps/mobile/src/ui/SettleUpSheet.tsx:433)); the blocked state has one. The "Waiting for payment" state has none either. Only tapping the scrim dismisses it, which people don't discover on a bottom sheet.
*Fix:* a quiet Close / Cancel in every sheet state, and a drag handle.

**11. Wallet is a wall of text, and holds the wrong settings.**
- The screen is mostly prose: an intro, two explained forms, a UPI paragraph, and twelve "What you're trusting" sections. The things to *do* (connect, add address, add UPI) are separated by explanation.
- It opens with "Nostr Wallet Connect" and a `nostr+walletconnect://` field, the most technical option, ahead of the Lightning address most people would use, and ahead of UPI, which most Indian users have.
- Appearance (light/dark) lives here ([WalletScreen.tsx:145](../apps/mobile/src/ui/WalletScreen.tsx:145)), not under Account.
*Fix:* lead with a "How you get paid" summary showing what's set up (✓ UPI · ✗ Lightning) and one primary action; order by likelihood (UPI for rupee users, then Lightning address, then NWC under "Advanced"); move the trust section into a collapsed "What you're trusting" row or the FAQ; move Appearance to Account.

**12. Top-level tabs show a back arrow.** Wallet and Account render `‹` in the header while also being bottom-bar tabs. It's unclear whether back means "previous screen" or "Groups".
*Fix:* drop `onBack` on tab roots.

**13. Join requests read as a stranger at the door.** "Someone wants to join as Aman · Code 4821" with "Let in" (primary) and "Not them" sits above the balance on the group screen. It works, but the code check is explained in a small caption and the primary styling nudges toward letting in.
*Fix:* make the code the visual focus ("Does Aman see **4821**?"), and give both buttons equal weight.

### P2

14. **Empty and first-run states for a real account.** Against the real API someone starts with no groups. Make sure Groups list leads with "New group" as the primary action and a line on what happens next, rather than a secondary button under an empty list. (Mock mode hides this.)
15. **Inconsistent button labels across debts.** "Options" for a ghost vs "Pay" for a joined member is honest, but "Options" says nothing. "Ways to pay Aman" or "Can't pay yet" reads better.
16. **Title and status disagree while paying.** Title "Waiting for payment", body "Sending ₹1,700 to Om", status "Sending". Pick one verb per state.
17. **The payment proof hash is truncated with nothing to do with it.** Add copy, or label it "Proof saved" and put the hash in History.
18. **Tab bar has no icons and no active indicator beyond text weight.** Icons plus an accent underline make it scannable, and the active state is visible to people who can't tell 500 from 600 weight.
19. **Touch targets.** Segments and chips are 36 px high, the back chevron is a text glyph with `hitSlop` 12. Aim for 44 px.
20. **Copy: duplicate branches.** `howToGetPaid` in `SettleUpSheet.tsx` returns the same string in both arms of its ternary.
21. **Haptics and feedback.** No haptic on Settled, on a successful add, or on a destructive confirm. A light success haptic on the Settled screen does a lot for confidence.
22. **Desktop web.** The app sits in a 720 px column against the left edge in the browser pane; check it's centred on wide windows and that the guest pages (the ones strangers see) look deliberate at desktop width.

---

## 6. Suggested order

| Step | Items | Size |
|---|---|---|
| Accessibility pass in primitives + tokens | ~~2, 3~~ (done), 19 | Small: mostly `primitives.tsx`, `theme.ts`, `DemoApp.tsx` |
| Back navigation | ~~1~~ (done), 12 | Small |
| Group screen hierarchy | 4, 5, 6, 7 | Medium: `GroupDetailScreen.tsx` |
| Add expense polish | 8 | Small to medium |
| Settle-up sheet and mock invoice | 9, 10, 16, 17 | Small to medium |
| Wallet restructure | 11 | Medium: mostly moving and collapsing |
| Polish | 13–22 | Small each |

## 7. Not covered yet

- Native Android and iOS rendering (fonts, keyboard, safe areas, the update banner) — this pass was web only.
- Light mode screenshots, the tour, Welcome, New group, Manage, History, FAQ, Restore, Join and the `/g/` page were read in code but not walked.
- Real users. The research question worth answering first: when a ghost opens a pay link from WhatsApp, do they trust it enough to pay? `GuestPayScreen.tsx` is the page that decides whether the "only one of you needs the app" pitch works.
