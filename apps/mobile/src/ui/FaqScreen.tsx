/**
 * The FAQ, behind the button at the top of Wallet: how getting paid and
 * paying work, how a payment comes to count as paid, and what the links and
 * the account can do. Wallet's "What you're trusting" says what is trusted
 * and stops; the how and the why are here, so that block can stay short.
 *
 * The rule is the same for both: every answer states what the code does
 * today, and changes with it. The map above TrustModel in WalletScreen.tsx
 * names the code behind each claim. Two answers rest on the world outside
 * the code and say when they were last checked: which wallets' connections
 * Sattle has been used with, and which Lightning address providers give a
 * verify link (LUD-21), found by asking each of them for an invoice.
 *
 * `ways` is what Wallet shows: the ways to pay they use, and anything they
 * have set up. Someone who never chose bitcoin isn't given the Lightning
 * questions, nor someone who never chose rupees the UPI ones, and the
 * questions that remain are worded for what they do use.
 *
 * Questions are closed until tapped, so the screen reads as a list of
 * questions rather than a wall of text.
 */

import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { PayWays } from '@sattle/core';
import { Card, Divider, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type } from './theme';

export interface FaqScreenProps {
  onBack: () => void;
  /** Which ways to pay the reader is shown: what they use, and what they have set up. */
  ways: PayWays;
}

interface Faq {
  question: string;
  /** Paragraphs. */
  answer: string[];
}

/** When the lists of wallets below were last checked against the wallets themselves. */
const WALLETS_CHECKED = 'October 2026';

const LIGHTNING_FAQS: Faq[] = [
  {
    question: 'How do I get paid over Lightning?',
    answer: [
      'Connect a wallet with Nostr Wallet Connect, or add your Lightning address, on the Wallet screen. When someone pays you, Sattle’s server asks that wallet or address for an invoice for the amount and shows it to them. They pay it from any Lightning wallet, and the sats land in yours. Nothing passes through Sattle.',
      'If you set up both, the connected wallet is used first.',
    ],
  },
  {
    question: 'Which wallets confirm a payment by themselves?',
    answer: [
      'Two kinds do. A wallet connected with Nostr Wallet Connect tells Sattle when the invoice is paid, because Sattle asks it. Alby Hub and Coinos have been used with Sattle this way. Primal, Zeus, LNbits, Minibits and Cashu.me make these connections too. Any wallet whose connection can create and check invoices works.',
      `A Lightning address confirms by itself when its provider gives a link Sattle can ask whether the invoice was paid (LUD-21). Checked ${WALLETS_CHECKED}: Alby, Blink, Cake Wallet, Coinos, Minibits, Speed, Stacker News and Zeus Pay give one. Wallet of Satoshi, Primal and Bitrefill don’t.`,
      'With an address that can’t, a payment is confirmed only by the payer’s payment proof, or when you mark it as settled. Nothing arrives on its own, however long you wait.',
    ],
  },
  {
    question: 'I paid, but Sattle still says it’s waiting. Why?',
    answer: [
      'The person you paid receives at a Lightning address whose provider can’t tell Sattle it was paid. Wallet of Satoshi is the usual one. Your sats reached them all the same, so don’t pay again, and don’t take the new invoice the sheet offers after 90 seconds.',
      'Ask them to open the debt and tap Mark as settled. If you paid from a pay link in a browser, that page also takes your payment proof: Already paid? Send your payment proof.',
    ],
  },
  {
    question: 'What is a payment proof?',
    answer: [
      'When a Lightning wallet pays an invoice, it gets back the secret the invoice was locked with, called the preimage: 64 letters and digits. It matches that invoice and no other, and nobody can make one up, so whoever holds it paid.',
      'Most wallets show it in the payment’s details. In Blink, open All transactions, then the payment. Sattle takes a proof on a pay link’s page, checks it against the invoice, and keeps it with the payment.',
    ],
  },
  {
    question: 'Why does the invoice stop after 90 seconds?',
    answer: [
      'A debt in rupees is paid in sats, so the server converts it at the bitcoin price of the moment and locks that rate for 90 seconds. The invoice is for that many sats. After that the price may have moved, so the sheet offers a new invoice at the new rate rather than let the old one be paid at a stale one. A group kept in bitcoin is owed in sats already, so there is nothing to convert; its invoice is good for the same 90 seconds.',
      'An invoice from a Lightning address may live longer than that at the provider. When the provider can report payments, one that lands after the countdown still counts, and Sattle watches for it for up to a day.',
    ],
  },
  {
    question: 'What does the wallet connection let Sattle do?',
    answer: [
      'The connection string you paste is a key to your wallet. Sattle’s server uses it for three things: to read what the connection allows, to create an invoice when someone pays you, and to check whether that invoice was paid. It has no code that spends.',
      'If the string also allows spending, the Wallet screen warns you, because the server keeps the string and anyone who took it from there could spend with it. Make a connection in your wallet that allows only creating and checking invoices. Disconnect makes the server forget the string; delete the connection in your wallet as well to be sure.',
      'Requests travel through the Nostr relay named in the string, encrypted. The relay sees that a request was sent, not what it says.',
    ],
  },
  {
    question: 'Where does the exchange rate come from?',
    answer: [
      'From CoinGecko. If it doesn’t answer, from Blockchain.com, then Coinbase. If none of them answers, the last rate any of them gave is used. If there has never been one, the payment doesn’t go through, unless the server has been given a fixed rate to fall back on.',
      'The rate is locked for 90 seconds when the invoice is made, and the sheet shows the sats before you pay.',
    ],
  },
  {
    question: 'Can I pay someone who hasn’t joined?',
    answer: [
      'Not through Sattle. Someone in the group may have typed a Lightning address for them, but a payment to it would prove nothing about who got the money, so Sattle doesn’t make invoices for it. Send them the group’s link to join; once they’re in and have set up a way to get paid, you can pay them here.',
      'If you paid them another way, you can mark the debt settled yourself, since they aren’t here to.',
    ],
  },
];

