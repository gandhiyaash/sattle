# Sattle

Split expenses with friends and settle up over Bitcoin Lightning. Nobody else needs to install anything.

A monorepo: an Expo (React Native) app for iOS, Android and web, a Node API on SQLite, and the domain package both of them share. The app runs against either an in-memory mock or the real API; one env var switches between them.

## Quick start

Requires Node 22.13+ (the API uses the built-in `node:sqlite`).

```bash
git clone https://github.com/gandhiyaash/sattle.git
cd sattle
npm install
cp apps/mobile/.env.example apps/mobile/.env
cp apps/api/.env.example apps/api/.env

npm run dev        # API on :3000 + web app on :8081, wired together
npm run web        # web app alone, against the in-memory mock
npm run api        # API alone
```

The demo opens on your groups. The bottom bar has three tabs: **Groups**, **Wallet**, and **Guest link**. The guest tab shows the page someone gets when you send them a pay link.

Try these flows:

- **Goa trip → Pay (Om).** Om has the app. The payment goes from `created` to `in_flight` to `confirmed`, and the balance changes only once the proof arrives.
- **Goa trip → Options (Aman).** Aman never installed the app. The sheet names him and offers three fixes. If you paste an invoice, it gets rejected. If you paste `aman@walletofsatoshi.com`, it's accepted.
- **Add expense.** A live preview shows each person's share, including where the leftover paisa goes.

```bash
npm test           # core ledger tests + API route tests (vitest)
npm run typecheck  # all workspaces
npm run db:reset -w @sattle/api   # wipe the API database; it reseeds on next start
```

## Configuration

`apps/mobile/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_USE_MOCK` | `true` | `false` switches to `ApiClient` (`npm run dev` sets this for you) |
| `EXPO_PUBLIC_MOCK_LATENCY` | `400` | ms added to every mock call |
| `EXPO_PUBLIC_MOCK_FAILURE_RATE` | `0` | 0–1 chance any mock call fails |
| `EXPO_PUBLIC_MOCK_ALWAYS_FAIL` | `false` | `true` makes every mock payment end in `failed` |
| `EXPO_PUBLIC_API_URL` | `http://localhost:3000` | real backend base URL |
| `EXPO_PUBLIC_APP_URL` | `http://localhost:8081` | base for invite links |

`apps/api/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_PATH` | `data/sattle.db` | SQLite file, relative to `apps/api` |
| `SEED` | `true` | load the demo fixtures into an empty database |
| `DEMO_USER_ID` | `u-yash` | requests without a bearer token act as this user. **Dev only** |
| `CORS_ORIGIN` | `http://localhost:8081` | comma-separated, `*` when empty |
| `SIM_*` | | timings, rate and forced failure for the simulated payment backend |

## Layout

```
packages/core/src/           @sattle/core: pure, no I/O, imported by both app and API
  types.ts                   Domain vocabulary. Member ≠ User. Debt is fiat.
  ledger.ts                  Pure maths: splits, balances, netting.
  settlementOptions.ts       Resolves what's possible BEFORE the user taps.
  quote.ts                   Fiat → sats at a pinned rate, 90s TTL.
  payLinks.ts                Guest-safe settlement view, NWC method lists.
  lightningAddress.ts        Parses what people paste. An address is not an invoice.
  fixtures.ts                Seed data covering all three member states.
  ledger.test.ts             Run before touching ledger.ts.

apps/api/src/                @sattle/api: Hono + node:sqlite
  server.ts                  Boot, env, and the payment backend choice.
  app.ts                     Assembly: CORS, auth, errors, route modules.
  routes/                    One module per owner: groups, settlements, payLinks, wallet.
  middleware.ts              Auth (with the public /s/ allowlist) and idempotency.
  settlementRules.ts         Debt cap and in-progress checks every settle route shares.
  repo.ts                    Row ↔ domain mapping. Only domain types leave it.
  db.ts                      Migration runner and seeding.
  migrations/                NNN_name.sql, applied in order. Add files; never edit merged ones.
  payments.ts                Payment seam. SimulatedPayments until NWC lands.
  app.test.ts                Route tests against an in-memory database.
  contract.test.ts           Auth boundary, migrations, and the 501 stubs still open.

apps/mobile/                 @sattle/mobile: Expo
  App.tsx                    Renders DemoApp
  src/
    client/
      SattleClient.ts        The interface. The only seam.
      MockClient.ts          In-memory, with latency and failure injection.
      ApiClient.ts           HTTP client for apps/api.
    wallet/
      WalletProvider.ts      Wallet seam. Breez is native-only; web gets a stub.
    react/
      SattleProvider.tsx     Context, hooks, and the mock/real swap.
      useSettleFlow.ts       One settle attempt, from open to terminal.
    ui/
      theme.ts               Design tokens. Warm paper, ink, one amber accent.
      primitives.tsx         Buttons, cards, Amount, loading/error/empty.
      GroupsListScreen.tsx   Entry screen. Net position across all groups.
      GroupDetailScreen.tsx  Balances, member states, expenses, settle entry.
      AddExpenseScreen.tsx   Live split preview as you type.
      SettleUpSheet.tsx      Rails, the blocked screen, and address entry.
      WalletScreen.tsx       Balance, address, and the trust disclosure.
      GuestPayScreen.tsx     The /s/<token> page. No app, no signup.
      DemoApp.tsx            Throwaway navigator so it all runs today.
```

