# Demo video: Sattle

Target length: **3:00**. Each scene has what's on screen and what you say. Narration runs about 150 words a minute, so each line is written to fit its time slot.

The story judges should take away, in order:

1. Only one person needs the app.
2. Money moves on proof, from the payer's wallet into the payee's own wallet.
3. The record survives without us, and we're honest about where trust remains.

---

## Before you hit record

**Server**
- [ ] The deploy of the commit you're filming has finished (`ci` then `deploy` green on `main`). Each deploy backs up the database first.
- [ ] `/health` on the API answers `{"ok":true,"payments":"real"}`.
- [ ] `LEDGER_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` is in the VM's `.env`, then `sudo systemctl restart sattle`. The log line should say `ledger mirrored to 3 relay(s) as npub1…`.
- [ ] `PAYMENTS=nwc` is in the VM's `.env`. Without it, scene 4's payment is simulated, and you should say so on camera rather than imply it's real.

**Wallets**
- [ ] **Receiving wallet** (yours, connected over NWC): Alby Hub, coinos, or any wallet that makes NWC connections. Create a connection with **only** `make_invoice` and `lookup_invoice`. Keep a second connection that also has `pay_invoice` ready, to show the warning in scene 3.
- [ ] **Paying wallet** on your phone with about 5,000 sats: Phoenix, Wallet of Satoshi, Blink, or similar.

**Screens**
- [ ] Browser A (you, Yash): https://sattle.axiosiiitl.dev in a clean profile, so it's a fresh account.
- [ ] Phone (Om, the guest): nothing installed, just the camera or wallet app to scan the QR.
- [ ] If you show the Android app at all, it's v0.1.8 or later. v0.1.7 can't join a group or open Manage against the current server.
- [ ] A terminal with the repo, font size 18+, prompt cleared.
- [ ] Amounts kept small so the payment is cheap: **Chai ₹100** (shows the leftover paisa), **Dinner ₹900**.

**Do one full dry run first.** It creates the group you'll film, and it confirms a payment actually goes through end to end. Then start fresh in a new browser profile for the take.

---

## Scene 1: The problem (0:00–0:15)

**Screen:** title card "Sattle: split bills in sats. Only one of you needs the app." Then the empty Sattle welcome screen.

**Say:**
> Splitwise tells you that you owe Om seventeen hundred rupees, then sends you somewhere else to pay. Bitcoin can fix that, but every Bitcoin bill-splitter asks the whole group to install an app and fund a wallet. Nobody does that to pay back dinner. Sattle is built around the people who won't install it.

## Scene 2: One person, a whole group (0:15–0:45)

**Screen:**
1. Type the name "Yash" and tap **Get started**. Point out that there's no email, phone or password.
2. **New group**: "Goa trip", with members Om and Aman. They're only names.
3. **Add expense**: "Chai", ₹100, paid by Yash, split equally. Pause on the live preview: Yash ₹33.34, Om ₹33.33, Aman ₹33.33. The extra paisa goes to the first person in the split.
4. Add "Dinner", ₹900, paid by Yash, split equally. Save.
5. Group screen: members show **Not joined**, and "Om owes you" and "Aman owes you" appear.

**Say:**
> I'm the only one with the app. Om and Aman are just names; they never sign up. Expenses stay in rupees, because that's what dinner cost. A hundred rupees doesn't split three ways, so the leftover paisa goes to one person in a fixed order. Every share is whole, and they always add up to the total.

## Scene 3: My wallet stays mine (0:45–1:10)

**Screen:**
1. **Wallet** tab. Paste the connection that includes `pay_invoice` and show the warning that it grants more than Sattle needs.
2. Replace it with the narrow one (`make_invoice` + `lookup_invoice`) and show it connected cleanly.
3. Scroll to the trust disclosure for a second.

**Say:**
> I connect my own wallet with Nostr Wallet Connect. Sattle asks for two permissions: make an invoice that pays into my wallet, and check whether it was paid. It can't spend. If I hand it a connection that can, it tells me and asks for a narrower one. Sattle never holds the money.

## Scene 4: Om pays from any wallet (1:10–1:55)