const UPI_FAQS: Faq[] = [
  {
    question: 'How does paying by UPI work?',
    answer: [
      'The person you owe adds their UPI ID on the Wallet screen. In a group kept in rupees, Pay by UPI then shows the UPI apps on your phone. Pick one and it opens with their ID, the amount and a note filled in, and you pay there, from your bank account to theirs. Google Pay and PhonePe don’t take a link from another app, so for those the UPI ID is copied instead, the app opens, and you paste it in and type the amount. In a browser, the same is shown as a QR code to scan from your phone.',
      'Sattle isn’t in the payment. No bank or UPI app tells anyone else that one person paid another, so the server never sees the money move.',
    ],
  },
  {
    question: 'How does Sattle know a UPI payment went through?',
    answer: [
      'It doesn’t see it. It is told, and who tells it depends on your device.',
      'On Android, an app that takes the link is opened in a way that lets it answer when it closes. It hands back one line: a status, its transaction ID, the bank’s approval reference, and the reference the link carried. Only a status of SUCCESS settles the debt, there and then, with those ids kept on the payment and shown in the group’s history. Pending, failed, or no answer at all, which some apps give, settles nothing: you can try again, or tap I’ve paid and say whether it went through. Google Pay and PhonePe are opened plain, with nothing to answer, so when you come back the sheet asks whether it went through, and your yes settles it without a reference.',
      'On an iPhone or in a browser, a UPI app says nothing back. When you return, the sheet asks Did the payment go through? Yes settles the debt on your word, with the reference your UPI app showed if you type it in. No records nothing.',
      'From a group’s shared page, without the app, I’ve paid is a claim: the person owed sees it and confirms or declines it. That page has no login, so it can’t settle a debt by itself.',
      'None of this is proof. On Android it is your UPI app’s word, passed on by your phone; otherwise your own. The ids and the reference are what let anyone check the payment against a bank statement afterwards.',
    ],
  },
  {
    question: 'Who sees my UPI ID?',
    answer: [
      'People in your groups who owe you right now, when they choose to pay you. Also anyone holding one of your groups’ shared links, when they choose to pay you from it, unless you turn that off: on the Wallet screen for all your groups, or under a group’s Manage for that one. It isn’t in the member list.',
      'Many UPI IDs are a mobile number, and whoever sees the ID sees the number. Most UPI apps let you add an ID without one, like name@okhdfcbank, and Wallet warns when the one you type has a number in it.',
    ],
  },
  {
    question: 'Why do Google Pay and PhonePe need the UPI ID pasted in?',
    answer: [
      'They refuse a payment that another app starts with a link to a personal UPI ID. NPCI, which runs UPI, told every payment app to refuse these from 1 April 2024 (circular OC/76A), to stop fraud through links sent around. The apps say something about a limit when they refuse, but it isn’t your limit: the same payment goes through when you type the ID in yourself.',
      'So Sattle doesn’t send them the link. It copies the UPI ID and opens the app, and you paste the ID into its search, pick the person, type the amount and pay. When you come back, Sattle asks whether it went through, and your yes settles it. Paytm and most other apps still take the link, open with everything filled in, and tell Sattle how it went.',
      'A QR code is treated differently: scanning one with the app’s camera is allowed, with no cap, which is why a browser shows one. A QR code opened from your photos is capped at ₹2,000 by the same rule.',
      'If another app refuses the link, pay the ID shown on the screen by hand from it, then tap I’ve paid.',
    ],
  },
];

