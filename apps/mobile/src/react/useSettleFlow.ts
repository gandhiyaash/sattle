/**
 * One settle attempt, from the sheet opening to a terminal state.
 *
 *   choosing ──choose(rail)──▶ paying ──confirmed──▶ done
 *      │   ▲                     │
 *      │   └──────failed─────────┘   (error shown, nothing moved)
 *      ├──startAddressEntry──▶ entering_address ──save──▶ choosing (re-resolved)
 *      └──markManual──────────────────────────────────▶ done
 *
 * Options are resolved up front from the recipient's state, so a blocked
 * recipient shows remedies before the user commits to anything.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  invitePath,
  parseLightningAddress,
  resolveSettlementOptions,
  TERMINAL_STATUSES,
  type Debt,
  type Member,
  type Rail,
  type Settlement,
  type SettlementOptions,
} from '@sattle/core';
import type { SattleClient } from '../client/SattleClient';
import { useActionKeys, useClient, useWallet } from './SattleProvider';

export type SettleStep = 'choosing' | 'entering_address' | 'paying' | 'done';

export interface SettleFlow {
  step: SettleStep;
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
  /** The group's invite, worded for the recipient. Throws if it can't; nothing else in the flow changes. */
  createInvite: (groupName: string) => Promise<{ url: string; message: string; sentNote: string }>;
}

/** Base for every link the app hands out: invites and pay links. */
export const APP_URL = process.env.EXPO_PUBLIC_APP_URL ?? 'http://localhost:8081';

/**
 * The group's invite link, made now if it has none that still works, and the
 * line to show once it has been sent.
 *
 * Looking first is what makes a retry safe: an invite made by an attempt whose
 * reply was lost is found here. So making one takes a fresh request key every
 * time, and can never be answered with a saved reply naming an invite that has
 * since been turned off. It is also why sharing again hands out the same link
 * instead of killing the one already in the chat.
 */
export async function inviteLink(client: SattleClient, groupId: string) {
  const invite = (await client.getGroupInvite(groupId)) ?? (await client.createInvite(groupId));
  const days = Math.max(1, Math.ceil((Date.parse(invite.expiresAt) - Date.now()) / 86_400_000));
  return {
    url: `${APP_URL}${invitePath(invite.token)}`,
    sentNote: `Sent. It works ${days === 1 ? 'until tomorrow' : `for ${days} more days`}, for everyone who hasn’t joined.`,
  };
}

export function useSettleFlow(debt: Debt, members: Member[], _groupName: string): SettleFlow {
  const client = useClient();
  const wallet = useWallet();
  // A retry after a network error reuses the attempt's key, so a payment
  // whose response was lost isn't started twice.
  const keys = useActionKeys();

  const [recipient, setRecipient] = useState(() => members.find((m) => m.id === debt.toMemberId));
  const [step, setStep] = useState<SettleStep>('choosing');
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const unsub = useRef<(() => void) | null>(null);

  useEffect(() => () => unsub.current?.(), []);

  const options = useMemo(
    () =>
      recipient ? resolveSettlementOptions({ recipient, walletAvailable: wallet.isAvailable }) : null,
    [recipient, wallet.isAvailable]
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

  return {
    step,
    options,
    settlement,
    error,
    busy,

    choose: (rail) =>
      run(async () => {
        if (rail === 'manual') {
          const input = { ...pick(debt), note: 'Settled outside the app' };
          onUpdate(await keys.run('settle-manual', input, (k) => client.markSettledManually(input, k)));
          return;
        }
        const input = { ...pick(debt), rail };
        const s = await keys.run('settle', input, (k) => client.createSettlement(input, k));
        setStep('paying');
        setSettlement(s);
        unsub.current?.();
        // In the real app, BreezWallet.pay(destination) is triggered here once
        // the settlement reaches awaiting_payment on the in_app/address rails.
        unsub.current = client.onSettlementUpdate(s.id, onUpdate);
      }),

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
      const { url, sentNote } = await inviteLink(client, debt.groupId);
      return {
        url,
        message: `${recipient.displayName}, join "${groupName}" on Sattle so I can pay you back: ${url}`,
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
