import { describe, expect, it } from 'vitest';

import { backupUri, groupTag, ledgerFilter, parseBackupUri } from './nostrLedger';

const pubkey = 'cd'.repeat(32);
const key = 'ab'.repeat(32);

describe('groupTag', () => {
  it('is the tag already on the relays: sha256 of sattle-ledger:<key>, in hex', () => {
    // Worked out with node:crypto, which the server used before this moved here.
    expect(groupTag(key)).toBe('6da276faad465d6d74f037d9f148bf72ceaa70ab96338767e49e0a15f99b8817');
  });
});

describe('parseBackupUri', () => {
  it('reads back what backupUri writes', () => {
    const access = { pubkey, key, relays: ['wss://relay.damus.io', 'wss://nos.lol'] };
    expect(parseBackupUri(backupUri(access))).toEqual(access);
  });

  it('forgives the whitespace and capitals a paste brings', () => {
    expect(parseBackupUri(`  sattle-ledger://${pubkey.toUpperCase()}?key=${key.toUpperCase()}\n`)).toEqual({
      pubkey,
      key,
      relays: [],
    });
  });

  it('says what is wrong with something else', () => {
    expect(() => parseBackupUri('https://sattle.example/g/abc')).toThrow(/starts with sattle-ledger:\/\//);
    expect(() => parseBackupUri(`sattle-ledger://${pubkey}?key=short`)).toThrow(/group key/);
  });
});

describe('ledgerFilter', () => {
  it('asks for the group’s entries, signed by the server', () => {
    expect(ledgerFilter({ pubkey, key })).toEqual({ kinds: [4733], authors: [pubkey], '#h': [groupTag(key)] });
  });
});