**Screen:**
1. Tap **Invite** in the group's header and copy the group link.
2. Open it on the phone, in a plain browser with no app. Hold a second on the group page: the spends, who owes what, and the **Join** card. On "Om owes Yash", tap **Pay with Lightning**. The pay page shows "Om, you owe Yash ₹333.33", the sats amount, and the breakdown under it. Hold on the breakdown for a beat: **Exchange rate** "1 BTC = ₹…", **Rate from** "CoinGecko, live", and the network fee. Then the QR code and "Rate and invoice locked for 1:29". If **Rate from** says "Demo rate", `PAYMENTS` isn't `nwc`; **Rate from** can also name Blockchain.com or Coinbase, if CoinGecko didn't answer.
3. Scan the QR code with the paying wallet and pay.
4. Cut back to browser A: Om's row clears and the balance changes. If it takes a couple of seconds, keep that in the take. It shows the app is waiting for proof.

**Say:**
> To collect, I post one link in the group chat. Om opens it in any browser, sees what he owes, and gets a Lightning invoice made by my wallet, at a rate pinned for ninety seconds, so nobody pays yesterday's price. He pays with whatever wallet he already has. Sattle checks with my wallet, and only when it says the invoice is paid, with a proof that matches, does the debt clear. Nothing is marked paid on hope.

## Scene 5: Cash still counts (1:55–2:10)

**Screen:** on "Aman owes you", tap **Mark as settled**, then **Yes, Aman paid me**. The row clears.

**Say:**
> Aman paid me in UPI. Only the person who's owed can mark that, because it's their word, and the app keeps it separate from Lightning payments that come with proof.

## Scene 6: The record outlives us (2:10–2:45)

**Screen:**
1. The **Backed up on Nostr** card under the balance: "All 4 entries on relay.damus.io, nos.lol, relay.primal.net." (two expenses, two settlements) Tap **Copy backup key**.
2. Terminal. Run the command below, and paste the key when it asks. The prompt doesn't echo, so the key never appears on screen:
   ```bash
   npm run ledger:verify -w @sattle/api
   ```
3. The output: "Chain intact. Every entry signed by the server." It reports 4 entries: 2 expenses and 2 settlements. Every balance is ₹0, matching the app, and "To settle up" reads "Nothing. Everyone is square."
4. Optional, 3 seconds: back in the app, tap **See it on a relay**. njump.me shows the newest entry, kind 4733, and only ciphertext.

**Say:**
> Our server keeps the ledger, so what happens if we disappear? Every expense and payment is also published to Nostr relays: signed, encrypted with a key only the group holds, and chained, so a missing entry shows. With the group's backup key, anyone in the group can rebuild every balance from the relays alone, with no Sattle server involved.

## Scene 7: Where trust still lives (2:45–3:00)

**Screen:** a text card with three short lines, or the in-app trust screen:
- The server signs the ledger and stores your wallet connection string.
- Exchange rate from CoinGecko, with Blockchain.com and Coinbase as backups.
- Accounts are a key on your device. Save it to sign in elsewhere; lose it and the account is gone.

Close on the logo, the repo URL, "Open source. No token."

**Say:**
> Here's what still needs trust. Our server signs the ledger, it stores your wallet connection, and the exchange rate comes from one source. Next, members sign their own entries with Nostr identities. Sattle: only one of you needs the app.

---

## If something breaks while filming

| Problem | Fallback |
|---|---|
| The payment doesn't confirm, or `PAYMENTS` isn't `nwc` | Film the pay page and the QR code, then cut. Say "here it's on the simulated backend" and show the status walking to `confirmed`. Don't imply it's real. |
| The relays are slow, so the card says "3 of 4 entries" | Wait 10 seconds and tap back into the group. The server publishes every 3 seconds. |
| `ledger:verify` finds nothing | Add `--relay wss://relay.damus.io`. Check that `LEDGER_RELAYS` is set on the VM. Entries made before it was set go out once it is, so wait a few seconds and rerun. |
| Running long | Cut scene 5 first (−15s), then the warning in scene 3 (−10s). Keep scenes 4 and 6: they're the payoff. |

## Recording tips

- Record the browser at 1280×800, and the phone as a screen recording, not a filmed screen.
- Record narration separately and lay it over the cuts. It's far easier than talking while clicking.
- Leave a second of silence between scenes so cuts land cleanly.
- Captions help: judges often watch muted.
