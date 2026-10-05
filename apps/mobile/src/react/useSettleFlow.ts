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
 *      ├──choose('upi')──▶ upi ──claimUpi──▶ upi_sent   (the payee confirms, elsewhere)
 *      └──markManual──────────────────────────────────▶ done
 *
 * UPI is paid outside Sattle, in the payer's UPI app, so its branch ends in a
 * claim, not a settlement: nothing here can see the money move. On Android
 * the UPI app is opened for them and its answer makes the claim; elsewhere
 * the payer pays and says so.
 *
 * Options are resolved up front from the recipient's state, so a blocked
 * recipient shows remedies before the user commits to anything.
 *
 * With one way to pay there is nothing to ask, so the sheet opens on it
 * (onlyRail): Lightning for someone who gave no UPI ID. It does that once.
 * After a failure or a step back the payer gets the button, and decides when
 * to try again.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  groupLinkPath,
  liveInvoiceFor,
  onlyRail,
  parseLightningAddress,
  resolveSettlementOptions,
  TERMINAL_STATUSES,
  upiPayUri,
  type Debt,
  type Member,
  type Rail,
  type Settlement,
  type SettlementOptions,
  type UpiClaim,
  type UpiOutcome,
  type UpiPayee,
} from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import { launchUpi } from '../upi/launchUpi';
import { useActionKeys, useClient, usePaymentModeAnswer, useWallet } from './SattleProvider';

export type SettleStep = 'choosing' | 'entering_address' | 'paying' | 'done' | 'upi' | 'upi_sent';

/** Paying by UPI: who to pay, the link that pays them, and what the UPI app last said, if it says anything. */
export interface UpiSession {
  payee: UpiPayee;
  uri: string;
  outcome: UpiOutcome | null;
}

export interface SettleFlow {
  step: SettleStep;
  /** The sheet has just opened and isn't asking anything yet: there may be only one way to pay, which it starts. */
  opening: boolean;
  options: SettlementOptions | null;
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
  /** The payer's word that they paid, once given. Set on `upi_sent`. */
  upiClaim: UpiClaim | null;
  /** Opens the UPI app again and acts on what it says. Null where no UPI app reports back (iOS, web). */
  openUpiApp: (() => Promise<void>) | null;
  /** Tells the person owed it has been paid. They confirm it. */
  claimUpi: () => Promise<void>;
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

  const [recipient, setRecipient] = useState(() => members.find((m) => m.id === debt.toMemberId));
  const [step, setStep] = useState<SettleStep>('choosing');
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [upi, setUpi] = useState<UpiSession | null>(null);
  const [upiClaim, setUpiClaim] = useState<UpiClaim | null>(null);
  const unsub = useRef<(() => void) | null>(null);
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

  const options = useMemo(
    () =>
      recipient
        ? resolveSettlementOptions({ recipient, walletAvailable: wallet.isAvailable, mode, currency })
        : null,
    [recipient, wallet.isAvailable, mode, currency]
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

  const claimUpi = async (reference?: string) => {
    const input = { ...pick(debt), ...(reference ? { reference } : {}) };
    setUpiClaim(await keys.run('upi-claim', input, (k) => client.createUpiClaim(input, k)));
    setStep('upi_sent');
  };

  /** Android: hands over to a UPI app, and acts on what it says when it hands back. */
  const openUpiApp = async (session: UpiSession) => {
    if (!launchUpi) return;
    let outcome: UpiOutcome;
    try {
      outcome = await launchUpi(session.uri);
    } catch {
      throw new Error('No UPI app on this phone could open this. Pay the UPI ID below from your UPI app, then mark it as paid.');
    }
    setUpi({ ...session, outcome });
    // The app says the money left, so tell the person owed, with the reference to check it against.
    if (outcome.status === 'success') await claimUpi(outcome.reference);
  };

  const choose = (rail: Rail) =>
    run(async () => {
      if (rail === 'upi') {
        const payee = await client.getUpiPayee(debt.groupId, debt.toMemberId);
        const session: UpiSession = {
          payee,
          uri: upiPayUri({ upiId: payee.upiId, name: payee.name, amount: debt.amount, note: `Sattle ${groupName}` }),
          outcome: null,
        };
        setUpi(session);
        setStep('upi');
        await openUpiApp(session);
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
    settlement,
    error,
    busy,
    upi,
    upiClaim,
    openUpiApp: launchUpi && upi ? () => run(() => openUpiApp(upi)) : null,
    claimUpi: () => run(() => claimUpi(upi?.outcome?.reference)),
    leaveUpi: () => {
      setError(null);
      setUpi(null);
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