`DemoApp.tsx` is a plain state machine, not expo-router. When routing is added, each case becomes a route file and the navigator is deleted. The screens only take props and callbacks, so none of them need to change.

## Working on it

[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) has the task dependency graph, who owns what, and the rules for working in parallel.

## Using the core

```tsx
import { SattleProvider, useClient, useAsync } from './src';

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

## The API

`apps/api` implements every route `ApiClient` calls, and nets debts with the same `@sattle/core` ledger the app uses, so balances can never disagree. The server doesn't trust the client:

- You only see groups you're a member of. Other groups return 404, not 403, so a guessed id reveals nothing.
- A settlement can't exceed the current netted debt, and a second one can't start while one is in progress.
- A ghost with no payout address gets `409 member_cannot_receive`.
- A repeated `idempotency-key` replays the first response instead of acting twice.

Payments go through `PaymentBackend` in `payments.ts`. Today that's `SimulatedPayments`, which walks the same states as the mock with a fake preimage. The NWC backend replaces it without touching the routes.

Auth is a bearer token looked up in `users.token`. With `DEMO_USER_ID` set, requests without a token act as that user. That's for local dev and must be unset anywhere real.

### Deploying

The API runs at `https://sattle.axiosiiitl.dev` on an Oracle VM, as the `sattle` systemd unit on port 3100 behind nginx. `.github/workflows/deploy.yml` redeploys it after every green `ci` run on a push to `main`: it SSHes in, fast-forwards to the commit `ci` passed, runs `npm ci` for the API, restarts the unit and waits for `/health`, printing the unit's log if either step fails. It can also be run by hand from the Actions tab, which deploys `main` as it is. It needs the `ORACLE_VM_HOST`, `ORACLE_VM_USER` and `ORACLE_VM_SSH_KEY` repository secrets.

The server's config lives in `~/sattle/apps/api/.env` on the VM, not in git. The demo server sets `PAYMENTS=sim` and `DEMO_USER_ID=u-yash`, because the app has no sign-in yet. The systemd unit and nginx site are copied in `apps/api/deploy/`. The deploy job doesn't install them, so after changing either, copy it into place on the VM and reload. The unit sandboxes the server so the only place it can write is `apps/api/data/`. If `.env` moves `DATABASE_PATH`, update `ReadWritePaths` to match. The TLS certificate comes from certbot and renews itself.

## Wiring the wallet

Write `BreezWallet implements WalletProvider` against `breez-sdk-liquid`, then return it from `buildWallet()` in the provider instead of `MockWallet`. Web keeps `UnavailableWallet`, because the SDK ships Rust bindings and will not run in a browser.

Screens should branch on `wallet.isAvailable`, never on `Platform.OS` — that way a native user who hasn't finished wallet setup hits the same path as a web guest, which is the behaviour you want.

## Not in here yet

- Real payments. The API's `SimulatedPayments` stands in until the NWC backend lands.
- Real auth. There's no sign-in flow yet; see `DEMO_USER_ID` above.
- Invites and claims. Groups and members can be created, but a ghost has no way to become a user yet.
- `BreezWallet`. Native builds use `MockWallet`; web uses `UnavailableWallet`.
- Real routing for the guest page (`/s/[token]`). `DemoApp` fakes it with a tab.
- Nostr identity, the NWC connection flow, on-chain rails, and QR rendering.

The types already have room for all of these. None of them are implemented.
