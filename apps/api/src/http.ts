import { z } from 'zod';

import { SattleError, type SattleErrorCode } from '@sattle/core';

export const STATUS: Record<SattleErrorCode, 400 | 401 | 404 | 409 | 410 | 500 | 501 | 502 | 503> = {
  not_found: 404,
  invalid_expense: 400,
  invalid_address: 400,
  invalid_input: 400,
  invalid_wallet: 400,
  member_cannot_receive: 409,
  conflict: 409,
  link_expired: 410,
  unauthorized: 401,
  payment_failed: 502,
  network: 503,
  not_implemented: 501,
  internal: 500,
};

/** Validates a body, turning the first zod issue into a SattleError. */
export function parse<T>(schema: z.ZodType<T>, body: unknown, code: SattleErrorCode = 'invalid_input'): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new SattleError(code, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

export const minor = z.number().int().positive();

export function notImplemented(what: string): never {
  throw new SattleError('not_implemented', `${what} isn’t built yet.`);
}
