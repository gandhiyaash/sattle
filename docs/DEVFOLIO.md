# Devfolio submission: Sattle

Copy each section into the matching Devfolio field.

---

## Name

Sattle

## Tagline

Split bills in sats. Only one of you needs the app.

## The problem it solves

Splitwise tells you that you owe Om ₹1,700 and then sends you somewhere else to pay. It can't move money itself, because moving money makes it a regulated money transmitter in every country it operates in.

Lightning removes that limit, and Bitcoin bill-splitters exist. But they all assume everyone in the group installs the app, makes a wallet, and funds it. No one does that to pay back a friend for dinner.

Sattle is built around the people who won't install it.

**Only one person needs the app.** Everyone else is a name in the group. To collect, you post one link in the group chat. It opens in any browser and shows what was spent and who owes what. Each person taps their debt and pays the Lightning invoice from whatever wallet they already use. To chase one person, you send them a pay link for just their debt. No signup, no keys, no install.

**The ledger is in the money you spent, and the payment is in sats.** A group keeps its expenses in its own currency, rupees by default, because that's what the dinner cost. Splits are whole paise: when a split doesn't divide evenly, the leftover paise go out one at a time in a fixed order, so every share is a whole number and the shares always add up to the total. Sats come in only at the moment of paying. Sattle pins a quote at the live rate for 90 seconds and makes an invoice that expires with it, so nobody pays yesterday's price.

**The ledger moves on proof, not on promises.** A debt clears only when the payee's wallet reports the invoice paid. If the wallet returns a preimage, Sattle checks it against the payment hash before trusting it. Nothing is marked paid because the app hoped it went through.

**Your wallet stays yours.** Sattle never holds money. Every invoice pays straight into the wallet of the person owed. You connect your wallet with Nostr Wallet Connect (NIP-47), and Sattle asks for two permissions, `make_invoice` and `lookup_invoice`. It can create invoices that pay *into* your wallet and check whether they were paid. It cannot spend. If your connection string grants more, the app tells you and recommends a narrower one. If your wallet can't do NWC (Wallet of Satoshi, Phoenix, Blink and most others can't), give it your Lightning address instead. Sattle fetches the invoice from the address (LNURL-pay) and checks the exact amount and network before showing it. It then confirms the payment through the address's verify link (LUD-21), or from the payer's proof of payment. Either way, the proof has to match the invoice's payment hash.

**The record outlives us.** Every expense and confirmed settlement is also published to Nostr relays: encrypted with NIP-44 under a key only the group holds, signed, and chained so a missing entry shows. The group screen copies a backup key, and with it `npm run ledger:verify` rebuilds every balance from the relays, with no Sattle server involved.

**UPI and cash still count, as claims.** Not everyone settles in sats. In a rupee group, someone who adds a UPI ID can be paid by UPI. On Android the app opens a UPI app and hears back. On an iPhone or the web the payer gets the UPI ID or a QR code, then taps **I've paid**. Sattle can't see a bank transfer, so that's a claim, not a payment, and it moves no balance until the person owed confirms it. Cash works the same way: the person owed marks the debt settled. It's their word, so it's theirs to give. The person paying can't mark their own debt paid, and nobody else in the group can either. The one exception is a friend who never joined. They have no account to confirm with, so the person paying them can record it. The app always shows these separately from Lightning payments that come with proof.

**Joining needs a yes.** The same link has a **Join** button for anyone who wants to add spends themselves. They pick their name from the list. A link can be forwarded, so picking a name only makes a request. Someone already in the group sees "Someone wants to join as Om · Code 7051" and lets them in or turns them down.

It runs on Android and the web, against a live server taking real Lightning payments. Open source (MIT). No token.

### Where trust still lives

The Freedom Stack track asks where trust-minimisation still falls short. In Sattle, it falls short here:

- **The server signs the ledger.** Groups, expenses and settlements live in our SQLite database, and each expense and confirmed settlement is mirrored to Nostr relays. If we disappear, any member with the backup key can rebuild the balances. But the server signs every entry, so the record proves what Sattle said, not what each member agreed to. Relays can't read entries, but they can see our pubkey, a per-group tag and when each entry was made. Next step: members sign their own entries with Nostr identities.
- **The server holds your NWC connection string.** It's never returned in any response and never logged, and with the recommended permissions it can only create invoices, not spend. But it is a secret we store.
- **The exchange rate comes from CoinGecko.** Quotes use its live rate, cached for 30 seconds. If it stops answering, Sattle falls back to the last rate it got, and then to a fixed one. A quote only lives 90 seconds, but in an outage the sats amount can be off.
- **Some Lightning addresses can't tell us they were paid.** When an address has no verify link, Sattle can only confirm the payment with the payer's proof of payment. Without that, the invoice closes as "we couldn't tell" rather than paid.
- **UPI and cash are claims, not proofs.** A UPI payment counts when the person owed confirms it (or the payer records it, when the person owed never joined). The app shows these differently from Lightning settlements for that reason.
- **The group link is a key to read the group.** Anyone it's forwarded to can see the spends and who owes what, and is shown a UPI ID when they choose to pay that person. It doesn't expire, so the group can replace it or turn it off. A UPI ID with a phone number in it gets a warning before it's shown, and each person can keep theirs off any group's link.
- **Letting someone in is a person vouching.** Since the link can be forwarded, a groupmate approves each request to join. A wrong yes is undone only by that person leaving.
- **Your account is a key on your device.** A name and a random token, with no email, phone or password. Lose the device and you lose the account; there's nothing to recover it with. Next step: Nostr identity (NIP-07 / NIP-46).

