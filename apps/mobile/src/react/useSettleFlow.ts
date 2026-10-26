/**
 * One settle attempt, from the sheet opening to a terminal state.
 *
 *   opening ──one way to pay──▶ as if it had been chosen
 *      │
 *      ▼
 *   choosing ──choose(rail)──▶ paying ──confirmed──▶ done
 *      │   ▲                     │
 *      │   └──────failed─────────┘   (error shown, nothing moved)
 *      ├──startAddressEntry──▶ entering_address ──save──▶ choosing (re-resolved)
 *      ├──choose('upi')──▶ upi ──payWith(app): it takes the link and says it went through──▶ done
 *      │                    │  └──payWith(app that refuses links)──▶ upi_copied ──openCopiedApp──▶ upi
 *      │                    ▼  back from a UPI app that says nothing, or "I've paid"
 *      │                 upi_ask ──yes──▶ done
 *      │                    └──no──▶ upi
 *      └──markManual──────────────────────────────────▶ done
 *
 * UPI is paid outside Sattle, in the payer's UPI app, and nothing here can
 * see the money move. On Android the phone's UPI apps are listed, and the
 * one picked is opened on the link and hands back what happened. When it
 * says the payment went through, that settles the debt then and there, on
 * that app's word, with the ids it gave kept for checking.
 *
 * Google Pay and PhonePe refuse a link from another app (upi/upiApps.ts).
 * They are never sent one: the UPI ID is copied, the sheet says so
 * (upi_copied), and the app is opened plain for the payer to paste it in.
 *
 * An iPhone and a browser are told nothing by a UPI app, nor is Android by
 * an app opened plain, and some apps stay quiet on the link too. So when
 * the payer comes back from one, or taps "I've paid", they are asked whether
 * it went through (upi_ask). Their yes settles it the same way, on their
 * word, and the reference their UPI app showed is kept with it when they
 * type one in. Nobody is asked to confirm either.
 *
 * Options are resolved up front from the recipient's state, so a blocked
 * recipient shows remedies before the user commits to anything. Only the ways
 * to pay that go with the currencies the payer uses are among them (payWays).
 *
 * With one way to pay there is nothing to ask, so the sheet opens on it
 * (onlyRail): Lightning for someone who gave no UPI ID. It does that once.
 * After a failure or a step back the payer gets the button, and decides when
 * to try again.
 */

import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  groupLinkPath,
  liveInvoiceFor,
  onlyRail,
  parseLightningAddress,
  parseUpiReference,
  resolveSettlementOptions,
  TERMINAL_STATUSES,
  upiPayUri,
  type Debt,
  type Member,
  type PayWays,
  type Rail,
  type Settlement,
  type SettlementOptions,
  type UpiOutcome,
  type UpiPayee,
} from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import { usePayWays } from '../prefs/useCurrencyPrefs';
import { upiLauncher } from '../upi/launchUpi';
import { refusesLinks, type UpiApp } from '../upi/upiApps';
import { useActionKeys, useClient, usePaymentModeAnswer, useWallet } from './SattleProvider';
import { useBackFromUpi } from './useBackFromUpi';

export type SettleStep = 'choosing' | 'entering_address' | 'paying' | 'done' | 'upi' | 'upi_copied' | 'upi_ask';

/** Paying by UPI: who to pay, the link that pays them, the apps that could, and what the UPI app last said, if it says anything. */
export interface UpiSession {
  payee: UpiPayee;
  uri: string;
  /** The UPI apps on this phone, for the payer to pick from. Null where they can't be listed: an iPhone, a browser, an old build. */
  apps: UpiApp[] | null;
  outcome: UpiOutcome | null;
}

