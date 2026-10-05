# Devfolio submission: Sattle

Copy each section into the matching Devfolio field. Track: **Freedom Stack** (Boss Fight 2: Nostr).

---

## Name

Sattle

## Tagline

Split bills in sats. Only one of you needs the app.

## The problem it solves

Splitwise tells you that you owe Om ₹1,700 and then sends you somewhere else to pay. It can't move money itself, because moving money makes it a regulated money transmitter in every country it operates in.

Lightning removes that limit, and Bitcoin bill-splitters exist. But they all assume everyone in the group installs the app, makes a wallet, and funds it. No one does that to pay back a friend for dinner.

Sattle is built around the people who won't install it, and on Nostr so that no one has to trust us with their money or their record:

- **Your wallet stays yours.** Sattle connects to your wallet over Nostr Wallet Connect (NIP-47) with permission to create invoices and check them, never to spend. Every payment lands straight in the wallet of the person owed.
- **The record outlives us.** Every expense and confirmed payment is published to Nostr relays, encrypted with NIP-44 and chained. With the group's backup key, anyone can rebuild the balances from the relays without our server.
- **The ledger moves on proof.** A debt clears only when the payee's wallet says the invoice was paid, and the preimage matches the payment hash.

_Fill in after the real test: "We used it to settle [what] between [how many] of us. [Name] paid from [wallet] without installing anything."_

### Only one person needs the app

Everyone else is a name in the group. To collect, you post one link in the group chat. It opens in any browser and shows what was spent and who owes what. Each person taps their debt and pays the Lightning invoice from whatever wallet they already use. To chase one person, you send them a pay link for just their debt. No signup, no keys, no install.

### Built on Nostr

**Wallets over Nostr Wallet Connect.** Sattle talks to your wallet over NIP-47 through relays, with a client we wrote on `nostr-tools`. It reads the wallet's info event (kind 13194) and uses NIP-44 encryption when the wallet offers it, NIP-04 otherwise. It asks for two permissions, `make_invoice` and `lookup_invoice`: it can create invoices that pay *into* your wallet and check whether they were paid. It cannot spend. If your connection string grants more, the app tells you and recommends a narrower one.

**A ledger on relays.** Each expense and confirmed settlement becomes a Nostr event (kind 4733), encrypted with NIP-44 under a random key per group, so relays store it without being able to read it. Each event is signed, so a relay can't forge or change one, and names the one before it, so a reader notices a missing or reordered entry. Publishing goes through an outbox table: a relay outage or a restart only delays an entry, never loses it. The group screen copies the backup key, and with it `npm run ledger:verify` rebuilds every balance from the relays, with no Sattle server involved.

**Lightning addresses for everyone else.** Most wallets people already have (Wallet of Satoshi, Phoenix, Blink) can't do NWC. For those, you give Sattle your Lightning address. It fetches the invoice over LNURL-pay, checks the exact amount and network before showing it, and confirms the payment through the address's verify link (LUD-21) or the payer's proof of payment. Either way, the proof has to match the invoice's payment hash.

### Rupees in the ledger, sats in the payment

A group keeps its expenses in its own currency, rupees by default, because that's what the dinner cost. Splits are whole paise: when a split doesn't divide evenly, the leftover paise go out one at a time in a fixed order, so the shares always add up to the total. Sats come in only at the moment of paying. Sattle pins a quote at the live rate for 90 seconds and makes an invoice that expires with it, so nobody pays yesterday's price.

### UPI and cash still count, as claims

Not everyone settles in sats. In a rupee group, someone who adds a UPI ID can be paid by UPI. On Android the app opens a UPI app and hears back. On an iPhone or the web the payer gets the UPI ID or a QR code, then taps **I've paid**. Sattle can't see a bank transfer, so that's a claim, not a payment, and it moves no balance until the person owed confirms it. Cash works the same way: the person owed marks the debt settled. The person paying can't mark their own debt paid, and nobody else in the group can either. The one exception is a friend who never joined: they have no account to confirm with, so the person paying them can record it. The app always shows claims separately from Lightning payments that come with proof.

