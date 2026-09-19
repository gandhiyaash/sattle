# Sattle

Split expenses with friends and settle up over Bitcoin Lightning. Nobody else needs to install anything.

Sattle is an Expo (React Native) app that runs on iOS, Android and web. Every screen works today against an in-memory mock backend, and you switch to a real server by changing one env var.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/gandhiyaash/sattle.git
cd sattle
npm install
cp .env.example .env
npm run web        # or: npm run ios / npm run android / npm start
```

The demo opens on your groups. The bottom bar has three tabs: **Groups**, **Wallet**, and **Guest link**. The guest tab shows the page someone gets when you send them a pay link.

Try these flows:

- **Goa trip → Pay (Om).** Om has the app. The payment goes from `created` to `in_flight` to `confirmed`, and the balance changes only once the proof arrives.
- **Goa trip → Options (Aman).** Aman never installed the app. The sheet names him and offers three fixes. If you paste an invoice, it gets rejected. If you paste `aman@walletofsatoshi.com`, it's accepted.
- **Add expense.** A live preview shows each person's share, including where the leftover paisa goes.

```bash
npm test           # ledger + settlement-option tests (vitest)
npm run typecheck
```

## Configuration

`.env` (copied from `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_USE_MOCK` | `true` | `false` switches to `ApiClient` |
| `EXPO_PUBLIC_MOCK_LATENCY` | `400` | ms added to every mock call |
| `EXPO_PUBLIC_MOCK_FAILURE_RATE` | `0` | 0–1 chance any mock call fails |
| `EXPO_PUBLIC_API_URL` | `http://localhost:3000` | real backend base URL |
| `EXPO_PUBLIC_APP_URL` | `http://localhost:8081` | base for invite links |

## Layout

```
App.tsx                      Renders DemoApp
src/core/
  index.ts                   Public exports
  domain/
    types.ts                 Domain vocabulary. Member ≠ User. Debt is fiat.
    ledger.ts                Pure maths: splits, balances, netting. No I/O.
    settlementOptions.ts     Resolves what's possible BEFORE the user taps.
    ledger.test.ts           Run before touching ledger.ts.
  client/
    SplitSatsClient.ts       The interface. The only seam.
    MockClient.ts            In-memory, with latency and failure injection.
    ApiClient.ts             HTTP, wired to routes you haven't built yet.
    fixtures.ts              Seed data covering all three member states.
    lightningAddress.ts      Parses what people paste. An address is not an invoice.
  wallet/
    WalletProvider.ts        Wallet seam. Breez is native-only; web gets a stub.
  react/
    SplitSatsProvider.tsx    Context, hooks, and the mock/real swap.
    useSettleFlow.ts         One settle attempt, from open to terminal.
  ui/
    theme.ts                 Design tokens. Warm paper, ink, one amber accent.
    primitives.tsx           Buttons, cards, Amount, loading/error/empty.
    GroupsListScreen.tsx     Entry screen. Net position across all groups.
    GroupDetailScreen.tsx    Balances, member states, expenses, settle entry.
    AddExpenseScreen.tsx     Live split preview as you type.
    SettleUpSheet.tsx        Rails, the blocked screen, and address entry.
    WalletScreen.tsx         Balance, address, and the trust disclosure.
    GuestPayScreen.tsx       The /s/<token> page. No app, no signup.
    DemoApp.tsx              Throwaway navigator so it all runs today.
```

`DemoApp.tsx` is a plain state machine, not expo-router. When routing is added, each case becomes a route file and the navigator is deleted. The screens only take props and callbacks, so none of them need to change.

## Using the core

```tsx
import { SplitSatsProvider, useClient, useAsync } from './src/core';

function GroupScreen({ groupId }: { groupId: string }) {
  const client = useClient();
  const { data: debts, loading, error, reload } = useAsync(
    () => client.getDebts(groupId),
    [groupId]
  );
  // ...
}
```

Settlement is async by design. `createSettlement` returns before the payment is finished, so you subscribe for updates:

```tsx
const settlement = useSettlement(settlementId);
// status: created → awaiting_payment → in_flight → confirmed
```

## Four decisions baked in

**Members are not users.** A `Member` is a row in a group with a `status` of `ghost`, `joined`, or `nwc_linked`. Ghosts have never installed anything. They can pay by scanning, but they cannot receive — `createSettlement` throws `member_cannot_receive` if you try. Retrofitting this is miserable, which is why it is in the type from line one.

**Debt is denominated in fiat.** `amount` is always minor units (paise). Sats appear only inside a `Quote`, pinned at quote time with a 90-second TTL. There is deliberately no per-group setting for this — one invariant, not a knob users have to understand.

**The ledger moves on preimage, never on optimism.** `computeBalances` only counts settlements in `confirmed` or `manually_confirmed`. The mock enforces the same rule, so you cannot accidentally build a screen that assumes otherwise.

**Fees are added on top, never deducted.** A ₹1,200 debt settles at exactly ₹1,200 plus the payer's fee. `Quote.feeSat` is separate from `Quote.amountSat` for this reason.

## Building the screens

Turn the failure knobs on while you work. Most of the screens you'll get wrong are the ones you never see with happy-path fixtures:

```ts
new MockClient({ failureRate: 0.3 })              // error states
new MockClient({ alwaysFailSettlement: true })    // payment failure screen
new MockClient({ settleDelayMs: 12000 })          // the long wait
new MockClient({ latencyMs: 0 })                  // tests
```

## The ghost path

Aman never installed anything, so there is nowhere to send his money. The wrong fix is a `catch` around `createSettlement` — by then the user has already committed to an action that was never going to work, and the only honest thing left is an error.

`resolveSettlementOptions()` decides first. When the recipient cannot receive, it returns `blocked` with three remedies in place of rails:

1. **Add their Lightning address.** The route most people miss. Any wallet gives Aman an address, and paying it needs nothing from him — no install, no signup, no device awake. `setMemberPayoutAddress` stores it and leaves his status as `ghost`, because he is payable, not joined.
2. **Invite them.** Shares the claim link. Best long-term, slowest right now.
3. **Mark as settled.** Cash, UPI, forgiven. Present on every screen, never removable.

Two rules the tests pin down: the blocked message names Aman rather than describing a system state, and `manual` survives into `rails` even when every other option is gone. A ledger app that cannot record "he paid me in cash" is punitive.

## Wiring the real backend

1. Implement the routes in `ApiClient.ts`. The method bodies are the spec.
2. Import `domain/ledger.ts` on the server too — same netting code both sides, so balances can never disagree.
3. Set `EXPO_PUBLIC_USE_MOCK=false`.

`createSettlement`, `addExpense` and `markSettledManually` all send an `idempotency-key`. Honour it. A retried settlement that mints a second invoice is a double payment.

## Wiring the wallet

Write `BreezWallet implements WalletProvider` against `breez-sdk-liquid`, then return it from `buildWallet()` in the provider instead of `MockWallet`. Web keeps `UnavailableWallet`, because the SDK ships Rust bindings and will not run in a browser.

Screens should branch on `wallet.isAvailable`, never on `Platform.OS` — that way a native user who hasn't finished wallet setup hits the same path as a web guest, which is the behaviour you want.

## Not in here yet

- A real backend. `ApiClient` is written against routes that don't exist yet.
- `BreezWallet`. Native builds use `MockWallet`; web uses `UnavailableWallet`.
- Real routing for the guest page (`/s/[token]`). `DemoApp` fakes it with a tab.
- Nostr identity, the NWC connection flow, on-chain rails, and QR rendering.

The types already have room for all of these. None of them are implemented.