export interface SettleFlow {
  step: SettleStep;
  /** The sheet has just opened and isn't asking anything yet: there may be only one way to pay, which it starts. */
  opening: boolean;
  options: SettlementOptions | null;
  /** Which ways to pay this payer is shown here: what they use, and what this group can be settled in. */
  ways: PayWays;
  settlement: Settlement | null;
  error: Error | null;
  busy: boolean;
  choose: (rail: Rail) => Promise<void>;
  markManual: (note?: string) => Promise<void>;
  startAddressEntry: () => void;
  cancelAddressEntry: () => void;
  savePayoutAddress: (raw: string) => Promise<void>;
  clearError: () => void;
  /** The group's link, worded to invite the recipient. Throws if it can't; nothing else in the flow changes. */
  createInvite: (groupName: string) => Promise<{ url: string; message: string; sentNote: string }>;
  /** Set on the `upi` step. */
  upi: UpiSession | null;
  /**
   * Pays in `app`, or in whichever app the phone picks without one. An app that takes the link
   * is opened on it and heard from: a success settles the debt. One that refuses links
   * (refusesLinks) gets the UPI ID on the clipboard instead, and the sheet says so (upi_copied).
   * Null where no app can be opened this way (iOS, web).
   */
  payWith: ((app: UpiApp | null) => Promise<void>) | null;
  /** On the `upi_copied` step: the app the UPI ID was copied for. */
  copiedFor: UpiApp | null;
  /** Opens that app plain. When the payer comes back, the sheet asks whether it went through. */
  openCopiedApp: () => void;
  /**
   * The payer went to pay by hand, from the copied ID. The question on return then has no
   * reference box: they typed everything in themselves, and copying a number out of the
   * app on top of that is more than the payment is worth.
   */
  paidByHand: boolean;
  /** Closes that, with nothing recorded. */
  dismissCopied: () => void;
  /** The payer is being handed to a UPI app that won't say what happened. When they come back, the sheet asks. */
  leftForUpi: () => void;
  /** Asks whether the payment went through. Also where "I've paid" goes. */
  askPaid: () => void;
  /**
   * Yes. Settles the debt, on their word. `reference` is what they typed in for the number their
   * UPI app showed: empty is fine, and anything else has to be able to be one.
   */
  confirmPaid: (reference: string) => Promise<void>;
  /** No. Back to paying, with nothing recorded. */
  notPaid: () => void;
  /** Set when the UPI app said the payment went through and telling the server failed: tries that again. */
  recordUpiSuccess: (() => Promise<void>) | null;
  /** Back to the options, with nothing recorded. */
  leaveUpi: () => void;
}

/** Base for every link the app hands out: the group's link and pay links. */
export const APP_URL = process.env.EXPO_PUBLIC_APP_URL ?? 'http://localhost:8081';

/**
 * The group's link, made now if it has none, and the line to show once it has
 * been sent. It is the group's one link: whoever opens it sees the group, can
 * pay what they owe, and can ask to join.
 *
 * Looking first is what makes a retry safe: a link made by an attempt whose
 * reply was lost is found here. So making one takes a fresh request key every
 * time, and can never be answered with a saved reply naming a link that has
 * since been turned off. It is also why sharing again hands out the same link
 * instead of killing the one already in the chat.
 */
export async function groupLinkToShare(client: SattleClient, groupId: string) {
  const link = (await client.getGroupLink(groupId)) ?? (await client.createGroupLink(groupId));
  return {
    url: `${APP_URL}${groupLinkPath(link.token)}`,
    sentNote: 'Sent. It works until someone in the group turns it off.',
  };
}

