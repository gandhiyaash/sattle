import { describe, expect, it } from 'vitest';

import { groupLinkPath, joinPath, parseGroupLinkToken } from './groupLinks';

describe('parseGroupLinkToken', () => {
  const token = 'q3J8xZ-0aB_cD4eF5gH6iJ';

  it('finds the token in a link, with or without the rest of the message', () => {
    expect(parseGroupLinkToken(`https://sattle.example${joinPath(token)}`)).toBe(token);
    expect(parseGroupLinkToken(`Aman, join "Goa trip" on Sattle: https://sattle.example/join/${token}`)).toBe(token);
    expect(parseGroupLinkToken(`  https://sattle.example/join/${token}/  `)).toBe(token);
  });

  it('finds it in the group link as it is shared, which is the same token', () => {
    expect(parseGroupLinkToken(`https://sattle.example${groupLinkPath(token)}`)).toBe(token);
    expect(parseGroupLinkToken(`Here’s what we’ve split in "Goa trip": https://sattle.example/g/${token}`)).toBe(token);
  });

  it('takes a token pasted on its own', () => {
    expect(parseGroupLinkToken(token)).toBe(token);
  });

  it('gives up on anything else', () => {
    expect(parseGroupLinkToken('')).toBeNull();
    expect(parseGroupLinkToken('hello there')).toBeNull();
    expect(parseGroupLinkToken('https://sattle.example/s/abc')).toBeNull();
  });
});
