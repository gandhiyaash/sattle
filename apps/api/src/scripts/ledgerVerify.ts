/**
 * Rebuilds a group from Nostr alone: no Sattle server, no database. Run it,
 * then paste the backup key from the group screen (Copy backup key) when
 * asked. Typing doesn't echo:
 *
 *   npm run ledger:verify -w @sattle/api
 *   npm run ledger:verify -w @sattle/api -- --relay wss://other.relay
 *
 * The key decrypts the group's whole history on public relays, so it never
 * goes on the command line, where npm prints it and the shell keeps it. It
 * can also come from SATTLE_LEDGER_BACKUP or a pipe, for scripts.
 *
 * Fetches every entry signed by the server's key and tagged for the group,
 * checks signatures and the chain, decrypts, and prints the balances.
 */

import { computeBalances, formatFiat, simplifyDebts } from '@sattle/core';
import { npubEncode } from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';

import { LEDGER_KIND, groupTag, parseBackupUri, readLedger, type LedgerAccess } from '../nostrLedger';

const args = process.argv.slice(2);
if (args.some((a) => a.includes('sattle-ledger:'))) {
  console.error(
    'Don’t put the backup key on the command line: npm prints it and your shell history keeps it.\n' +
      'Run `npm run ledger:verify -w @sattle/api` and paste the key when asked.'
  );
  process.exit(1);
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let input = '';
  return new Promise((resolve) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          return resolve(input);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') input = input.slice(0, -1);
        else input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readBackupKey(): Promise<string> {
  if (process.env.SATTLE_LEDGER_BACKUP) return process.env.SATTLE_LEDGER_BACKUP;
  if (!process.stdin.isTTY) {
    let piped = '';
    for await (const chunk of process.stdin) piped += chunk;
    return piped;
  }
  return promptHidden('Paste the group’s backup key (it won’t show): ');
}

let access: LedgerAccess;
try {
  // Terminals can wrap a paste in escape codes; the key itself is plain ASCII.
  const key = (await readBackupKey()).replace(/\x1b\[[0-9;]*~/g, '').trim();
  access = parseBackupUri(key);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
console.log(`Key accepted. Entries must be signed by ${npubEncode(access.pubkey)}.`);

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
