/**
 * Proof of payment: the preimage of an invoice's payment hash. Only whoever
 * paid has it (their wallet hands it back), so a preimage that hashes to the
 * hash we stored when the invoice was minted proves this invoice was paid.
 * It's what confirms an address payment whose provider can't tell us, and
 * a payment that landed after we'd called the invoice expired.
 *
 * The check is one SHA-256, and the input is refused unless it's exactly 64
 * hex characters, before anything else is looked at.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { SattleError, type Settlement } from '@sattle/core';

import type { Repo } from './repo';

const PREIMAGE = /^[0-9a-f]{64}$/;

/** Generous on length so a pasted proof with spaces around it still reads; readPreimage is the real check. */
export const ProofBody = z.object({ preimage: z.string().max(200) });

/** Lowercased and checked for shape, or a 400 that says what a proof looks like. */
export function readPreimage(raw: string) {
  const p = raw.trim().toLowerCase();
  if (!PREIMAGE.test(p)) {
    throw new SattleError('invalid_input', 'That isn’t a payment proof. It’s 64 characters of 0–9 and a–f, from your wallet’s payment details.');
  }
  return p;
}

export const hashOfPreimage = (preimage: string) => createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

/**
 * Confirms `s` if `preimage` is the proof of its invoice. Submitting it again,
 * or for a payment already settled another way, returns it unchanged.
 */
export function applyProof(repo: Repo, s: Settlement, preimage: string): Settlement {
  const paymentHash = repo.invoiceOf(s.id)?.paymentHash;
  if (!paymentHash) throw new SattleError('invalid_input', 'This payment never had an invoice, so there’s nothing to prove.');
  if (hashOfPreimage(preimage) !== paymentHash) {
    throw new SattleError('invalid_input', 'That proof is for a different payment.');
  }
  if (repo.confirmWithProof(s.id, preimage)) {
    console.log(`settlement ${s.id}: confirmed by proof${s.status === 'awaiting_payment' || s.status === 'in_flight' ? '' : ` (was ${s.status})`}`);
  }
  return repo.settlement(s.id)!;
}
