# The App Store

What the App Store listing says, what App Store Connect is told, and how the first version gets there. Building and uploading is in the README, under [Releasing the iOS app](../README.md#releasing-the-ios-app).

Like the FAQ, this says what the app does today. The privacy answers below, the [privacy policy](../apps/mobile/public/privacy.html) and the code have to agree: App Review compares them, and so does anyone who reads them. A change to what the app collects changes all three.

## Before the first upload

1. **The team.** `ios.appleTeamId` in `app.json` is `4G96L8W59F`, and that team needs a paid Apple Developer Program membership. As an individual, the App Store names you as the seller. An organization shows the organization instead, and App Review is less likely to stop and ask whether a developer may offer payments (guideline 5.1.1(ix)). Sattle holds no money, so it isn't a regulated financial service, but it is the question a reviewer may ask.
2. **Sign in to Xcode** with that account (Xcode, Settings, Accounts). `just ios-release` signs through it.
3. **Register the bundle ID**, which App Store Connect needs before it can make the app: Certificates, Identifiers & Profiles, Identifiers, +, App IDs, explicit `tech.sattle.app`, with **Associated Domains** ticked. `just ios-install` with an iPhone attached does the same as it signs.
4. **Make the app in App Store Connect** (Apps, +, New App): platform iOS, name **Sattle**, primary language English, bundle ID `tech.sattle.app`, SKU `sattle`.
5. **Deploy the web app** from a commit that has `public/support.html`, the updated `privacy.html` and `.well-known/apple-app-site-association`. Then add the nginx line from the README's [group link](../README.md#the-group-link) section on the VM, and check:

   ```sh
   curl -sI https://sattle.tech/.well-known/apple-app-site-association | grep -i content-type   # application/json
   curl -s https://sattle.tech/support | grep -o '<title>[^<]*'                                 # Sattle Support
   ```
6. **Upload a build:** `EXPO_PUBLIC_API_URL=https://api.sattle.tech EXPO_PUBLIC_APP_URL=https://sattle.tech just ios-release`. After Apple processes it (minutes to an hour), it is in TestFlight. Install it on a phone from there and go through the app once before sending it for review. Tap a `https://sattle.tech/g/…` link in Notes or Messages: it should open the app, not Safari.

## App information

| Field | Value |
| --- | --- |
| Name | Sattle |
| Subtitle | Split expenses, settle up |
| Category | Finance |
| Privacy policy URL | https://sattle.tech/privacy |
| Support URL | https://sattle.tech/support |
| Marketing URL | https://sattle.tech |
| Copyright | 2026 Yash Gandhi and Om Swami |
| Price | Free, no in-app purchases |
| Devices | iPhone only (`supportsTablet: false`). iPads can still run it, in iPhone mode. Once a version ships for iPad, later versions can't drop it |
| Minimum iOS | 16.4, set by Expo SDK 57. App Store Connect reads it from the build |

**Age rating: 18+.** Answer the questionnaire as it is: every content question None, and of the capabilities only user-generated content Yes (group names, people's names and expense descriptions are seen by the group and by anyone holding its link). Then override the result to 18+. Why 18 and not lower:

- **The strictest place Sattle is offered sets the age.** India's Digital Personal Data Protection Act 2023 counts everyone under 18 as a child and requires verifiable parental consent before their data is processed, which Sattle has no way to get. The EU is lower: the GDPR lets a 13- to 16-year-old consent depending on the country (Article 8), and the Digital Services Act asks apps open to minors for extra protections. 18 satisfies both; 16 would break India's rule.
- **It moves real money and checks no ages.** The rating is what keeps it off a child's iPhone, through Screen Time and Family Sharing.
- **The privacy policy already says 18**, so the listing and the policy agree.

The cost is that teenagers can't find it, and they aren't meant to use it.

**EU trader status.** To be on EU storefronts, App Store Connect asks whether you are a trader under the Digital Services Act. A trader's address, phone number and email are shown on the EU listing. Not offering Sattle in the EU avoids the question.

## The listing

**Promotional text** (can change without a new version):

> Split bills with friends and settle up over Bitcoin Lightning or UPI. Only you need the app: everyone else sees what they owe and pays from the group link.

**Description:**

> Sattle splits shared expenses with friends and settles them, over the Bitcoin Lightning Network or UPI.
>
> Only you need the app. Share your group's link, and everyone else sees what they owe and pays from their phone's browser. No install, no sign-up.
>
> • Split an expense equally, by shares, or by exact amounts, and see each person's share before you save it.
> • Keep a group in rupees or in bitcoin.
> • Simplify debts, so fewer payments settle everyone.
> • Get paid over Lightning, straight to your own wallet or Lightning address.
> • Get paid over UPI, to your UPI ID.
> • Mark a debt settled when someone paid in cash.
> • See every expense and payment in the group's history.
> • A group's record is also backed up, encrypted, on Nostr relays, so it can be rebuilt without Sattle's server.
>
> Sattle never holds your money. A Lightning payment goes from one person's wallet to the other's, and a UPI payment from one bank account to the other's.
>
> No email or phone number: an account is just a name. Sign in on another phone with your sign-in key, or with a Nostr key.
>
> Sattle is open source: github.com/gandhiyaash/sattle

**Keywords** (100 characters at most, no spaces after commas, no other apps' names):

```
split,bill,expense,group,trip,roommate,flatmate,settle,lightning,bitcoin,upi,sats,friends,owe
```

**Screenshots.** App Store Connect requires 6.9-inch iPhone screenshots (1320 × 2868), 3 to 10 of them, and scales them for smaller iPhones. The iPhone 17 Pro Max simulator gives that size. A group with a few expenses, the add-expense preview, the settle-up sheet with Lightning and UPI, the group link page, and the history tell the story. Nothing in a screenshot may show another platform.

## App Privacy

Answers for App Store Connect's App Privacy section, from what the app and server keep (privacy policy section 1). Nothing is used for tracking, and nothing is shared with data brokers or for advertising. Everything below is **linked to the user**: the account holds it, or for usage data, the account that was signed in.

| Data type | What it is in Sattle | Purposes |
| --- | --- | --- |
| Contact Info: Name | Your display name, and the names you type for others in a group | App Functionality |
| Financial Info: Payment Info | Your UPI ID, Lightning address and wallet connection | App Functionality |
| Financial Info: Other Financial Info | Expenses, balances, payments and their invoices and proofs | App Functionality |
| User Content: Other User Content | Group names and expense descriptions | App Functionality |
| Identifiers: User ID | The account and its sign-in key, and a linked Nostr public key | App Functionality |
| Identifiers: Device ID | The random installation ID the app makes (`analytics/deviceStore`) | Analytics |
| Usage Data: Product Interaction | Screens shown, buttons pressed, the app opening and going to the background | Analytics |
| Diagnostics: Other Diagnostic Data | Error messages shown on screen | Analytics |

Not collected: email, phone number, physical address, contacts, location, photos, health, browsing or search history, sensitive info, crash logs, the advertising identifier.

The update check (`src/updates/appStore.ts`) asks Apple's public lookup for the newest version, naming the bundle ID and the phone's region. Paying by UPI asks the same lookup for the UPI apps' icons (`src/upi/launchUpi.ios.ts`), naming every app on the list whichever are installed, so it says nothing about the phone. Both go to Apple and nothing of them reaches Sattle, so they aren't collected data, but the privacy policy names them under section 4.

Checking which UPI apps are installed (`canOpenURL`, for the schemes under `LSApplicationQueriesSchemes` in `app.json`) happens on the phone and isn't sent anywhere.

A UPI ID is often a phone number. It is declared as Payment Info, since that is what it is used for; Sattle never asks for a phone number.

The server's request log (`REQUEST_LOG`, off unless turned on) records how long each request took. While it is on in production, add Diagnostics: Performance Data, for Analytics.

## Export compliance

`app.json` sets `ios.config.usesNonExemptEncryption: false`, which puts `ITSAppUsesNonExemptEncryption = NO` in Info.plist, so App Store Connect doesn't ask with each build. The reasoning, since it is a legal statement made by whoever uploads:

- Connections to the server are HTTPS, through iOS itself.
- A Nostr key proves who someone is by signing: authentication and digital signature.
- Restoring a group from its backup key only decrypts.
- A remote signer (bunker) is sent its signing requests encrypted (NIP-44, a published standard), and the requests exist only to get a signature.

Category 5 Part 2 of the US Export Administration Regulations leaves out cryptography that only authenticates, signs or decrypts, and the code is open source besides. Revisit this if the app ever encrypts something for confidentiality of its own, such as messages between members, or an in-app wallet.

## App Review information

**Sign-in required:** No. The app makes an account from a name alone, so there are no credentials to give.

**Contact:** your name, phone number and email.

**Notes:**

> Sattle splits shared expenses within a group and helps people settle what they owe. It has no in-app purchases and never holds or moves money itself.
>
> To try it: enter any name to make an account, create a group, add a couple of people by name, and add an expense. The group shows who owes whom. Open a debt to see the ways to settle it. "Mark as settled" works with no setup.
>
> Payments: a Lightning payment is made in the payer's own Bitcoin wallet app, to an invoice that comes from the payee's own wallet; Sattle shows the invoice and opens the wallet. A UPI payment (India) is made in the payer's UPI app. Sattle has no wallet of its own: the Wallet screen is where someone says how they want to be paid, by connecting their own wallet with Nostr Wallet Connect or adding a Lightning address or UPI ID.
>
> Share links (sattle.tech/g/…) open a page in the browser for people without the app, and open the app for people who have it.
>
> Account deletion: Account, Delete account.

## Things that would get a version turned down

- **Naming another platform.** The FAQ and the Wallet screen word the UPI answers for an iPhone on iOS (`IPHONE` in `FaqScreen.tsx`, `TrustModel` in `WalletScreen.tsx`), because the App Store refuses an app that mentions Android (guideline 2.3.10). New copy that differs by platform needs the same.
- **A privacy policy behind the app.** New reporting, a new third party, or a new kind of data changes the policy, the table above, and App Store Connect's answers, in the same release.
- **A wallet in the app.** Guideline 3.1.5 lets an app hold cryptocurrency only when its developer is enrolled as an organization. The planned `BreezWallet` would need that before it ships on iOS.
- **Purpose strings for what isn't used.** `expo-secure-store` is told not to add a Face ID string (`faceIDPermission: false`), since the app doesn't use Face ID. A new native module may add others; check the built Info.plist.
