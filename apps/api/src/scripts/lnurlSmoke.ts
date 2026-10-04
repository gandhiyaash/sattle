/**
 * L3's check against a real Lightning address: read its pay parameters,
 * get an invoice, check it, and ask its verify link (if it has one).
 *
 *   npm run lnurl:smoke -w @sattle/api -- you@getalby.com            # 10 sats
 *   npm run lnurl:smoke -w @sattle/api -- you@getalby.com 21 --wait  # keep asking until it's paid
 *
 * Use your own address: every run asks the provider to mint an invoice.
 */

import { LnurlClient, LnurlError } from '../lnurl';

const address = process.argv.slice(2).find((a) => a.includes('@'));
if (!address) {
  console.error('Usage: npm run lnurl:smoke -w @sattle/api -- <your lightning address> [sats] [--wait]');
  process.exit(1);
}
const wait = process.argv.includes('--wait');
const sats = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 10);
const client = new LnurlClient({ network: process.env.LIGHTNING_NETWORK ?? 'bc' });

try {
  const params = await client.payParams(address);
  console.log(`pay parameters: ${params.minSendableMsat / 1000}–${params.maxSendableMsat / 1000} sats`);
  console.log(`  callback ${new URL(params.callback).host}`);

  const inv = await client.requestInvoice(address, sats * 1000);
  console.log(`invoice: ${sats} sats, hash ${inv.paymentHash}, expires ${new Date(inv.expiresAt * 1000).toISOString()}`);
  console.log(`  ${inv.invoice}`);
  console.log(`  amount, network and description hash check out`);

  if (!inv.verifyUrl) {
    console.log('verify: none. This provider can’t confirm payments; only a proof from the payer can.');
  } else {
    let state = await client.verify(inv.verifyUrl, inv.paymentHash);
    console.log(`verify: ${state.settled ? 'paid' : 'not paid yet'}`);
    if (wait) {
      console.log('Pay the invoice above from another wallet; asking every 2s…');
      while (!state.settled && Date.now() < inv.expiresAt * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        state = await client.verify(inv.verifyUrl, inv.paymentHash);
      }
      console.log(state.settled ? `paid, preimage ${state.preimage} matches the hash` : 'expired unpaid');
    }
  }
} catch (e) {
  console.error(e instanceof LnurlError ? `${e.code}: ${e.message}` : e);
  process.exitCode = 1;
}