### Joining needs a yes

The same link has a **Join** button for anyone who wants to add spends themselves. They pick their name from the list. A link can be forwarded, so picking a name only makes a request. Someone already in the group sees "Someone wants to join as Om · Code 7051" and lets them in or turns them down.

It runs on Android and the web, against a live server taking real Lightning payments. Open source (MIT). No token.

### Where trust still lives

The Freedom Stack track asks where trust-minimisation still falls short. In Sattle, it falls short here:

- **The server signs the ledger.** Groups, expenses and settlements live in our SQLite database, and each expense and confirmed settlement is mirrored to Nostr relays. If we disappear, any member with the backup key can rebuild the balances. But the server signs every entry, so the record proves what Sattle said, not what each member agreed to. Relays can't read entries, but they can see our pubkey, a per-group tag and when each entry was made.
- **Your account is a key on your device.** A name and a random token, with no email, phone or password. Lose the device and you lose the account; there's nothing to recover it with.
- **The server holds your NWC connection string.** It's never returned in any response and never logged, and with the recommended permissions it can only create invoices, not spend. But it is a secret we store.
- **The exchange rate comes from a price API.** Quotes use CoinGecko's live rate, cached for 30 seconds, and ask Blockchain.com and then Coinbase when it's down. If all three are down, Sattle uses the last rate it got. If none has ever answered, the payment fails rather than use a made-up price. A quote only lives 90 seconds, but in a long outage the sats amount can be off.
- **Some Lightning addresses can't tell us they were paid.** When an address has no verify link, Sattle can only confirm the payment with the payer's proof of payment. Without that, the invoice closes as "we couldn't tell" rather than paid.
- **UPI and cash are claims, not proofs.** A UPI payment counts when the person owed confirms it (or the payer records it, when the person owed never joined). The app shows these differently from Lightning settlements for that reason.
- **The group link is a key to read the group.** Anyone it's forwarded to can see the spends and who owes what, and is shown a UPI ID when they choose to pay that person. It doesn't expire, so the group can replace it or turn it off. A UPI ID with a phone number in it gets a warning before it's shown, and each person can keep theirs off any group's link.
- **Letting someone in is a person vouching.** Since the link can be forwarded, a groupmate approves each request to join. A wrong yes is undone only by that person leaving.

### What's next

Each step moves trust from our server to keys the members hold:

1. **Sign in with Nostr** (NIP-07 on the web, NIP-46 or Amber on Android). Your account becomes your key, so a lost phone no longer means a lost account.
2. **Lightning addresses from Nostr profiles.** A member who signs in gets paid at the `lud16` in their own signed profile, with nothing to type.
3. **Members sign their own entries.** The record then proves what each member agreed to, and the server becomes just an indexer.
4. **Pay requests as NIP-17 direct messages,** so chasing a debt doesn't need WhatsApp.
5. **Smaller fixes:** encrypt the NWC connection string at rest, and take the exchange rate as the median of our three sources rather than the first that answers.

## Challenges I ran into

**Keeping the record without keeping the trust.** Publishing the ledger to Nostr sounds like one call, but public relays are the wrong place for a group's spending. So every entry is encrypted with NIP-44 under a random key per group, and only members can fetch it. It's signed by the server, so a relay can't forge or change an entry. And each entry names the one before it, so a reader notices a missing or reordered one. Publishing goes through an outbox table instead of being called from each route: a relay outage or a restart only delays an entry, never loses it, and groups that existed before the feature were backfilled. The backup key decrypts a group's whole history for good, so the verify script reads it from a prompt that doesn't echo, never from the command line, where npm would print it and the shell would keep it.

**A friend who can't be paid.** If only one person installs the app, everyone else is a "ghost": a name with no keys. Ghosts can pay, because a pay link is just a QR code. But a ghost who is owed money has nowhere to receive it. My first version threw an error when you tried to settle with them, and the UI caught it.