export function useSettleFlow(debt: Debt, members: Member[], groupName: string, currency: string): SettleFlow {
  const client = useClient();
  const wallet = useWallet();
  // A retry after a network error reuses the attempt's key, so a payment
  // whose response was lost isn't started twice.
  const keys = useActionKeys();
  const { mode, pending } = usePaymentModeAnswer();
  const ways = usePayWays(currency);

  const [recipient, setRecipient] = useState(() => members.find((m) => m.id === debt.toMemberId));
  const [step, setStep] = useState<SettleStep>('choosing');
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [upi, setUpi] = useState<UpiSession | null>(null);
  const [copiedFor, setCopiedFor] = useState<UpiApp | null>(null);
  const [paidByHand, setPaidByHand] = useState(false);
  const unsub = useRef<(() => void) | null>(null);
  const upiApp = useBackFromUpi();
  const [opening, setOpening] = useState(true);
  const opened = useRef(false);
  const live = useRef(true);

  useEffect(
    () => () => {
      live.current = false;
      unsub.current?.();
    },
    []
  );

  // Back from a UPI app that says nothing about what happened in it: ask.
  useEffect(() => {
    if (upiApp.back === null) return;
    upiApp.answered();
    setStep((now) => (now === 'upi' ? 'upi_ask' : now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upiApp.back]);

  const options = useMemo(
    () =>
      recipient
        ? resolveSettlementOptions({ recipient, walletAvailable: wallet.isAvailable, mode, currency, ways })
        : null,
    [recipient, wallet.isAvailable, mode, currency, ways]
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const onUpdate = (s: Settlement) => {
    setSettlement(s);
    if (s.status === 'confirmed' || s.status === 'manually_confirmed') {
      setStep('done');
    } else if (TERMINAL_STATUSES.includes(s.status)) {
      setStep('choosing');
      setError(
        new Error(
          `${s.status === 'expired' ? 'The invoice expired' : 'The payment failed'}${
            s.failureReason ? `: ${s.failureReason}` : ''
          }. Nothing moved — you can try again.`
        )
      );
    }
  };

  /**
   * Android: hands over to a UPI app, and acts on what it says when it hands back. An app that
   * refuses links is never sent one: the UPI ID is copied for it instead, and the sheet says so.
   */
  const payWith = async (session: UpiSession, app: UpiApp | null) => {
    if (!upiLauncher) return;
    if (app && refusesLinks(app)) {
      await Clipboard.setStringAsync(session.payee.upiId);
      setCopiedFor(app);
      setStep('upi_copied');
      return;
    }
    setPaidByHand(false);
    let outcome: UpiOutcome;
    try {
      outcome = await upiLauncher.pay(session.uri, app ?? undefined);
    } catch {
      throw new Error(
        `${app ? `${app.name} couldn’t be opened` : 'No UPI app on this phone could open this'}. Pay the UPI ID below from your UPI app, then mark it as paid.`
      );
    }
    // The app's name travels with what it said, so Try again reports the same thing under the same
    // key. Without a pick the phone chose, and nobody here knows which app it was.
    if (app) outcome = { ...outcome, paidWith: app.name };
    setUpi({ ...session, outcome });
    if (outcome.status === 'success') await settleByUpi(outcome);
  };

  /**
   * The UPI app said the money left. That settles it: nobody is asked to confirm, and what the
   * app handed back goes with it, so the payment can be found in a statement. Asking again with
   * the same answer, after the server couldn't be reached, is one request and not a second payment.
   */
  const settleByUpi = async ({ txnId, approvalRef, txnRef, paidWith }: UpiOutcome) => {
    const input = {
      ...pick(debt),
      ...(txnId && { txnId }),
      ...(approvalRef && { approvalRef }),
      ...(txnRef && { txnRef }),
      ...(paidWith && { paidWith }),
    };
    onUpdate(await keys.run('upi-paid', input, (k) => client.reportUpiPayment(input, k)));
  };

  const choose = (rail: Rail) =>
    run(async () => {
      if (rail === 'upi') {
        // The apps are asked for alongside, so the sheet opens with them. Not knowing them is no
        // reason to stop the payment: the sheet then has the one button an iPhone has.
        const [payee, apps] = await Promise.all([
          client.getUpiPayee(debt.groupId, debt.toMemberId),
          upiLauncher ? upiLauncher.apps().catch(() => null) : null,
        ]);
        setUpi({
          payee,
          uri: upiPayUri({ upiId: payee.upiId, name: payee.name, amount: debt.amount, note: `Sattle ${groupName}` }),
          apps,
          outcome: null,
        });
        setStep('upi');
        return;
      }
      if (rail === 'manual') {
        const input = { ...pick(debt), note: 'Settled outside the app' };
        onUpdate(await keys.run('settle-manual', input, (k) => client.markSettledManually(input, k)));
        return;
      }
      const input = { ...pick(debt), rail };
      // The server makes one invoice at a time for a debt. One still out, from this sheet
      // before it was closed or from a pay link, is the one to pay.
      const s =
        (rail === 'invoice' ? liveInvoiceFor(await client.getSettlements(debt.groupId), debt) : undefined) ??
        (await keys.run('settle', input, (k) => client.createSettlement(input, k)));
      // The sheet was closed while that was on its way. Opened again, it picks the invoice up.
      if (!live.current) return;
      setStep('paying');
      setSettlement(s);
      unsub.current?.();
      // In the real app, BreezWallet.pay(destination) is triggered here once
      // the settlement reaches awaiting_payment on the in_app/address rails.
      unsub.current = client.onSettlementUpdate(s.id, onUpdate);
    });

  // Once the server has said which payments it makes: start the one way to pay, or ask.
  useEffect(() => {
    if (pending || opened.current) return;
    opened.current = true;
    const only = options ? onlyRail(options) : null;
    if (!only) return setOpening(false);
    void choose(only).then(() => live.current && setOpening(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return {
    step,
    opening,
    options,
    ways,
    settlement,
    error,
    busy,
    upi,
    payWith: upiLauncher && upi ? (app) => run(() => payWith(upi, app)) : null,
    copiedFor,
    paidByHand,
    openCopiedApp: () => {
      if (!upiLauncher || !copiedFor) return;
      setError(null);
      // Back on the UPI step underneath, which is the one that turns coming back into the question.
      setStep('upi');
      setPaidByHand(true);
      upiApp.leaving();
      try {
        upiLauncher.open(copiedFor);
      } catch {
        upiApp.answered();
        setError(new Error(`${copiedFor.name} couldn’t be opened. Pay the UPI ID below from it by hand, then mark it as paid.`));
      }
    },
    dismissCopied: () => {
      setError(null);
      setStep('upi');
    },
    leftForUpi: () => upiApp.leaving(),
    askPaid: () => {
      setError(null);
      setStep('upi_ask');
    },
    confirmPaid: (raw) =>
      run(async () => {
        let reference: string | undefined;
        if (raw.trim()) {
          const parsed = parseUpiReference(raw);
          if (!parsed.ok) throw new Error(parsed.reason);
          reference = parsed.reference;
        }
        // The app's name only when they were sent to one: "I've paid" out of nowhere names none.
        const input = {
          ...pick(debt),
          byPayer: true as const,
          ...(reference && { reference }),
          ...(paidByHand && copiedFor && { paidWith: copiedFor.name }),
        };
        onUpdate(await keys.run('upi-paid', input, (k) => client.reportUpiPayment(input, k)));
      }),
    notPaid: () => {
      setError(null);
      setStep('upi');
    },
    recordUpiSuccess: upi?.outcome?.status === 'success' ? () => run(() => settleByUpi(upi.outcome!)) : null,
    leaveUpi: () => {
      setError(null);
      setUpi(null);
      setCopiedFor(null);
      setPaidByHand(false);
      upiApp.answered();
      setStep('choosing');
    },

    choose,

    markManual: (note) =>
      run(async () => {
        const input = { ...pick(debt), note };
        onUpdate(await keys.run('settle-manual', input, (k) => client.markSettledManually(input, k)));
      }),

    startAddressEntry: () => {
      setError(null);
      setStep('entering_address');
    },

    cancelAddressEntry: () => {
      setError(null);
      setStep('choosing');
    },

    savePayoutAddress: (raw) =>
      run(async () => {
        const parsed = parseLightningAddress(raw);
        if (!parsed.ok) throw new Error(parsed.reason);
        if (!recipient) return;
        setRecipient(await client.setMemberPayoutAddress(recipient.id, parsed.address));
        setStep('choosing');
      }),

    clearError: () => setError(null),

    createInvite: async (groupName) => {
      if (!recipient) throw new Error('There’s nobody to invite.');
      const { url, sentNote } = await groupLinkToShare(client, debt.groupId);
      return {
        url,
        message: `${recipient.displayName}, join "${groupName}" on Sattle so I can pay you back. Open this and tap Join: ${url}`,
        sentNote,
      };
    },
  };
}

function pick(debt: Debt) {
  return {
    groupId: debt.groupId,
    fromMemberId: debt.fromMemberId,
    toMemberId: debt.toMemberId,
    amount: debt.amount,
  };
}