## Challenges I ran into

**A friend who can't be paid.** If only one person installs the app, everyone else is a "ghost": a name with no keys. Ghosts can pay, because a pay link is just a QR code. But a ghost who is owed money has nowhere to receive it. My first version threw an error when you tried to settle with them, and the UI caught it.

That's a dead end disguised as error handling. By the time the error fires, the user has already tapped "Settle up" for something that was never going to work.

So I moved the decision earlier. `resolveSettlementOptions()` is a pure function that runs before the settle sheet renders. It returns either the available ways to pay, or a blocked state that names the person and offers three fixes: add their Lightning address, invite them, or mark it settled. The fix I'd missed was the first one. Anyone with any wallet has a Lightning address, and paying one asks nothing of them. `setMemberPayoutAddress` stores the address and deliberately leaves them a ghost. Being *payable* and being *joined* are different facts, and treating them as one flag was the actual bug. (Only the address is one-sided: anyone in the group can give a ghost an address, but once someone has joined, only they can change where they get paid.)

One honest limit: with real payments on, paying a ghost's address isn't wired up yet. A groupmate typed that address, so a payment to it proves nothing about the ghost getting the money (see the next challenge). The payment ends as failed with "Nothing moved" rather than be marked paid without proof. Once the ghost joins, they set their own address and it works.

**A proof that proves the wrong thing.** Receiving with a Lightning address looked like a small feature. Then the review turned up a hole. A preimage proves an invoice was paid, not that the money reached the person owed. With NWC that's the same thing, because the invoice comes from the payee's own wallet. With an address, it's whoever typed it. Anyone could put their own address on a ghost, wait for the ghost to join, pay themselves, and hold a valid proof. So joining now clears an address a groupmate typed, and only the member can set a new one. Two more fixes came out of the same review. A payment hash can belong to only one settlement, so an address that hands out the same invoice twice can't clear two debts with one payment. And every request to an address goes through a fetch that rejects private IPs (checked after DNS, to stop rebinding), redirects, slow answers and oversized bodies, because the address is something a user typed.

**Paying at the right price.** A debt is in rupees and the payment is in sats, so the conversion happens at the worst possible moment: while someone is standing there with their phone out. Sattle pins a quote for 90 seconds and asks the payee's wallet for an invoice that expires no later than the quote. Otherwise a guest could pay an old invoice at a stale rate after a fresh one had been made. The rate service asks one source, caches it for 30 seconds, and shares a single request among everyone waiting, so a burst of pay links doesn't hammer it. When the source is down, quoting still works on the last good rate rather than blocking the payment.

**Knowing a payment really happened.** Lightning has no callback when your invoice gets paid. Sattle polls the payee's wallet over NWC (`lookup_invoice`) and picks up pending payments again after a server restart. The server can stream each status change over SSE, but a browser can't attach a sign-in token to an SSE connection, so the signed-in app polls for now; short-lived stream tickets are the next step. An invoice that looks expired gets a 30-second grace period before it's marked expired, because a payment can land right at the edge.

**Keeping the record without keeping the trust.** Publishing the ledger to Nostr sounds like one call, but public relays are the wrong place for a group's spending. So every entry is encrypted with NIP-44 under a random key per group, and only members can fetch it. It's signed by the server, so a relay can't forge or change an entry. And each entry names the one before it, so a reader notices a missing or reordered one. Publishing goes through an outbox table instead of being called from each route: a relay outage or a restart only delays an entry, never loses it, and groups that existed before the feature were backfilled. The backup key decrypts a group's whole history for good, so the verify script reads it from a prompt that doesn't echo, never from the command line, where npm would print it and the shell would keep it.

## Technologies used

Bitcoin Lightning, Nostr Wallet Connect (NIP-47), Nostr relays with NIP-44 encryption, Lightning Address, LNURL-pay, LUD-21 verify, BOLT11, UPI, TypeScript, React Native (Expo), Kotlin (Expo module), Node.js, Hono, SQLite, CoinGecko, Vitest

## Links

- Live app: https://sattle.axiosiiitl.dev
- Source: https://github.com/gandhiyaash/sattle
- Android APK: https://github.com/gandhiyaash/sattle/releases/latest
- Demo video: _YouTube link, once recorded (see [DEMO_SCRIPT.md](DEMO_SCRIPT.md))_

## Screenshots

Upload them in this order. The first one becomes the cover image.

1. Group screen with "Om owes you" and members marked **Not joined** (cover)
2. Guest pay page on a phone: amount, sats, exchange rate and source, QR code, countdown
3. Add expense with the live split preview showing where the leftover paisa goes
4. Wallet screen warning that an NWC connection grants more than Sattle needs
5. Settle sheet blocked on a ghost, with the three fixes
6. **Backup on Nostr** card, and the terminal output of `ledger:verify`
7. A UPI claim waiting for the person owed to confirm it
