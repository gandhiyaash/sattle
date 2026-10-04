/**
 * Rebuilds a group from Nostr alone: no Sattle server, no database. Pass the
 * backup key from the group screen (Copy backup key):
 *
 *   npm run ledger:verify -w @sattle/api -- 'sattle-ledger://…'
 *   npm run ledger:verify -w @sattle/api -- 'sattle-ledger://…' --relay wss://other.relay
 *
 * Fetches every entry signed by the server's key and tagged for the group,
 * checks signatures and the chain, decrypts, and prints the balances.
 */

import { computeBalances, formatFiat, simplifyDebts } from '@sattle/core';
import { SimplePool } from 'nostr-tools/pool';

import { LEDGER_KIND, groupTag, parseBackupUri, readLedger } from '../nostrLedger';

const args = process.argv.slice(2);
const uri = args.find((a) => a.startsWith('sattle-ledger://'));
if (!uri) {
  console.error('Pass the group’s backup key: npm run ledger:verify -w @sattle/api -- \'sattle-ledger://…\'');
  process.exit(1);
}

const access = parseBackupUri(uri);
const extra = args.flatMap((a, i) => (a === '--relay' && args[i + 1] ? [args[i + 1]] : []));
const relays = [...new Set([...access.relays, ...extra])];
if (relays.length === 0) {
  console.error('The key names no relay. Add one with --relay wss://…');
  process.exit(1);
}

const pool = new SimplePool();
try {
  console.log(`Reading from ${relays.join(', ')}…`);
  const events = await pool.querySync(
    relays,
    { kinds: [LEDGER_KIND], authors: [access.pubkey], '#h': [groupTag(access.key)] },
    { maxWait: 8000 }
  );
  const read = readLedger(events, access);

  if (!read.group) {
    console.log('No entries found for this group on those relays.');
    process.exitCode = 1;
  } else {
    const { name, currency, id } = read.group;
    const nameOf = (mid: string) => read.members.find((m) => m.id === mid)?.displayName ?? mid;
    const fiat = (n: number) => formatFiat(n, currency);

    const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
    console.log(
      `\n${name}: ${n(read.entries, 'entry', 'entries')}, ${n(read.expenses.length, 'expense')}, ${n(read.settlements.length, 'settlement')}`
    );
    console.log(read.problems.length === 0 ? 'Chain intact. Every entry signed by the server.' : 'Problems:');
    for (const p of read.problems) console.log(`  ! ${p}`);

    const balances = computeBalances(read.members.map((m) => m.id), read.expenses, read.settlements);
    console.log('\nBalances');
    for (const b of balances) console.log(`  ${nameOf(b.memberId).padEnd(16)} ${b.net >= 0 ? '+' : '−'}${fiat(Math.abs(b.net))}`);

    const debts = simplifyDebts(id, balances);
    console.log('\nTo settle up');
    if (debts.length === 0) console.log('  Nothing. Everyone is square.');
    for (const d of debts) console.log(`  ${nameOf(d.fromMemberId)} pays ${nameOf(d.toMemberId)} ${fiat(d.amount)}`);

    if (read.problems.length > 0) process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  pool.close(relays);
}
