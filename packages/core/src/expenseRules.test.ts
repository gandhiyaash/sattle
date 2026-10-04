import { describe, expect, it } from 'vitest';

import { canChangeExpense } from './expenseRules';

describe('canChangeExpense', () => {
  it('is the payer’s call once they have joined', () => {
    expect(canChangeExpense({ claimedByUserId: 'u-riya' }, 'u-riya')).toBe(true);
    expect(canChangeExpense({ claimedByUserId: 'u-riya' }, 'u-kabir')).toBe(false);
  });

  it('is anyone’s call when a ghost paid, since there is nobody to ask', () => {
    expect(canChangeExpense({}, 'u-kabir')).toBe(true);
    expect(canChangeExpense(undefined, 'u-kabir')).toBe(true);
  });
});
