# Sattle

Split expenses with friends and settle up over Bitcoin Lightning. Nobody else needs to install anything.

Try it at [sattle.axiosiiitl.dev](https://sattle.axiosiiitl.dev). The Android build is attached to each [GitHub release](https://github.com/gandhiyaash/sattle/releases/latest).

A monorepo: an Expo (React Native) app for Android and web (iOS builds from the same code but hasn't been released), a Node API on SQLite, and the domain package both of them share. The app runs against either an in-memory mock or the real API; one env var switches between them.

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
| `PAYMENTS` | `sim` | `nwc` mints real invoices on payees' connected wallets; anything else simulates |
| `LEDGER_RELAYS` | empty | comma-separated relays the group ledger is published to. Empty: entries are signed and kept, not sent. See [The ledger on Nostr](#the-ledger-on-nostr) |
| `RATE_FALLBACK_INR_PER_BTC` | `9000000` | rate used if CoinGecko has never answered |
| `SIM_*` | | timings, rate and forced failure for the simulated payment backend |

## Layout

```
packages/core/src/           @sattle/core: pure, no I/O, imported by both app and API
  types.ts                   Domain vocabulary. Member ≠ User. Debt is fiat.
  ledger.ts                  Pure maths: splits, balances, netting.
  settlementOptions.ts       Resolves what's possible BEFORE the user taps.
  quote.ts                   Fiat → sats at a pinned rate, 90s TTL.
  payLinks.ts                Guest-safe settlement view, NWC method lists.
  invites.ts                 The /join/<token> path, and finding a token in what someone pasted.
  groupLinks.ts              The /g/<token> path.
  expenseRules.ts            Who may change or remove an expense. The app and the server both ask it.
  lightningAddress.ts        Parses what people paste. An address is not an invoice.
  fixtures.ts                Seed data covering all three member states.
  ledger.test.ts             Run before touching ledger.ts.

apps/api/src/                @sattle/api: Hono + node:sqlite
  server.ts                  Boot, env, and the payment backend choice.
  app.ts                     Assembly: CORS, auth, errors, route modules.
  routes/                    One module per owner: groups, settlements, payLinks, invites, groupLinks, wallet, ledger.
  middleware.ts              Auth (with the public /s/ allowlist) and idempotency.
  settlementRules.ts         Debt cap and in-progress checks every settle route shares.
  groupRules.ts              Who may change or remove what: expenses, members, groups, accounts.
  repo.ts                    Row ↔ domain mapping. Only domain types leave it.
  db.ts                      Migration runner and seeding.
  migrations/                NNN_name.sql, applied in order. Add files; never edit merged ones.
  payments.ts                Payment seam, and SimulatedPayments for dev and demos.
  payments/nwc.ts            Real payments: invoices on the payee's wallet over NWC, confirmed by lookup.
  nwc.ts                     NIP-47 client: get_info, make_invoice, lookup_invoice.
  nostrLedger.ts             The ledger on Nostr: signed, encrypted, chained entries, and reading them back.
  scripts/ledgerVerify.ts    Rebuilds a group's balances from relays alone.
  app.test.ts                Route tests against an in-memory database.
  contract.test.ts           Auth boundary and migrations.

apps/mobile/                 @sattle/mobile: Expo
  App.tsx                    Routes /s/<token> to the guest page and /join/<token> to joining; otherwise the app.
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
      JoinScreen.tsx         The /join/<token> page: who invited you to what, who you are, and Join.
      GroupGuestScreen.tsx   The /g/<token> page: the whole group, read-only, with Settle on each debt.
      GroupSettingsScreen.tsx  Rename the group, remove a member, leave it, delete it.
      AccountScreen.tsx      Who you're signed in as, and deleting the account.
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

**Members are not users.** A `Member` is a row in a group with a `status` of `ghost`, `joined`, or `nwc_linked`. Ghosts have never installed anything. They can pay by scanning, but they can't receive until someone adds their Lightning address. Until then `createSettlement` throws `member_cannot_receive`. Retrofitting this is miserable, which is why it is in the type from line one.

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
2. **Invite them.** Shares the group's invite, where Aman picks his own row and takes it over; see [Joining a group](#joining-a-group). Best long-term, slowest right now.
3. **Mark as settled.** Cash, UPI, forgiven. Present on every screen, never removable.

Two rules the tests pin down: the blocked message names Aman rather than describing a system state, and `manual` survives into `rails` even when every other option is gone. A ledger app that cannot record "he paid me in cash" is punitive.

## The API

`apps/api` implements every route `ApiClient` calls, and nets debts with the same `@sattle/core` ledger the app uses, so balances can never disagree. The server doesn't trust the client:

- You only see groups you're a member of. Other groups return 404, not 403, so a guessed id reveals nothing.
- A settlement can't exceed the current netted debt, and a second one can't start while one is in progress.
- A ghost with no payout address gets `409 member_cannot_receive`.
- A repeated `idempotency-key` replays the first response instead of acting twice.

Payments go through `PaymentBackend` in `payments.ts`, and `PAYMENTS` picks one:

- `nwc` (`payments/nwc.ts`): real payments. For each settlement it pins a quote at the live rate, asks the payee's own wallet for an invoice over Nostr Wallet Connect, and polls that wallet (`lookup_invoice`) until it reports the invoice paid. The preimage is checked against the payment hash before it's stored. Open invoices are picked up again after a restart. The server never holds funds.
- anything else: `SimulatedPayments`, which walks the same states as the mock with a fake preimage.

One gap with real payments on: a ghost's Lightning address can't be paid yet, because the payee's wallet is how a payment is confirmed and a ghost hasn't connected one. The payment ends as `failed` with "Nothing moved" rather than be marked paid without proof.

Auth is a bearer token looked up in `users.token`. `POST /accounts` is the only way to get one: it takes a display name and returns a new user and a random token, and the app keeps the token on the device (`src/account/tokenStore`, SecureStore on native, localStorage on web). There's no email, password or recovery. With `DEMO_USER_ID` set, requests without a token act as that user. That's for local dev and must be unset anywhere real.

### Joining a group

A group starts with one person who has the app; everyone else is a ghost, a name on the ledger. An invite turns ghosts into members. It is one link for the whole group, `/join/<token>`: anyone already in the group taps **Invite them to join** under the member list and sends it to the chat everyone is in. Whoever opens it sees who invited them to what and a list of the people who haven't joined, picks the one they are, and joins. They take over that row as it is: same name, same history, same balance. Someone who isn't on the list taps **+**, gives their name, and joins as a new member with nothing owed either way. Someone with no account gets one in the same tap, under the name they joined as.

Joining is full membership. There are no roles, so the new member can read everything in the group and add expenses, members, settlements and invites of their own. They can leave, but nobody else can remove them. The link is therefore treated as a key:

- It is 128 random bits, and only a member of the group can make one.
- A group has at most one. Sharing again hands out the same link, so the one already in the chat keeps working.
- It lasts a week.
- Anyone in the group can replace it or turn it off under **Manage**, which is how a link sent to the wrong chat is cancelled.
- Each ghost can be taken once. Picking a name someone has already joined as answers `409 conflict`.
- Adding yourself under the name of a ghost who is still waiting answers `409 conflict` too, so nobody starts a second row beside the one that holds their balance.
- One person can hold only one member of a group.

What it does not do is check who is on the other end. Anyone holding the link can join as any ghost, or add themselves, for as long as it works: it does not run out when the list does. That is the price of one link for everyone. A wrong pick is undone by leaving, and a link in the wrong hands by turning it off.

`GET /join/:token` is public, like the pay page, and returns names and nothing else: the group, the inviter, and each person who hasn't joined, with an opaque `ref` in place of an id. A `ref` is a hash of the link and the member, so it is no use with another link. Joining is `POST /groups/join` with the token and either the `ref` or, to be added as someone new, a `displayName`; it needs an account. `GET`, `POST` and `DELETE /groups/:id/invites` read, replace and turn off the group's invite.

A link opens the web app. The installed app has no link handling yet, so there the link is pasted under **Join with a link** on the groups list.

### Group links

A pay link covers one debt. A group link covers the group: someone in it taps **Share the group link** and posts `/g/<token>` in the chat everyone is already in. Whoever opens it, with no app and no account, sees every spend with each person's share and who owes whom, and taps **Settle** on a debt to pay it. That opens the pay page for that one debt, which mints the invoice on the wallet of the person owed and offers **Open your wallet** and a QR code, exactly as a pay link does.

A pay link deliberately shows nothing else about the group, and this shows all of it, so it is the group's own choice:

- There is no link until someone in the group makes one, and there is only ever one. Making another replaces it, and the old one stops working.
- Anyone in the group can replace it or turn it off, under **Manage**. It doesn't expire by itself.
- It only reads. Nothing under `/g/` changes the group; the one thing it can start is a payment, and that goes to the person owed like any other.
- `GET /g/:token` returns names and amounts and no ids. Each debt carries an opaque `ref`, a hash tied to that link, which is what the page sends back to pay it.

Settle appears on a debt when the person owed can receive, by the same rule the app uses (`canReceive`). A debt to someone with nowhere to receive is listed with "settle with them directly". The page can't tell who is looking, so every payable debt has the button: paying someone else's is allowed, and the money goes to the person owed either way.

Opening the wallet is the phone's job, not ours. The button is a `lightning:` link: Android shows a chooser of the installed wallets, iOS opens one, and on a computer the QR code is scanned.

### Changing and removing

One rule runs through all of it, the same one settling follows: nobody can undo what someone else is owed. `groupRules.ts` holds it, and the app only offers what the server would accept.

| What | Who | When it's refused |
| --- | --- | --- |
| Change or delete an expense | The person who paid it. What a ghost paid, anyone in the group. | For anyone else: a groupmate could otherwise shrink what they owe. |
| Rename a group | Anyone in it | |
| Remove a member | Anyone in the group, for a ghost that no expense, payment or pay link names | For anyone in the ledger, and for someone who has joined: only they can leave. |
| Leave a group | Yourself | If you're the only one with an account (delete the group instead), or while a payment to you is under way. |
| Delete a group | Anyone in it | While anything is owed in it or a payment is under way, so deleting it can't erase a debt. |
| Disconnect a wallet | Yourself | While a payment to you is under way: that wallet is what confirms it. |
| Delete an account | Yourself | While a payment to you is under way. |

Leaving is the reverse of joining. The member's row stays, as a ghost, with its name, history and balance, so the others' ledger still adds up; an invite hands it back. One consequence to know: once the person owed is a ghost, the one who owes can mark the debt settled, as with any ghost.

Deleting an account leaves every group that way. A group only that account could open is deleted with it, since nobody could ever reach it again. The token, the wallet connection, the pay links and the invites it made are removed; the names its members had in shared groups stay.

An edited or deleted expense can't be changed on Nostr, where entries are permanent, so the change is published as a further entry (see [The ledger on Nostr](#the-ledger-on-nostr)). Deleting a group deletes its ledger key from the server; what was already published stays on the relays, readable only by someone who copied the backup key.

### Deploying

Both halves run on one Oracle VM behind nginx:

- **API** at `https://battle.axiosiiitl.dev`: the `sattle` systemd unit on port 3100. Site config in `apps/api/deploy/nginx.conf`.
- **Web app** at `https://sattle.axiosiiitl.dev`: static files from `expo export --platform web`, served from `/var/www/sattle-web/current`. Every path falls back to `index.html`, so pay links (`/s/<token>`) open the guest page. Site config in `apps/mobile/deploy/nginx.conf`.

`.github/workflows/deploy.yml` redeploys both after every green `ci` run on a push to `main`, in two parallel jobs:

- `api` SSHes in, fast-forwards to the commit `ci` passed, runs `npm ci` for the API, restarts the unit and waits for `/health`, printing the unit's log if either step fails.
- `web` builds the web app in Actions against the API above, uploads it to `releases/<sha>` on the VM and repoints the `current` symlink. The five newest builds stay there; to roll back, point `current` at an older one.

Both can be run by hand from the Actions tab, which deploys `main` as it is. They need the `ORACLE_VM_HOST`, `ORACLE_VM_USER` and `ORACLE_VM_SSH_KEY` repository secrets. The `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL` repository variables override the two URLs for the web and Android builds.

The server's config lives in `~/sattle/apps/api/.env` on the VM, not in git. For a live server, leave `SEED` and `DEMO_USER_ID` unset, so the database starts empty and every request needs a device account's token. The server refuses to start with either set when `NODE_ENV=production`, which the systemd unit sets, and names the one to remove. Set `CORS_ORIGIN=https://sattle.axiosiiitl.dev` so only the web app can call the API from a browser. The deploy jobs don't install the systemd unit or the nginx sites, so after changing one, copy it into place on the VM and reload. The unit sandboxes the server so the only place it can write is `apps/api/data/`. If `.env` moves `DATABASE_PATH`, update `ReadWritePaths` to match. Both TLS certificates come from certbot and renew themselves.

### Backups

The whole database is one SQLite file, `apps/api/data/sattle.db`. `npm run db:backup -w @sattle/api` copies it into `apps/api/data/backups/` with `VACUUM INTO`, which gives a consistent copy while the server keeps running and writing. Copies are named `sattle-<time>-<kind>[-<note>].db`, and each kind keeps its newest few: 14 `daily`, 20 `deploy`, 10 `manual`. A server with no database yet has nothing to copy, and that isn't an error.

Daily copies come from a systemd timer, which is installed once on the VM:

```sh
sudo cp apps/api/deploy/sattle-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sattle-backup.timer
systemctl list-timers sattle-backup.timer    # next run
```

Before a deploy that adds a migration, take one by hand (`npm run db:backup -w @sattle/api -- manual before-<what>`), because migrations run when the server restarts and can't be undone.

To restore one, stop the server, put the copy in place and drop the old WAL files:

```sh
sudo systemctl stop sattle
cd ~/sattle/apps/api
cp data/backups/<file>.db data/sattle.db && rm -f data/sattle.db-wal data/sattle.db-shm
sudo systemctl start sattle
```

The copies sit on the same disk as the database, so they cover a bad migration or a mistaken delete, not losing the VM. For that, copy `data/backups/` somewhere else too.

### Releasing the Android app

A release is one run of the `Create Android Release (APK & AAB)` workflow (`.github/workflows/android-release.yml`). Merge what should ship into `main`, then start it from the Actions tab, or:

```sh
gh workflow run android-release.yml -f bump_type=patch -f track=internal -f update_priority=0
```

| Input | Values | What it sets |
| --- | --- | --- |
| `bump_type` | `patch` (default), `minor`, `major`, `none` | How the version moves from the newest `vX.Y.Z` tag. `none` rebuilds that version without moving its tag. |
| `track` | `internal` (default), `alpha`, `beta`, `production` | The Play track the build is published to. |
| `update_priority` | `0` (default) to `5` | How hard installed copies are pushed to update. See [Update priority](#update-priority). |

The run then does the whole release:

1. Works out the version from the newest `vX.Y.Z` tag. Releases are tags only: `main` takes changes only through pull requests, so nothing is committed back, and `apps/mobile/package.json` is just the starting point before the first tag. Runs from any branch but `main` are refused.
2. Generates `android/` with `expo prebuild` and builds a signed APK and AAB. The version name is the bumped version. The version code is the workflow's run number, so it only ever goes up.
3. Tags the commit it built as `vX.Y.Z` and pushes only the tag, which the `main` ruleset doesn't cover. This comes after the build, so a failed build leaves no tag behind.
4. Creates the GitHub release `vX.Y.Z`, with both files attached and the commits since the last tag as its notes.
5. Uploads the AAB to the chosen Play track, rolled out to everyone on it.

`just android-release` builds the same signed APK and AAB on your own machine, into `dist-android/`, without bumping, tagging or uploading anything; `scripts/android-release.sh` lists its inputs.

Every pull request gets a release build too, from the `android-build` workflow, so a change that breaks the release shows up before anything is tagged. It needs no secrets: the APK is signed with the debug key and kept on the run for 7 days as `sattle-pr-<number>.apk`. That APK installs on a phone, but not over a copy from Play.

Send a release to `internal` first and install it from Play on a phone. Once it's checked, promote it to `production` in the Play Console, which ships the same file. An urgent fix is the exception: run the workflow straight to `production` with the priority set, because the priority is fixed at upload.

What it needs from the repository:

| | Name | For |
| --- | --- | --- |
| Secrets | `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | Signing. The run stops at the start without all four, rather than ship a build signed with the debug key. |
| Secret | `PLAY_STORE_CREDENTIALS` | The Play upload: a service account's JSON key. Without it the run ends at the GitHub release. |
| Variable | `EXPO_PUBLIC_USE_MOCK` | Leave unset. The run refuses to send a mock build to `production`. |

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

Write `BreezWallet implements WalletProvider` against `breez-sdk-liquid`, then return it from `buildWallet()` in the provider instead of `UnavailableWallet`. `MockWallet`, with its made-up balance, is only for demo mode on native. Web keeps `UnavailableWallet`, because the SDK ships Rust bindings and will not run in a browser.

Screens should branch on `wallet.isAvailable`, never on `Platform.OS` — that way a native user who hasn't finished wallet setup hits the same path as a web guest, which is the behaviour you want.

## The ledger on Nostr

The server keeps the ledger in SQLite, so if the server goes away, so would a group's history. To stop that, every expense, every change to one, and every confirmed settlement is also published to Nostr relays as one event (`nostrLedger.ts`):

- **Signed** by the server's Nostr key (made on first start, kept in the database), so a relay can't forge or alter an entry.
- **Encrypted** with NIP-44 under a random key per group. Relays and anyone else see ciphertext. Only members are given the key.
- **Chained.** Each entry carries a sequence number and the id of the entry before it, so a missing or reordered entry shows up when the ledger is read back.
- **Append-only.** A published entry can't be altered. An expense that is edited gets a second entry with how it reads now, and one that is deleted gets an entry saying so; whoever reads the ledger back takes the last word on each.

Entries go through an outbox table, `ledger_entries`. Every few seconds the server signs an entry for anything new, then publishes whatever hasn't gone out. A relay outage or a restart only delays publishing. With `LEDGER_RELAYS` empty, entries are still signed and kept, and they go out once relays are set, history included.

In the app, the group screen's **Backup on Nostr** card shows how much has been published and copies the group's backup key, `sattle-ledger://<server pubkey>?key=…&relay=…`. With that key and no Sattle server at all:

```bash
npm run ledger:verify -w @sattle/api
```

asks for the key, fetches the group's entries from the relays, checks every signature and the chain, decrypts them, and prints the balances and who pays whom.

The key decrypts the group's whole history, and the entries sit on public relays for good, so treat it like a password. The script reads it from a prompt that doesn't echo, never from the command line: npm prints the command line, and the shell keeps it in history. For scripts, pipe it in or set `SATTLE_LEDGER_BACKUP`.

What it doesn't fix: the server signs every entry, so the record proves what the server said, not what each member agreed to. Members signing their own entries needs Nostr identities, which come next. Relays can't read an entry, but they can see the server's pubkey, a per-group tag, and when each entry was made.

## Not in here yet

- Recovering an account. A device account can't move to another device or survive cleared app data. Nostr sign-in is the likely way to fix that.
- Opening an invite link straight into the installed app. It opens the web app; in the app the link is pasted.
- Removing someone who has joined. They can leave, but nobody else can take them out.
- `BreezWallet`, an in-app wallet. Until then the app has none: you receive through your own wallet over NWC and pay from any wallet. Demo mode on native shows `MockWallet`.
- Native routing. On web, `/s/<token>` and `/join/<token>` open the right screen; the installed app doesn't handle links yet.
- Paying a ghost's Lightning address with real payments on (see [The API](#the-api)).
- Nostr identity (NIP-07 / NIP-46), so members sign their own ledger entries, and on-chain rails.

The types already have room for all of these. None of them are implemented.

## License

[MIT](LICENSE).