That's a dead end disguised as error handling. By the time the error fires, the user has already tapped "Settle up" for something that was never going to work.

So I moved the decision earlier. `resolveSettlementOptions()` is a pure function that runs before the settle sheet renders. It returns either the available ways to pay, or a blocked state that names the person and offers three fixes: add their Lightning address, invite them, or mark it settled. The fix I'd missed was the first one. Anyone with any wallet has a Lightning address, and paying one asks nothing of them. `setMemberPayoutAddress` stores the address and deliberately leaves them a ghost. Being *payable* and being *joined* are different facts, and treating them as one flag was the actual bug. (Only the address is one-sided: anyone in the group can give a ghost an address, but once someone has joined, only they can change where they get paid.)

One honest limit: with real payments on, paying a ghost's address isn't wired up yet. A groupmate typed that address, so a payment to it proves nothing about the ghost getting the money (see the next challenge). The payment ends as failed with "Nothing moved" rather than be marked paid without proof. Once the ghost joins, they set their own address and it works.

**A proof that proves the wrong thing.** Receiving with a Lightning address looked like a small feature. Then the review turned up a hole. A preimage proves an invoice was paid, not that the money reached the person owed. With NWC that's the same thing, because the invoice comes from the payee's own wallet. With an address, it's whoever typed it. Anyone could put their own address on a ghost, wait for the ghost to join, pay themselves, and hold a valid proof. So joining now clears an address a groupmate typed, and only the member can set a new one. Two more fixes came out of the same review. A payment hash can belong to only one settlement, so an address that hands out the same invoice twice can't clear two debts with one payment. And every request to an address goes through a fetch that rejects private IPs (checked after DNS, to stop rebinding), redirects, slow answers and oversized bodies, because the address is something a user typed.

**Paying at the right price.** A debt is in rupees and the payment is in sats, so the conversion happens at the worst possible moment: while someone is standing there with their phone out. Sattle pins a quote for 90 seconds and asks the payee's wallet for an invoice that expires no later than the quote. Otherwise a guest could pay an old invoice at a stale rate after a fresh one had been made. The rate service caches the rate for 30 seconds and shares a single request among everyone waiting, so a burst of pay links doesn't hammer the source. When CoinGecko is down it asks Blockchain.com, then Coinbase, and when all three are down, quoting still works on the last good rate rather than blocking the payment.

**Knowing a payment really happened.** Lightning has no callback when your invoice gets paid. Sattle polls the payee's wallet over NWC (`lookup_invoice`) and picks up pending payments again after a server restart. An invoice that looks expired gets a 30-second grace period before it's marked expired, because a payment can land right at the edge.

## Technologies used

Nostr (nostr-tools), Nostr Wallet Connect (NIP-47), NIP-44 and NIP-04 encryption, Nostr relays, Bitcoin Lightning, BOLT11, Lightning Address, LNURL-pay, LUD-21 verify, UPI, TypeScript, React Native (Expo), Kotlin (Expo module), Node.js, Hono, SQLite, CoinGecko, Blockchain.com and Coinbase price APIs, Vitest

## Links

- Live app: https://sattle.axiosiiitl.dev
- Source: https://github.com/gandhiyaash/sattle
- Android APK: https://github.com/gandhiyaash/sattle/releases/latest
- Demo video: _YouTube link, once recorded (see [DEMO_SCRIPT.md](DEMO_SCRIPT.md))_

## Screenshots

Upload them in this order. The first one becomes the cover image.

1. Group screen with "Om owes you" and members marked **Not joined** (cover)
2. Guest pay page on a phone: amount, sats, exchange rate and source, QR code, countdown
3. **Backup on Nostr** card, and the terminal output of `ledger:verify`
4. Wallet screen warning that an NWC connection grants more than Sattle needs
5. Add expense with the live split preview showing where the leftover paisa goes
6. Settle sheet blocked on a ghost, with the three fixes
7. A UPI claim waiting for the person owed to confirm it
