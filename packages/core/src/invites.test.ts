import { describe, expect, it } from 'vitest';

import { groupLinkPath } from './groupLinks';
import { invitePath, parseInviteToken } from './invites';

describe('parseInviteToken', () => {
  const token = 'q3J8xZ-0aB_cD4eF5gH6iJ';

  it('finds the token in a link, with or without the rest of the message', () => {
    expect(parseInviteToken(`https://sattle.example${invitePath(token)}`)).toBe(token);
    expect(parseInviteToken(`Aman, join "Goa trip" on Sattle: https://sattle.example/join/${token}`)).toBe(token);
    expect(parseInviteToken(`  https://sattle.example/join/${token}/  `)).toBe(token);
  });

  it('finds it in the group link as it is shared, which is the same token', () => {
    expect(parseInviteToken(`https://sattle.example${groupLinkPath(token)}`)).toBe(token);
    expect(parseInviteToken(`Here’s what we’ve split in "Goa trip": https://sattle.example/g/${token}`)).toBe(token);
  });

  it('takes a token pasted on its own', () => {
    expect(parseInviteToken(token)).toBe(token);
  });

  it('gives up on anything else', () => {
    expect(parseInviteToken('')).toBeNull();
    expect(parseInviteToken('hello there')).toBeNull();
    expect(parseInviteToken('https://sattle.example/s/abc')).toBeNull();
  });
});
