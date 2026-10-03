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

`npm run web` is demo mode: it opens on seeded groups, and the bottom bar adds a **Guest link** tab showing the page someone gets when you send them a pay link. Against the real API (`npm run dev`, or any build without `EXPO_PUBLIC_USE_MOCK=true`), the app first asks your name and makes a device account, and you start with no groups.

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
| `EXPO_PUBLIC_USE_MOCK` | `false` | `true` swaps in the in-memory mock with its demo data and fake wallet. `.env.example` sets it; `npm run dev` overrides it to `false` |
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
| `SEED` | `false` | `true` loads the demo fixtures into an empty database. Leave unset in production |
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
  modules/in-app-updates/    Local Expo module (Kotlin): Google Play in-app updates.
  src/
    client/
      SattleClient.ts        The interface. The only seam.
      MockClient.ts          In-memory, with latency and failure injection.
      ApiClient.ts           HTTP client for apps/api.
    wallet/
      WalletProvider.ts      Wallet seam. Breez is native-only; web gets a stub.
    updates/
      updater.ts             When to ask about an update, and what the banner shows.
      nativeUpdates.ts       Native seam. Android talks to Play; iOS and web get null.
    react/
      SattleProvider.tsx     Context, hooks, and the mock/real swap.
      useSettleFlow.ts       One settle attempt, from open to terminal.
      useAppUpdate.ts        Checks on every foreground; the banner's hook.
    ui/
      theme.ts               Design tokens. Warm paper, ink, one amber accent.
      primitives.tsx         Buttons, cards, Amount, loading/error/empty.
      GroupsListScreen.tsx   Entry screen. Net position across all groups.
      GroupDetailScreen.tsx  Balances, member states, expenses, settle entry.
      AddExpenseScreen.tsx   Live split preview as you type.
      SettleUpSheet.tsx      Rails, the blocked screen, and address entry.
      WalletScreen.tsx       Balance, address, and the trust disclosure.
      GuestPayScreen.tsx     The /s/<token> page. No app, no signup.
      UpdateBanner.tsx       Update available, downloading, restart to install.
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

Auth is a bearer token looked up in `users.token`. `POST /accounts` is the only way to get one: it takes a display name and returns a new user and a random token, and the app keeps the token on the device (`src/account/tokenStore`, SecureStore on native, localStorage on web). There's no email, password or recovery. With `DEMO_USER_ID` set, requests without a token act as that user. That's for local dev and must be unset anywhere real.

### Deploying

Both halves run on one Oracle VM behind nginx:

- **API** at `https://battle.axiosiiitl.dev`: the `sattle` systemd unit on port 3100. Site config in `apps/api/deploy/nginx.conf`.
- **Web app** at `https://sattle.axiosiiitl.dev`: static files from `expo export --platform web`, served from `/var/www/sattle-web/current`. Every path falls back to `index.html`, so pay links (`/s/<token>`) open the guest page. Site config in `apps/mobile/deploy/nginx.conf`.

`.github/workflows/deploy.yml` redeploys both after every green `ci` run on a push to `main`, in two parallel jobs:

- `api` SSHes in, fast-forwards to the commit `ci` passed, runs `npm ci` for the API, restarts the unit and waits for `/health`, printing the unit's log if either step fails.
- `web` builds the web app in Actions against the API above, uploads it to `releases/<sha>` on the VM and repoints the `current` symlink. The five newest builds stay there; to roll back, point `current` at an older one.

Both can be run by hand from the Actions tab, which deploys `main` as it is. They need the `ORACLE_VM_HOST`, `ORACLE_VM_USER` and `ORACLE_VM_SSH_KEY` repository secrets. The `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL` repository variables override the two URLs for the web and Android builds.

The server's config lives in `~/sattle/apps/api/.env` on the VM, not in git. For a live server, leave `SEED` and `DEMO_USER_ID` unset, so the database starts empty and every request needs a device account's token. Set `CORS_ORIGIN=https://sattle.axiosiiitl.dev` so only the web app can call the API from a browser. The deploy jobs don't install the systemd unit or the nginx sites, so after changing one, copy it into place on the VM and reload. The unit sandboxes the server so the only place it can write is `apps/api/data/`. If `.env` moves `DATABASE_PATH`, update `ReadWritePaths` to match. Both TLS certificates come from certbot and renew themselves.

### Releasing the Android app

A release is one run of the `Create Android Release (APK & AAB)` workflow (`.github/workflows/android-release.yml`). Merge what should ship into `main`, then start it from the Actions tab, or:

```sh
gh workflow run android-release.yml -f bump_type=patch -f track=internal -f update_priority=0
```