function groupFaqs({ lightning, upi }: PayWays): Faq[] {
  const pay = lightning && upi ? 'over Lightning or by UPI' : upi ? 'by UPI' : 'over Lightning';
  return [
    {
      question: 'What can someone with the group’s link do?',
      answer: [
        `A group has no link until someone in it makes one, under Manage. Whoever opens it sees every expense, each person’s share, everyone’s name and who owes whom, and can pay a debt ${pay}. They can’t add or change anything${
          upi ? ', and a UPI payment they say they made counts only once the person owed confirms it' : ''
        }. They can ask to join.`,
        'Anyone in the group can replace the link or turn it off. It can’t be guessed, but it can be forwarded.',
        'A pay link, sent for one debt, shows less: who owes whom, the group’s name, the amount and whether it’s paid.',
      ],
    },
    {
      question: 'How does joining a group work?',
      answer: [
        'From the group’s link, tap Join and give your name. That is a request, not a place in the group: someone already in it has to let you in, and you both see the same four-digit code to check it’s really you. Until then you can do no more than anyone else holding the link.',
        'Once in, you see and can add to everything, like everyone else.',
      ],
    },
    {
      question: 'Who can mark a debt settled by hand?',
      answer: [
        'The person who is owed. It is their money, so it is their word to give: on a debt owed to you, Mark as settled records it, with no proof asked. The person paying can do it only when the one they owe hasn’t joined Sattle, since there is nobody else to.',
        'Either way it shows in the group’s history as settled outside the app.',
      ],
    },
    {
      question: 'What if I lose this phone?',
      answer: [
        'Your account is a name and a sign-in key that this device holds. There is no email, phone number or password to recover it with, so keep a copy of the key: on the Account screen, Copy sign-in key gives it to you, to keep in a password manager. On a new phone or browser, I have a sign-in key on the welcome screen gets you back in, with all your groups. You can link a Nostr key there too, and sign in with that instead.',
        'If you lose a phone that was signed in, replace the key from another device that is: the lost phone is signed out.',
        'A group’s expenses and payments are also sent to Nostr relays, encrypted with the group’s backup key, which is under Manage. With that key, Restore a group reads them back and rebuilds the balances without Sattle’s server.',
      ],
    },
  ];
}

export function FaqScreen({ onBack, ways }: FaqScreenProps) {
  const s = useStyles();
  return (
    <Screen title="FAQ" onBack={onBack}>
      {ways.lightning && <Section title="Lightning" faqs={LIGHTNING_FAQS} />}
      {ways.upi && <Section title="UPI" faqs={UPI_FAQS} />}
      <Section title="Groups and your account" faqs={groupFaqs(ways)} />
      <Text style={s.footer}>Every answer says what Sattle does today. If that changes, this changes with it.</Text>
    </Screen>
  );
}

function Section({ title, faqs }: { title: string; faqs: Faq[] }) {
  return (
    <View>
      <SectionLabel>{title}</SectionLabel>
      <Card style={{ gap: space.md }}>
        {faqs.map((faq, i) => (
          <React.Fragment key={faq.question}>
            {i > 0 && <Divider />}
            <Question faq={faq} />
          </React.Fragment>
        ))}
      </Card>
    </View>
  );
}

/** One question, closed until tapped. */
function Question({ faq }: { faq: Faq }) {
  const s = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        onPress={() => setOpen(!open)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // A browser is told separately: react-native-web doesn't read accessibilityState.
        aria-expanded={open}
        style={s.question}
      >
        <Text style={s.q}>{faq.question}</Text>
        <Text style={s.mark}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open &&
        faq.answer.map((paragraph) => (
          <Text key={paragraph} style={s.a}>
            {paragraph}
          </Text>
        ))}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  question: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  q: { ...type.label, color: color.ink, flex: 1 },
  mark: { ...type.label, color: color.inkMuted },
  a: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  footer: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
}));
