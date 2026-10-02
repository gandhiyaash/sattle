/**
 * Y1's check against a real wallet: get_info, mint an invoice, read it back.
 *
 *   npm run nwc:smoke -w @sattle/api            # 10 sats, then one lookup
 *   npm run nwc:smoke -w @sattle/api -- --wait  # keep looking until it's paid
 *
 * Reads NWC_URI from apps/api/.env. Never commit that string.
 */

import { NwcClient, preimageMatches } from '../nwc';

const uri = process.env.NWC_URI;
if (!uri) {
  console.error('Set NWC_URI in apps/api/.env (from the shared password manager).');
  process.exit(1);
}

const wait = process.argv.includes('--wait');
const sats = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 10);
const client = new NwcClient(uri);

try {
  console.log(`wallet ${client.walletPubkey.slice(0, 8)}… via ${client.relays.join(', ')}`);

  const info = await client.getInfo();
  console.log(`get_info: ${info.alias ?? '(no alias)'} on ${info.network ?? '?'}`);
  console.log(`  methods: ${info.methods.join(', ')}`);

  const inv = await client.makeInvoice({ amountMsat: sats * 1000, description: 'Sattle smoke test', expirySec: 600 });
  console.log(`make_invoice: ${sats} sats, hash ${inv.paymentHash}`);
  console.log(`  ${inv.invoice}`);

  let back = await client.lookupInvoice({ paymentHash: inv.paymentHash });
  console.log(`lookup_invoice: ${back.state}`);

  if (wait) {
    console.log('Pay the invoice above from another wallet; checking every 2s…');
    while (back.state === 'pending') {
      await new Promise((r) => setTimeout(r, 2000));
      back = await client.lookupInvoice({ paymentHash: inv.paymentHash });
    }
    console.log(`lookup_invoice: ${back.state}`);
    if (back.state === 'settled') {
      const ok = back.preimage ? preimageMatches(back.preimage, back.paymentHash) : false;
      console.log(`  preimage ${back.preimage ?? '(none sent)'} ${ok ? 'matches' : 'DOES NOT match'} the hash`);
    }
  }
} catch (e) {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exitCode = 1;
} finally {
  client.close();
}