| Input | Values | What it sets |
| --- | --- | --- |
| `bump_type` | `patch` (default), `minor`, `major`, `none` | How the version in `apps/mobile/package.json` moves. `none` rebuilds the version already there. |
| `track` | `internal` (default), `alpha`, `beta`, `production` | The Play track the build is published to. |
| `update_priority` | `0` (default) to `5` | How hard installed copies are pushed to update. See [Update priority](#update-priority). |

The run then does the whole release:

1. Bumps the version, and commits and tags it as `vX.Y.Z`, locally for now.
2. Generates `android/` with `expo prebuild` and builds a signed APK and AAB. The version name is the bumped version. The version code is the workflow's run number, so it only ever goes up.
3. Pushes the commit and the tag together. This comes after the build, so a failed build leaves neither behind.
4. Creates the GitHub release `vX.Y.Z`, with both files attached and the commits since the last tag as its notes.
5. Uploads the AAB to the chosen Play track, rolled out to everyone on it.

`just android-release` builds the same signed APK and AAB on your own machine, into `dist-android/`, without bumping, tagging or uploading anything; `scripts/android-release.sh` lists its inputs.

Send a release to `internal` first and install it from Play on a phone. Once it's checked, promote it to `production` in the Play Console, which ships the same file. An urgent fix is the exception: run the workflow straight to `production` with the priority set, because the priority is fixed at upload.

What it needs from the repository:

| | Name | For |
| --- | --- | --- |
| Secrets | `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | Signing. The run stops at the start without all four, rather than ship a build signed with the debug key. |
| Secret | `PLAY_STORE_CREDENTIALS` | The Play upload: a service account's JSON key. Without it the run ends at the GitHub release. |
| Variable | `EXPO_PUBLIC_USE_MOCK` | Leave unset. The run refuses to send a mock build to `production`. |
| Ruleset | a bypass on `main` for the workflow | Step 3 pushes straight to `main`, which otherwise only takes pull requests. Without the bypass the run builds everything, fails at "Push Version Bump", and leaves no tag and no release. |

### Android updates

A copy installed from Google Play updates itself in place. On launch and on every return to the foreground the app asks Play whether a newer version is out. If one is, Play asks once, downloads it while the app stays open, and a line above the tab bar offers **Restart** when it's ready. A "no" is remembered for that version, and after that the same line offers **Update** without interrupting.

#### Update priority

Every Play release carries an in-app update priority, a number from 0 to 5 that installed copies read when they find the release. It is the `update_priority` input of the release workflow, and the app sorts it into two bands:

| Priority | What an installed copy does | Use it for |
| --- | --- | --- |
| `0` to `3` | The flow above: Play asks once, downloads in the background, and the app offers **Restart**. | Ordinary releases. `0` is the default, and the app treats all four the same. |
| `4` or `5` | Play takes over the screen, installs and restarts the app. Backing out leaves **Update** above the tab bar, and the next launch takes over again. | A release nobody should stay behind on: a security or payment fix, or a server change that older builds can't work with. The app treats both the same. |

Three things about it come from Play, not from this app:

- It is set at upload and can't be changed afterwards. A release that got the wrong priority needs another build.
- It can only be set through the Play API, which is what the workflow uses. A release uploaded by hand in the Play Console gets `0`.
- It carries over skipped versions, on any track. Someone updating across several versions gets the highest priority among them, even from a build that only went to `internal`. So a priority `5` build on `internal` makes the next `production` release urgent for everyone on an older version.

The line between the bands is `URGENT_PRIORITY` in `src/updates/updater.ts`.

`src/updates/updater.ts` holds the rules and runs under vitest against a fake Play. The native half is a local Expo module in `apps/mobile/modules/in-app-updates`, which autolinking picks up on `expo prebuild`, so there is nothing to add to `app.json`.

Play only answers for a copy it installed. A debug build or the APK from a GitHub release gets no prompts, so the real flow can only be tried from a Play track: install one release from the internal track, publish a second, and open the app.

## Wiring the wallet

Write `BreezWallet implements WalletProvider` against `breez-sdk-liquid`, then return it from `buildWallet()` in the provider instead of `MockWallet`. Web keeps `UnavailableWallet`, because the SDK ships Rust bindings and will not run in a browser.

Screens should branch on `wallet.isAvailable`, never on `Platform.OS` — that way a native user who hasn't finished wallet setup hits the same path as a web guest, which is the behaviour you want.

## Not in here yet

- Real payments. The API's `SimulatedPayments` stands in until the NWC backend lands.
- Recovering an account. A device account can't move to another device or survive cleared app data. Nostr sign-in is the likely way to fix that.
- Invites and claims. Groups and members can be created, but a ghost has no way to become a user yet.
- `BreezWallet`. Native builds use `MockWallet`; web uses `UnavailableWallet`.
- Real routing for the guest page (`/s/[token]`). `DemoApp` fakes it with a tab.
- Nostr identity, on-chain rails, and QR rendering.

The types already have room for all of these. None of them are implemented.
