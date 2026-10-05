/**
 * First launch: what Sattle is, in three screens, then the one question the
 * rest of the app turns on.
 *
 * Each screen makes one point and shows it the way the app itself will, built
 * from the same cards and rows, so the group screen is already familiar when
 * someone reaches it. Skip jumps over the explaining but never over the
 * question: which currencies they use decides what a new group is kept in and
 * which ways to pay they are shown at all (currencyPrefs.ts). Nothing is
 * ticked for them, because either answer hides half the app.
 *
 * It is shown once. Answering is what ends it, and the answer is what the
 * device remembers; someone who closes the app halfway gets it again.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { NO_CURRENCY_YET, isChosen, type CurrencyPrefs } from '../prefs/currencyPrefs';
import { CurrencyPicker } from './CurrencyPicker';
import { Amount, Avatar, Badge, Button, Card, Divider, Screen } from './primitives';
import { makeStyles, radius, space, type } from './theme';

const STEPS = ['split', 'no_app', 'settle', 'currencies'] as const;
const LAST = STEPS.length - 1;

export function OnboardingScreen({ onDone }: { onDone: (prefs: CurrencyPrefs) => void }) {
  const [at, setAt] = useState(0);
  const [prefs, setPrefs] = useState(NO_CURRENCY_YET);
  const step = STEPS[at];

  return (
    <Screen
      // Each step starts at its top, wherever the one before was scrolled to.
      key={step}
      title="Sattle"
      brand
      onBack={at > 0 ? () => setAt(at - 1) : undefined}
      // On the last step, the room Skip took, so the header doesn't move when it goes.
      right={at < LAST ? <Button label="Skip" variant="quiet" onPress={() => setAt(LAST)} /> : <View style={styles.noSkip} />}
      footer={
        at < LAST ? (
          <Button label="Next" variant="primary" onPress={() => setAt(at + 1)} />
        ) : (
          <Button label="Continue" variant="primary" disabled={!isChosen(prefs)} onPress={() => onDone(prefs)} />
        )
      }
    >
      <Progress at={at} />
      {step === 'split' && <Split />}
      {step === 'no_app' && <NoApp />}
      {step === 'settle' && <Settle />}
      {step === 'currencies' && (
        <Step
          title="What do you use?"
          body="Pick one or both. Sattle only shows what goes with your choice, and you can change it later under Account."
        >
          <CurrencyPicker prefs={prefs} onChange={setPrefs} />
        </Step>
      )}
    </Screen>
  );
}

function Progress({ at }: { at: number }) {
  const s = useStyles();
  return (
    <View style={s.progress} accessibilityRole="progressbar" accessibilityLabel={`Step ${at + 1} of ${STEPS.length}`}>
      {STEPS.map((step, i) => (
        <View key={step} style={[s.dot, i <= at && s.dotDone]} />
      ))}
    </View>
  );
}

function Step({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  const s = useStyles();
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Text style={s.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={s.body}>{body}</Text>
      </View>
      {children}
    </View>
  );
}

/**
 * Two spends between three people, and what they come to. The amounts are
 * what the ledger gives: ₹3,000 in all is ₹1,000 each, so you, having paid
 * ₹2,400, are owed ₹1,400, and Riya, having paid ₹600, owes ₹400.
 */
function Split() {
  const s = useStyles();
  return (
    <Step
      title="Split bills without the maths"
      body="Start a group for a trip, a flat or a night out. Add what each of you paid, and Sattle works out who owes whom."
    >
      <Card style={{ padding: 0 }}>
        <Spend name="Dinner" meta="You paid · split 3 ways" amount={240_000} />
        <Divider />
        <Spend name="Cab" meta="Riya paid · split 3 ways" amount={60_000} />
        <View style={s.result}>
          <Owes name="Kabir" amount={100_000} />
          <Owes name="Riya" amount={40_000} />
        </View>
      </Card>
      <Text style={s.note}>Split equally, by shares, or by exact amounts. Every split shows each person’s part before you save it.</Text>
    </Step>
  );
}

function NoApp() {
  const s = useStyles();
  return (
    <Step
      title="Only one of you needs the app"
      body="Add your friends by name. Send the group’s link to your chat, and they see what they owe and pay it from their browser. Nothing to install, nothing to sign up for."
    >
      <Card style={{ padding: 0 }}>
        <Person name="You" meta="In app" />
        <Divider />
        <Person name="Riya" meta="Opens the link" noApp />
        <Divider />
        <Person name="Kabir" meta="Opens the link" noApp />
      </Card>
      <Text style={s.note}>
        Anyone who wants the app can join from the same link. They pick their name, and someone in the group lets them
        in.
      </Text>
    </Step>
  );
}

function Settle() {
  const s = useStyles();
  return (
    <Step
      title="Settle up your way"
      body="Pay what you owe from an app you already have. The money goes straight from you to them: Sattle never holds it."
    >
      <Card style={{ gap: space.md }}>
        <Way
          title="UPI"
          body="From GPay, PhonePe or any UPI app. It’s settled once the person you paid confirms it arrived."
        />
        <Divider />
        <Way title="Bitcoin, over Lightning" body="From any Lightning wallet. It’s settled when the payment goes through." />
        <Divider />
        <Way title="Cash, or anything else" body="The person who was paid marks it settled." />
      </Card>
      <Text style={s.note}>A balance only moves once a payment is confirmed. Next, you choose which of these you use.</Text>
    </Step>
  );
}

function Spend({ name, meta, amount }: { name: string; meta: string; amount: number }) {
  const s = useStyles();
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowName}>{name}</Text>
        <Text style={s.rowMeta}>{meta}</Text>
      </View>
      <Amount minor={amount} size="md" />
    </View>
  );
}

function Owes({ name, amount }: { name: string; amount: number }) {
  const s = useStyles();
  return (
    <View style={s.owes}>
      <Avatar name={name} />
      <Text style={[s.rowText, { flex: 1 }]}>{name} owes you</Text>
      <Amount minor={amount} size="md" net />
    </View>
  );
}

function Person({ name, meta, noApp }: { name: string; meta: string; noApp?: boolean }) {
  const s = useStyles();
  return (
    <View style={s.row}>
      <Avatar name={name} dim={noApp} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowName}>{name}</Text>
        <Text style={s.rowMeta}>{meta}</Text>
      </View>
      {noApp && <Badge text="No app" />}
    </View>
  );
}

function Way({ title, body }: { title: string; body: string }) {
  const s = useStyles();
  return (
    <View style={{ gap: 3 }}>
      <Text style={s.rowName}>{title}</Text>
      <Text style={s.wayBody}>{body}</Text>
    </View>
  );
}

/** A button's height. */
const styles = StyleSheet.create({ noSkip: { height: 48 } });

const useStyles = makeStyles((color) => ({
  progress: { flexDirection: 'row', gap: space.xs },
  dot: { flex: 1, height: 3, borderRadius: radius.pill, backgroundColor: color.line },
  dotDone: { backgroundColor: color.ink },
  title: { ...type.display, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  rowName: { ...type.body, fontWeight: '500', color: color.ink },
  rowMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  rowText: { ...type.body, color: color.ink },
  // What the spends above come to, set into the bottom of the same card.
  result: {
    gap: space.md,
    padding: space.lg,
    backgroundColor: color.surfaceSunken,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  owes: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  wayBody: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
}));
