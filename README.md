# Sattle

Split expenses with friends and settle up over Bitcoin Lightning or UPI. Nobody else needs to install anything.

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

`npm run web` is demo mode: it opens on seeded groups, and the bottom bar adds a **Guest link** tab showing the page someone gets when you send them a pay link. Against the real API (`npm run dev`, or any build without `EXPO_PUBLIC_USE_MOCK=true`), the app first asks your name and makes a device account, and you start with no groups. Either way, the first launch on a device opens on a three-screen tour: splitting, that only one of you needs the app, and the ways to settle up. It asks nothing and is shown once; **Skip** leaves it.

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
| `EXPO_PUBLIC_APP_URL` | `http://localhost:8081` | base for the links the app shares |

`apps/api/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | |
| `DATABASE_PATH` | `data/sattle.db` | SQLite file, relative to `apps/api` |
| `SEED` | `false` | `true` loads the demo fixtures into an empty database. Leave unset in production |
| `DEMO_USER_ID` | `u-yash` | requests without a bearer token act as this user. **Dev only** |
| `CORS_ORIGIN` | `http://localhost:8081` | comma-separated, `*` when empty |
| `PAYMENTS` | `sim` | `nwc` gets real invoices from payees' connected wallets or their own Lightning addresses; anything else simulates. A production server warns at startup without `nwc` |
| `ALLOW_SIMULATED_PAYMENTS` | | `true` says a production server simulates on purpose, for a public demo, and silences that warning |
| `LIGHTNING_NETWORK` | `bc` | network address invoices must be on: `bc` mainnet, `tbs` signet, `tb` testnet, `bcrt` regtest |
| `LEDGER_RELAYS` | empty | comma-separated relays the group ledger is published to. Empty: entries are signed and kept, not sent. See [The ledger on Nostr](#the-ledger-on-nostr) |
| `RATE_FALLBACK_INR_PER_BTC` | unset | fixed rate used only if no price source (CoinGecko, Blockchain.com, Coinbase) has ever answered. Unset, that payment fails instead |
| `SIM_*` | | timings, rate and forced failure for the simulated payment backend |

## Layout

```
packages/core/src/           @sattle/core: pure, no I/O, imported by both app and API
  types.ts                   Domain vocabulary. Member ≠ User. Debt is in the group's currency.
  currency.ts                The currencies a group can be kept in, and how an amount in each is typed and shown.
  ledger.ts                  Pure maths: splits, balances, netting.
  settlementOptions.ts       Resolves what's possible BEFORE the user taps, from the ways to pay the payer uses.
  quote.ts                   What a debt comes to in sats: a pinned rate for rupees, none for a group kept in bitcoin. 90s TTL.
  payLinks.ts                Guest-safe settlement view, NWC method lists.
  groupLinks.ts              The /g/<token> and /join/<token> paths, and finding the link's token in what someone pasted.
  expenseRules.ts            Who may change or remove an expense. The app and the server both ask it.
  lightningAddress.ts        Parses what people paste. An address is not an invoice.
  upi.ts                     UPI: parsing an ID, the upi://pay link, and reading what a UPI app hands back.
  nostrLedger.ts             Reading a group's ledger back from Nostr events with its backup key. Imported as @sattle/core/nostrLedger, so only what reads it pulls in nostr-tools.
  fixtures.ts                Seed data covering all three member states.
  ledger.test.ts             Run before touching ledger.ts.

apps/api/src/                @sattle/api: Hono + node:sqlite
  server.ts                  Boot, env, and the payment backend choice.
  app.ts                     Assembly: CORS, auth, errors, route modules.
  routes/                    One module per owner: groups, settlements, payLinks, groupLinks, joining, wallet, ledger, upi.
  middleware.ts              Auth (with the public /s/, /g/ and /join/ prefixes) and idempotency.
  settlementRules.ts         Debt cap and in-progress checks every settle route shares.
  groupRules.ts              Who may change or remove what: expenses, members, groups, accounts.
  repo.ts                    Row ↔ domain mapping. Only domain types leave it.
  db.ts                      Migration runner and seeding.
  migrations/                NNN_name.sql, applied in order. Add files; never edit merged ones.
  payments.ts                Payment seam, and SimulatedPayments for dev and demos.
  payments/lightning.ts      Real payments: invoices on the payee's NWC wallet or Lightning address, confirmed by lookup, LUD-21 verify or proof.
  nwc.ts                     NIP-47 client: get_info, make_invoice, lookup_invoice.
  lnurl.ts                   LNURL-pay client: an invoice from a Lightning address, checked before it's used.
  bolt11.ts                  Reads an invoice's payment hash, amount, description hash and expiry.
  safeFetch.ts               Every request to a typed address: https only, no private IPs, no redirects, capped.
  proof.ts                   Checks a preimage against the payment hash.
  rates.ts                   Live BTC price from CoinGecko, Blockchain.com or Coinbase, cached 30s.
  backup.ts                  Database backups: before every deploy, or by hand.
  nostrLedger.ts             The ledger on Nostr: signing, encrypting and publishing entries. Reading them back is in core.
  scripts/ledgerVerify.ts    Rebuilds a group's balances from relays alone.
  app.test.ts                Route tests against an in-memory database.
  contract.test.ts           Auth boundary and migrations.

apps/mobile/                 @sattle/mobile: Expo
  App.tsx                    Routes /s/<token> to the guest page, /g/<token> to the group page, /join/<token> to joining and /restore to restoring; otherwise the app.
  modules/in-app-updates/    Local Expo module (Kotlin): Google Play in-app updates.
  src/
    account/
      tokenStore.ts          Where the device keeps its account token. SecureStore on native, localStorage on web.
      signInKey.ts           The token as a sign-in key, to copy to another device and paste there.
    ledger/
      readBack.ts            Fetches a group's entries from relays and reads them with its backup key. Loaded only when someone restores.
    client/
      SattleClient.ts        The interface. The only seam.
      MockClient.ts          In-memory, with latency and failure injection.
      ApiClient.ts           HTTP client for apps/api.
    wallet/
      WalletProvider.ts      Wallet seam. Breez is native-only; web gets a stub.
    updates/
      updater.ts             When to ask about an update, and what the banner shows.
      nativeUpdates.ts       Native seam. Android talks to Play; iOS and web get null.
    upi/
      launchUpi.ts           Native seam. Android opens a UPI app and hears back; iOS and web get null.
    prefs/
      currencyPrefs.ts       Which currencies someone uses, and what a new group starts in. The rules, under vitest.
      currencyStore.ts       Where the device keeps that. SecureStore on native, localStorage on web.
      useCurrencyPrefs.ts    The choice, live, and the ways to pay it leaves on show.
    react/
      SattleProvider.tsx     Context, hooks, and the mock/real swap.
      useSettleFlow.ts       One settle attempt, from open to terminal.
      useAppUpdate.ts        Checks on every foreground; the banner's hook.
    ui/
      theme.ts               Design tokens. Warm paper, ink, one amber accent.
      primitives.tsx         Buttons, cards, Amount, loading/error/empty.
      WelcomeScreen.tsx      First launch against the real API: your name, and a device account. Or a sign-in key from another device.
      RestoreScreen.tsx      The /restore page: a group rebuilt from its backup key, straight off the relays.
      GroupsListScreen.tsx   Entry screen. Net position across all groups.
      NewGroupScreen.tsx     A group's name and the people in it.
      GroupDetailScreen.tsx  Balances, member states, expenses, settle entry.
      AddExpenseScreen.tsx   Live split preview as you type.
      SettleUpSheet.tsx      Rails, the blocked screen, address entry, and paying by UPI.
      InvoicePanel.tsx       The invoice: Open your wallet, a QR code, copying it, and how long it has left.
      UpiPanel.tsx           What to pay over UPI: the ID, a QR code on the web, and the button that opens a UPI app.
      WalletScreen.tsx       Balance, address, and the trust disclosure.
      GuestPayScreen.tsx     The /s/<token> page. No app, no signup.
      JoinScreen.tsx         The /join/<token> page: which group it is, who you are, and asking to join.
      GroupGuestScreen.tsx   The /g/<token> page, where the shared link lands: the whole group, read-only, Lightning and UPI on each debt, and Join.
      GroupSettingsScreen.tsx  Rename the group, remove a member, leave it, delete it.
      AccountScreen.tsx      Who you're signed in as, copying or replacing your sign-in key, the currencies you use, and deleting the account.
      OnboardingScreen.tsx   First launch: three screens on how it works, shown once.
      tourStore.ts           Whether this device has been shown them. SecureStore on native, localStorage on web.
      CurrencyPicker.tsx     Which currencies someone uses and what a new group starts in, under Account.
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

**Debt is in the group's currency, in whole units of its smallest part.** `amount` is always minor units: paise in a group kept in rupees, sats in one kept in bitcoin. A group has one currency from the day it is made, chosen from the ones its maker uses, and it never changes. A rupee debt becomes sats only inside a `Quote`, pinned at quote time with a 90-second TTL. A sats debt is paid as it stands: its quote names no rate, and the server never looks one up.

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
2. **Invite them.** Shares the group's link, where Aman taps **Join**, picks his own row and takes it over; see [Joining a group](#joining-a-group). Best long-term, slowest right now.
3. **Mark as settled.** Cash, UPI, forgiven. Present on every screen, never removable.

Two rules the tests pin down: the blocked message names Aman rather than describing a system state, and `manual` survives into `rails` even when every other option is gone. A ledger app that cannot record "he paid me in cash" is punitive.

## First launch and currencies

The first time the app opens on a device it shows a three-screen tour (`OnboardingScreen.tsx`): splitting, that only one person needs the app, and the ways to settle up. It asks nothing and is shown once: reaching the end or tapping **Skip** is what the device remembers (`tourStore`). A `/join/` link that opened the app is kept and followed afterwards. The guest pages (`/s/`, `/g/`) are for people without the app and never show it.

Everyone starts out using both rupees and bitcoin, so nothing is hidden. A way to pay is offered when the person owed has set it up: UPI for a UPI ID, Lightning for a wallet or a Lightning address.

A group is kept in one currency, picked when it is made and never changed: rupees, or bitcoin. A group kept in bitcoin is counted in sats everywhere: amounts are typed and shown as whole sats, and settling one needs no exchange rate.

Under **Account**, **Currencies** lets someone turn one of the two off. Nobody is asked to; it is there for someone who only ever uses one. Turning one off does two things.

- **New groups aren't offered in it.** Someone who uses one currency is never asked which. Someone who uses both picks per group, starting from the one they said new groups start in.
- **The app stops showing what goes with it.** Rupees bring UPI and bitcoin brings Lightning. With bitcoin off there is no wallet connection, Lightning address, invoice, pay link or sats anywhere, and the trust screen leaves out the rows about them. With rupees off there is no UPI. `payWays()` in `@sattle/core` is the whole rule, and `resolveSettlementOptions` takes its answer, so a payer left with no way to pay is told what to ask for in terms of the way they do use.

Two things are never hidden, because hiding them would strand someone:

- **Lightning, in a group kept in bitcoin.** Nothing else can settle it, so it shows there whatever was chosen. If people owe someone in such a group and they have bitcoin turned off, **Set up getting paid** turns it back on for them and says so.
- **Anything already set up.** A connected wallet, a Lightning address or a UPI ID stays on the Wallet screen until its owner removes it, even with that currency turned off. Other people can still pay them that way, so they have to be able to see it and take it away.

The last currency can't be turned off. The choice is kept on the device (`prefs/currencyStore`) and never sent to the server, which is why it changes what is shown and not what is allowed: the server still takes UPI for a rupee group and Lightning for any group, whoever asks.

## The API

`apps/api` implements every route `ApiClient` calls, and nets debts with the same `@sattle/core` ledger the app uses, so balances can never disagree. The server doesn't trust the client:

- You only see groups you're a member of. Other groups return 404, not 403, so a guessed id reveals nothing.
- A settlement can't exceed the current netted debt, and a second one can't start while one is in progress.
- A ghost with no payout address gets `409 member_cannot_receive`.
- A repeated `idempotency-key` replays the first response instead of acting twice.

Payments go through `PaymentBackend` in `payments.ts`, and `PAYMENTS` picks one:

- `nwc` (`payments/lightning.ts`): real payments. For each settlement it pins a quote at the live rate, or for a group kept in bitcoin takes the sats owed as they are, and gets an invoice that pays the payee directly:
  - from their own wallet over Nostr Wallet Connect, polling it (`lookup_invoice`) until it reports the invoice paid, or
  - for a member with no NWC wallet, from the Lightning address they set themselves (LNURL-pay, `lnurl.ts`). The invoice is checked first: exact amount, our network, the address's metadata. When the address has a verify link (LUD-21) it's polled, and only a preimage that matches the payment hash counts as paid. Without one, the invoice is closed when it expires, saying we couldn't tell. Either way the payer can confirm it with their proof of payment, the preimage their wallet hands back (`POST /settlements/:id/proof`, or `/s/:token/proof` from a pay link), even after we've called it expired: it's checked against the payment hash stored when the invoice was minted. Every request to an address goes through `safeFetch.ts`, which refuses private addresses, redirects and slow or oversized answers.

  The preimage is checked against the payment hash before it's stored. Open invoices are picked up again after a restart. The server never holds funds. `npm run lnurl:smoke -w @sattle/api -- you@wallet.com` checks a real address.
- anything else: `SimulatedPayments`, which walks the same states as the mock with a fake preimage.

One gap with real payments on: a ghost's Lightning address can't be paid yet. A groupmate typed it, so a payment to it proves nothing about the ghost; joining clears it, and the member sets their own. The payment ends as `failed` with "Nothing moved" rather than be marked paid without proof.

Auth is a bearer token looked up in `users.token`. `POST /accounts` is the only way to get one: it takes a display name and returns a new user and a random token, and the app keeps the token on the device (`src/account/tokenStore`, SecureStore on native, localStorage on web). There's no email or password. **Account**, **Copy sign-in key** gives the token as `sattle-signin:<token>`; pasting that under **I have a sign-in key** on the welcome screen of another phone or browser, or the same one after its data was cleared, checks it against `GET /me` and keeps it. Both devices are then signed in as the same user. **Replace sign-in key** (`POST /me/token`) issues a new token and ends the old one on every device that has it, which is what to do about a key that may have leaked or a lost phone that was signed in. A device whose answer was lost still holds the old key, so for ten minutes the old key can reach that route alone, and only to have the same request (same idempotency key) replayed; a new request with it gets `401`.

### Signing in with Nostr

An account can have a Nostr key linked to it (**Account → Sign in with Nostr**), and then **Sign in with Nostr** on the welcome screen opens that account on a device with nothing on it: no old phone, no sign-in key. That is the way back into a group nobody else has joined, where there's nobody to let you in.

The app never sees the private key. It asks the person's own signer to sign a proof: a browser extension (NIP-07, `window.nostr`, web only) or a remote signer they point it at with a `bunker://` link (NIP-46: nsec.app, Amber, their own bunker). The proof is an HTTP-auth event shaped as NIP-98 has it (kind 27235, the URL and method as tags) plus a `challenge` tag from `POST /auth/nostr/challenge`. The server (`nostrAuth.ts`) checks the signature, the kind, that it was made in the last five minutes, that it names the route it was sent to, and last that the challenge is one it handed out, unused and unexpired, which uses it up. A proof can't be replayed, and one made for linking can't sign in.

- `POST /auth/nostr/challenge`: public, `{ challenge, expiresAt }`, good once for five minutes.
- `POST /auth/nostr`: public, `{ event }` → `{ user, token }`, the account's current sign-in key. `404` if no account has the key linked. No idempotency key: a replay on a public route would hand the token to whoever repeated it.
- `POST /me/nostr`: `{ event }` links the key that signed it, answering the User with its `npub`. `409` if another account has it. Linking another replaces it.
- `DELETE /me/nostr`: unlinks it.

The remote-signer code and the restore code load with one `import()` (`src/nostr/lazy.ts`), so nostr-tools isn't on the app's startup path. With `DEMO_USER_ID` set, requests without a token act as that user. That's for local dev and must be unset anywhere real.

### Joining a group

A group starts with one person who has the app; everyone else is a ghost, a name on the ledger. The group's link turns ghosts into members. It is the group's one link, `/g/<token>`: anyone already in the group taps **Invite** at the top of the group and sends it to the chat everyone is in. It opens the group's page, where anyone can see what's been split and pay what they owe (see [The group link](#the-group-link)), and that page has **Join** on it. Join opens `/join/<token>`, with the same token: whoever taps it sees which group it is and the people in it, picks the one they are from those nobody has joined as yet, and asks to join. The ones who have joined are listed too, marked, so the page is the whole group even when every name is taken. Someone already in the group then sees "Someone wants to join as Kabir" at the top of the group, with a four-digit code, and taps **Let in** or **Not them**. Once let in, they take over that row as it is: same name, same history, same balance. Someone who isn't on the list taps **+**, gives their name, and asks to be added as a new member with nothing owed either way. Someone with no account gets one in the same tap, under the name they asked for. Until they're let in, the group sits on their groups list as **Asked to join**, showing their code, and they can do no more than anyone else holding the link. Someone already in the group has nobody left to be, so for them Join opens the group.

Joining is full membership. There are no roles, so the new member can read everything in the group and add expenses, members and settlements, and share or replace its link. They can leave, but nobody else can remove them. So the link is treated as a key, and holding it is never enough:

- It is 128 random bits, and only a member of the group can make one.
- A group has at most one. Sharing again hands out the same link, so the one already in the chat keeps working.
- It doesn't run out by itself. Anyone in the group can replace it or turn it off under **Manage**, which is how a link sent to the wrong chat is cancelled.
- Nobody becomes a member by holding it. Asking makes a request (`join_requests`); only someone already in the group can let them in, and only then is the ghost claimed.
- Each ghost can be taken once. Someone who joined and then lost the phone or browser they joined with picks their own name from the joined ones, and asks to take it back. The request names the account that has it, and the group sees "Someone says they're Kabir, on a new device"; the old device, if it's still around, sees "Someone wants to take over your place". Anyone in the group can let them in, the old device included. That hands the member over as if the old account had left and the new one was let in as the ghost, so the old account loses the group. It only happens while the account the request named still has the name, and not while a payment to it is under way (`409 conflict`). In a group where nobody else has joined, only the old device can say yes; without it, [signing in with Nostr](#signing-in-with-nostr) is the way back, if a key was linked. Several people can ask to be the same ghost, so a stranger asking first can't lock the real person out; letting one in turns the others down. The card says when two people are asking for one name, and the code is how to tell which is which: ask the person which code they see.
- At most 20 requests wait on a group at once, so a leaked link can't bury the real one under requests from throwaway accounts. Turning some down makes room.
- Adding yourself under the name of a ghost who is still waiting answers `409 conflict` too, so nobody starts a second row beside the one that holds their balance.
- One person can hold only one member of a group.

The link proves nothing about who is on the other end, since it can be forwarded, so a person checks instead: whoever lets someone in is vouching for them. That is the price of one link for everyone and no passwords. A link in the wrong hands is turned off, and its requests turned down; a wrong yes is undone only by the person leaving, so the card asks to let in only someone you know is them.

`GET /join/:token` is public, like the group page, and returns names and nothing else: the group, each person who hasn't joined, with an opaque `ref` in place of an id, and the names of those who have. A `ref` is a hash of the link and the member, so it is no use with another link. Asking is `POST /join-requests` with the token and either the `ref` or, to be added as someone new, a `displayName`; it needs an account, and asking again replaces the last request. `GET /links/:token/group` needs an account too: it answers with the group when the caller is already in it and `null` when they aren't, which is how the app knows to open the group. `GET /me/join-requests` and `DELETE /join-requests/:id` are the asker's; `GET /groups/:id/join-requests`, `POST /join-requests/:id/approve` and `/decline` are for anyone in the group. The link itself is made, replaced and turned off with `GET`, `POST` and `DELETE /groups/:id/link`.

The shared link, `/g/<token>`, opens in the browser for everyone, so paying needs no app. On an Android phone with the app installed, **Join** hands over to the app, which claims `/join/` links, and opens the join screen there, or the group for someone already in it. Everywhere else it carries on in the web app, and in the installed app the link can still be pasted under **Join with a link** on the groups list.

Android hands the app the link only when the site vouches for it. `apps/mobile/public/.well-known/assetlinks.json`, which the web deploy publishes, has to list the SHA-256 of every certificate a real copy is signed with: the upload key, which signs the APK on a GitHub release, and Play's app signing key, which signs what Play installs (Play Console, **App integrity**, **App signing**). A copy signed with a key that isn't listed, a debug build for one, gets the link in the browser as before.

### Paying by UPI

A rupee debt can also be paid over UPI, outside Lightning. Someone adds their UPI ID under **Wallet**; whoever owes them in a group kept in INR then sees **Pay by UPI** in the settle sheet, unless they have turned rupees off (see [First launch and currencies](#first-launch-and-currencies)).

The payer is only asked when there is something to choose. **Pay by UPI** is offered only for someone who has added a UPI ID. Without one, **Pay** opens straight on the Lightning invoice (`onlyRail`). It never opens a UPI app by itself: someone who takes UPI and has no wallet still gets **Pay by UPI** to tap. Neither is required of anyone: an account is only a name. Someone with neither can't be paid here yet, and whoever owes them is told so and can remind them. An invoice still out for the debt, from the sheet before it was closed or from a pay link, is picked up, not asked for a second time, since the server makes one at a time.

What happens with UPI depends on the device, because only Android lets an app hear back from a UPI app:

- **Android.** The app opens the `upi://pay` link as an activity that returns a result (`src/upi/launchUpi.android.ts`, over `expo-intent-launcher`). Android shows its chooser of UPI apps, the payer pays, and the UPI app hands back a status and a reference. On `SUCCESS` the app tells the person owed straight away. Anything else is left to the payer: try again, or say they paid.
- **iPhone.** A UPI app says nothing back. The sheet opens one, shows the UPI ID, and asks the payer to come back and tap **I’ve paid**.
- **Web.** The same link as a QR code to scan from a phone, then **I’ve paid**.

Sattle never learns that the money moved. No bank or UPI app tells a third party that one person paid another, and what an Android UPI app hands back is the payer's own phone talking, so it is treated as a hint. The payer's word is therefore a **claim** (`upi_claims`), not a settlement, and it moves no balance. The person owed sees "Kabir says they paid you ₹500 by UPI", with the reference when there is one, and either confirms it, which makes it a settlement (`rail: upi`, `manually_confirmed`), or says it didn't arrive, which the payer is then shown. It is the same rule as marking a debt settled by hand: the person it costs if it's false is the one who says so.

- A debt has at most one claim; claiming again replaces it. While one is pending, the payer's **Pay** button waits, so they don't pay twice.
- The claim can't be for more than is owed, and confirming is refused if less than that is owed by then.
- A UPI ID often contains a phone number, so it isn't in the member list. `GET /groups/:id/members` only says who takes UPI; `GET /groups/:id/members/:memberId/upi` gives the ID, and only to someone who owes that person right now.
- Wallet says so before such an ID is saved. When the one being typed has a mobile number in it (`upiIdHasPhoneNumber`), a warning says who would see the number, and that most UPI apps let you add an ID without one. It only warns: **Save anyway** saves it. An ID with no number in it gets no warning.
- Only a member who has joined can be paid this way. A ghost has no account to put a UPI ID on and nobody to confirm.
- It is offered under real and simulated payments alike, and someone who can only be paid by UPI isn't shown as blocked.
- UPI apps, GPay in particular, sometimes refuse or cap a payment started from another app's link to a personal UPI ID. When that happens the payer can still pay the ID shown on screen by hand and tap **I’ve paid**.

`PUT`/`DELETE /me/upi` set and remove the ID. `PUT /me/upi/group-links` turns off, or back on, the group links offering it, and `GET`/`PUT /me/upi/group-links/:groupId` is the same choice for one group (below). `POST /groups/:id/upi-claims` makes a claim; `POST /upi-claims/:id/confirm` and `/decline` are the payee's; `DELETE /upi-claims/:id` is the payer taking it back.

### The group link

A pay link covers one debt. The group link covers the group, and it is the only link a group has: someone in it taps **Invite** at the top of the group and posts `/g/<token>` in the chat everyone is already in. Whoever opens it, with no app and no account, sees every spend with each person's share and who owes whom, and taps **Pay with Lightning** on a debt to pay it. That opens the pay page for that one debt, which mints the invoice on the wallet of the person owed and offers **Open your wallet** and a QR code, exactly as a pay link does. Under the debts is **Join**, for the people who belong in the group; see [Joining a group](#joining-a-group).

A pay link deliberately shows nothing else about the group, and this shows all of it, so it is the group's own choice:

- There is no link until someone in the group makes one, and there is only ever one. Making another replaces it, and the old one stops working.
- Anyone in the group can replace it or turn it off, under **Manage**. It doesn't expire by itself.
- It only reads. Nothing under `/g/` changes the group. It can start a payment, which goes to the person owed like any other, and its holder can ask to join, which someone in the group has to say yes to.
- `GET /g/:token` returns names and amounts and no ids. Each debt carries an opaque `ref`, a hash tied to that link, which is what the page sends back to pay it.

**Pay with Lightning** appears on a debt when the person owed can receive, by the same rule the app uses (`canReceive`). **Pay by UPI** appears in a rupee group when the person owed has a UPI ID. Shared links show it from the start, so Wallet says so before an ID is saved: a UPI ID often holds a phone number and the link has no login. When the ID has a mobile number in it (`upiIdHasPhoneNumber`), Wallet warns before saving it and beside the switch once it's saved. IDs with a number that were saved before the warning existed kept the setting they had when shared links went from opt-in to on (migration 016). Under Wallet, **Turn off for shared links** stops it for every group they're in. Under **Manage**, in a group, the same switch is for that group alone, and it wins: off for one group while it is on for the rest, or on for one while it is off, until they tap **Use my Wallet setting here**. Neither choice is tied to one ID, so a new UPI ID leaves them as they are, and the choice for a group goes when the person leaves it. The ID isn't in `GET /g/:token`; `GET /g/:token/debts/:ref/upi` gives it for the one debt someone chose to pay. The page then shows the QR code (and on a phone, a button that opens a UPI app) and **I’ve paid**, which is `POST /g/:token/debts/:ref/upi-claims`: a claim, as in the app, marked as coming from the link. The person owed confirms it or says it didn't arrive, and the page shows which. It won't replace a claim the payer made in the app.

A debt to someone with nowhere to receive is listed with "settle with them directly", and in the app that person sees a card saying who can't pay them yet, with a way to set up getting paid. The page can't tell who is looking, so every payable debt has the buttons: paying someone else's is allowed, and the money goes to the person owed either way.

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

Leaving is the reverse of joining. The member's row stays, as a ghost, with its name, history and balance, so the others' ledger still adds up; the group's link hands it back. One consequence to know: once the person owed is a ghost, the one who owes can mark the debt settled, as with any ghost.

Deleting an account leaves every group that way. A group only that account could open is deleted with it, since nobody could ever reach it again. The token, the wallet connection, the pay links it made and its requests to join are removed; the names its members had in shared groups stay.

An edited or deleted expense can't be changed on Nostr, where entries are permanent, so the change is published as a further entry (see [The ledger on Nostr](#the-ledger-on-nostr)). Deleting a group deletes its ledger key from the server; what was already published stays on the relays, readable only by someone who copied the backup key.

### Deploying

Both halves run on one Oracle VM behind nginx:

- **API** at `https://battle.axiosiiitl.dev`: the `sattle` systemd unit on port 3100. Site config in `apps/api/deploy/nginx.conf`.
- **Web app** at `https://sattle.axiosiiitl.dev`: static files from `expo export --platform web`, served from `/var/www/sattle-web/current`. Every path falls back to `index.html`, so pay links (`/s/<token>`) open the guest page. Site config in `apps/mobile/deploy/nginx.conf`.

`.github/workflows/deploy.yml` redeploys both after every green `ci` run on a push to `main`, in two parallel jobs:

- `api` SSHes in, fast-forwards to the commit `ci` passed, runs `npm ci` for the API, restarts the unit and waits for `/health`, printing the unit's log if either step fails.
- `web` builds the web app in Actions against the API above, uploads it to `releases/<sha>` on the VM and repoints the `current` symlink. The five newest builds stay there; to roll back, point `current` at an older one.

Both can be run by hand from the Actions tab, which deploys `main` as it is. They need the `ORACLE_VM_HOST`, `ORACLE_VM_USER` and `ORACLE_VM_SSH_KEY` repository secrets. The `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL` repository variables override the two URLs for the web and Android builds.

The server's config lives in `~/sattle/apps/api/.env` on the VM, not in git. For a live server, leave `SEED` and `DEMO_USER_ID` unset, so the database starts empty and every request needs a device account's token. Set `PAYMENTS=nwc` so settling up moves real money. The server refuses to start when `NODE_ENV=production`, which the systemd unit sets, if `SEED` or `DEMO_USER_ID` is set, and names the one to remove. Without `PAYMENTS=nwc` it starts but logs a warning, since settling up would move balances and no money. A public demo server that should simulate payments sets `ALLOW_SIMULATED_PAYMENTS=true` to say so. Set `CORS_ORIGIN=https://sattle.axiosiiitl.dev` so only the web app can call the API from a browser. The deploy jobs don't install the systemd unit or the nginx sites, so after changing one, copy it into place on the VM and reload. The unit sandboxes the server so the only place it can write is `apps/api/data/`. If `.env` moves `DATABASE_PATH`, update `ReadWritePaths` to match. Both TLS certificates come from certbot and renew themselves.

### Backups

The whole database is one SQLite file, `apps/api/data/sattle.db`. `npm run db:backup -w @sattle/api` copies it into `apps/api/data/backups/` with `VACUUM INTO`, which gives a consistent copy while the server keeps running and writing. Copies are named `sattle-<time>-<kind>[-<note>].db`, and each kind keeps its newest few: 14 `daily`, 20 `deploy`, 10 `manual`. A server with no database yet has nothing to copy, and that isn't an error.

Daily copies come from a systemd timer, which is installed once on the VM:

```sh
sudo cp apps/api/deploy/sattle-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sattle-backup.timer
systemctl list-timers sattle-backup.timer    # next run
```

Every deploy takes a `deploy` copy, named for the commit going out, just before it restarts the server, because that's when migrations run and they can't be undone. If the copy fails, the deploy stops there and the running server is left alone. To keep one past the last 20 deploys, take it by hand: `npm run db:backup -w @sattle/api -- manual before-<what>`.

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

In the app, the group screen's **Backed up on Nostr** card shows how much has been published and copies the group's backup key, `sattle-ledger://<server pubkey>?key=…&relay=…`. With that key and no Sattle server at all, there are two ways to read the group back. Both fetch the group's entries from the relays, check every signature and the chain, decrypt them, and show the balances and who pays whom.

- **In the app:** `/restore` on the web, **Restore a group from its backup key** on the welcome screen, or **Read it back** on the backup card. It needs no account and makes no request to the API: the browser asks the relays for the server's entries under the group's tag, and decrypts them itself (`src/ledger/readBack.ts`, which reads with `@sattle/core/nostrLedger`). The key is pasted on the page and never goes in the address. The web app is served from the same VM as the API, so if the VM is gone, use the Android app, a local `npm run web`, or the script below.
- **In a terminal:**

  ```bash
  npm run ledger:verify -w @sattle/api
  ```

  asks for the key and prints the result.

The key decrypts the group's whole history, and the entries sit on public relays for good, so treat it like a password. The script reads it from a prompt that doesn't echo, never from the command line: npm prints the command line, and the shell keeps it in history. For scripts, pipe it in or set `SATTLE_LEDGER_BACKUP`.

What it doesn't fix: the server signs every entry, so the record proves what the server said, not what each member agreed to. Members signing their own entries needs Nostr identities, which come next. Relays can't read an entry, but they can see the server's pubkey, a per-group tag, and when each entry was made.

## Not in here yet

- Getting your place back in a group where you were the only one who had joined, without the old device, the sign-in key, or a Nostr key linked beforehand. Nobody else can vouch for you there.
- Amber's own sign-in intents (NIP-55) on Android. Amber works today through its bunker:// link. Remote signing hasn't been tried in the installed app, only on the web.
- Handing **Join** over to the installed app on an iPhone. That needs Associated Domains; it carries on in the web app, and in the app the link is pasted.
- Removing someone who has joined. They can leave, but nobody else can take them out.
- `BreezWallet`, an in-app wallet. Until then the app has none: you receive through your own wallet over NWC or at your Lightning address, and pay from any wallet. Demo mode on native shows `MockWallet`.
- Native routing. On web, `/s/<token>`, `/g/<token>` and `/join/<token>` open the right screen; the installed app handles only `/join/<token>`, and only on Android.
- Paying a ghost's Lightning address with real payments on (see [The API](#the-api)).
- Live status over SSE in the signed-in app. The server streams it, but a browser can't attach a sign-in token to an SSE connection, so the app polls; short-lived stream tickets would fix that.
- Knowing that a UPI payment happened. The person owed confirms it; a payment gateway that could confirm it for us would mean holding people's money.
- Members signing their own ledger entries with the Nostr key they sign in with, and on-chain rails.

The types already have room for all of these. None of them are implemented.

## License

[MIT](LICENSE).
