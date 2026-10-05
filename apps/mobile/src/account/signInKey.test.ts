import { describe, expect, it } from 'vitest';

import { parseSignInKey, signInKey } from './signInKey';

const token = 'q3J8xZ-0aB_cD4eF5gH6iJq3J8xZ-0aB_cD4eF5gH6i';

describe('parseSignInKey', () => {
  it('reads back what signInKey writes, with the whitespace a paste brings', () => {
    expect(parseSignInKey(signInKey(token))).toBe(token);
    expect(parseSignInKey(`  ${signInKey(token)}\n`)).toBe(token);
  });

  it('takes the bare token', () => {
    expect(parseSignInKey(token)).toBe(token);
  });

  it('turns away anything else, before it goes to the server', () => {
    expect(parseSignInKey('')).toBeNull();
    expect(parseSignInKey(`sattle-ledger://${'a'.repeat(64)}?key=${'b'.repeat(64)}`)).toBeNull();
    expect(parseSignInKey('https://sattle.example/g/q3J8xZ-0aB_cD4eF5gH6iJ')).toBeNull();
    expect(parseSignInKey(signInKey(`${token}x`))).toBeNull();
  });
});
