/**
 * UPI, for settling a rupee debt outside Lightning.
 *
 * Sattle can't see a UPI payment. No bank or app tells a third party that
 * one person paid another, so nothing here moves a balance: the payer's app
 * opens their UPI app with the payee and amount filled in, and what comes
 * back, if anything, is the payer's own phone talking. It is a hint for the
 * person owed, who is the one that confirms.
 */

export type ParsedUpiId = { ok: true; upiId: string } | { ok: false; reason: string };

/** name@handle. The handle is a bank's or app's short name and has no dot in it. */
const UPI_ID = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9]{1,63}$/;

export function parseUpiId(raw: string): ParsedUpiId {
  const input = raw.trim().replace(/^upi:\/\/pay\?pa=/i, '').toLowerCase();
  if (!input) return { ok: false, reason: 'Enter your UPI ID.' };
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(input)) {
    return {
      ok: false,
      reason: 'That looks like an email or a Lightning address. A UPI ID looks like name@okhdfcbank or 98xxxxxx10@ybl.',
    };
  }
  if (!UPI_ID.test(input)) {
    return { ok: false, reason: 'That doesn’t look like a UPI ID. It should look like name@okhdfcbank or 98xxxxxx10@ybl.' };
  }
  return { ok: true, upiId: input };
}

/**
 * The link a UPI app opens to pay someone: who, how much, and a note. The
 * same text is what the QR code holds. `amount` is in paise.
 *
 * Only what a person-to-person payment needs. Merchant fields would ask the
 * app to treat this as a shop's payment, which it isn't.
 */
export function upiPayUri({
  upiId,
  name,
  amount,
  note,
}: {
  upiId: string;
  name: string;
  amount: number;
  note?: string;
}): string {
  // The @ stays as it is: UPI apps read the ID straight out of the link.
  const pa = encodeURIComponent(upiId).replace(/%40/g, '@');
  const parts = [`pa=${pa}`, `pn=${encodeURIComponent(clean(name, 50))}`, `am=${(amount / 100).toFixed(2)}`, 'cu=INR'];
  const tn = note ? clean(note, 50) : '';
  if (tn) parts.push(`tn=${encodeURIComponent(tn)}`);
  return `upi://pay?${parts.join('&')}`;
}

/** UPI apps are strict about what a name or note may hold: letters, digits and spaces. */
const clean = (text: string, max: number) =>
  text
    .normalize('NFKD')
    // An accent comes off its letter here, so drop it before the rest becomes spaces.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();

/** What the payer's UPI app said when it handed control back. */
export interface UpiOutcome {
  /**
   * success  the app says the money left
   * pending  the app says the bank hasn't answered yet
   * failed   the app says it didn't go through
   * unknown  the app said nothing: closed, cancelled, or it doesn't report
   */
  status: 'success' | 'pending' | 'failed' | 'unknown';
  /** The bank's reference for the payment, to match against the payee's own records. */
  reference?: string;
}

/**
 * Reads the result an Android UPI app returns. Apps differ: some send one
 * `response` string (`txnId=…&Status=SUCCESS&ApprovalRefNo=…`), some send
 * the fields on their own, and the names' capitals vary. Anything that isn't
 * plainly a success or a failure is `unknown`, never a success.
 */
export function parseUpiResponse(extras: Record<string, unknown> | string | null | undefined): UpiOutcome {
  const fields = new Map<string, string>();
  const put = (key: string, value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const v = String(value).trim();
    if (v && !/^(null|undefined)$/i.test(v)) fields.set(key.trim().toLowerCase(), v);
  };
  const putAll = (text: string) => {
    for (const pair of text.split('&')) {
      const at = pair.indexOf('=');
      if (at > 0) put(pair.slice(0, at), safeDecode(pair.slice(at + 1)));
    }
  };

  if (typeof extras === 'string') putAll(extras);
  else if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (key.toLowerCase() === 'response' && typeof value === 'string') putAll(value);
      else put(key, value);
    }
  }

  const said = (fields.get('status') ?? '').toLowerCase();
  const status: UpiOutcome['status'] =
    said === 'success' ? 'success' : said === 'submitted' || said === 'pending' ? 'pending' : said.startsWith('fail') ? 'failed' : 'unknown';
  const reference = fields.get('approvalrefno') ?? fields.get('txnid') ?? fields.get('txnref');
  return reference ? { status, reference: reference.slice(0, 64) } : { status };
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
