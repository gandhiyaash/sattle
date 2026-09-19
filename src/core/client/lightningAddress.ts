/**
 * Parses what people paste into the address field.
 *
 * An address is not an invoice. A BOLT11 invoice is single-use and expires in
 * minutes, so storing one as someone's payout destination would work once in
 * a demo and fail forever after. We reject it with a message that says why.
 */

export type ParsedAddress =
  | { ok: true; address: string }
  | { ok: false; reason: string };

const ADDRESS = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function parseLightningAddress(raw: string): ParsedAddress {
  let input = raw.trim();
  if (!input) return { ok: false, reason: 'Paste their Lightning address.' };

  input = input.replace(/^lightning:/i, '').replace(/^₿/, '').trim().toLowerCase();

  if (/^ln(bc|tb|bcrt|tbs)[0-9]/.test(input)) {
    return {
      ok: false,
      reason: "That's an invoice, which only works once. Ask for their Lightning address instead — it looks like an email.",
    };
  }
  if (input.startsWith('lnurl')) {
    return { ok: false, reason: 'LNURL codes aren’t supported yet. Ask for the address that looks like an email.' };
  }
  if (!ADDRESS.test(input)) {
    return { ok: false, reason: 'That doesn’t look like a Lightning address. It should look like name@wallet.com.' };
  }
  return { ok: true, address: input };
}
