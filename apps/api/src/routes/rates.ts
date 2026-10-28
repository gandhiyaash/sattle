/**
 * What a currency is worth in a group's, for an expense paid in it (ForeignAmount).
 *
 * GET /rates/convert?from=THB&to=INR → ConversionRate: what one baht is in paise
 * now. It goes through each currency's price of a bitcoin (conversionRate),
 * from the same sources payments are quoted from. The app shows it before the
 * expense is saved, and the expense keeps it: what anyone owes never moves
 * with the market afterwards.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, conversionRate, isBitcoin, type ConversionRate } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { parse } from '../http';
import { RateUnavailableError } from '../rates';

const Query = z.object({
  from: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  to: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
});

export function rateRoutes({ rates }: Ctx) {
  const r = new Hono<AppEnv>();

  r.get('/rates/convert', async (c) => {
    const { from, to } = parse(Query, c.req.query());
    if (from === to) throw new SattleError('invalid_input', 'Those are the same currency.');
    if (!rates) throw new SattleError('network', 'Exchange rates aren’t available here.');
    try {
      const [fromPrice, toPrice] = await Promise.all([rates.rate(from), isBitcoin(to) ? undefined : rates.rate(to)]);
      const body: ConversionRate = {
        from,
        to,
        rate: conversionRate(from, fromPrice.rateFiatPerBtc, to, toPrice?.rateFiatPerBtc),
        provider: fromPrice.provider,
        fetchedAt: fromPrice.fetchedAt,
      };
      return c.json(body);
    } catch (e) {
      if (e instanceof RateUnavailableError || e instanceof Error) {
        throw new SattleError('network', `Couldn’t get a rate for ${from} right now. Try again, or enter it in ${to}.`);
      }
      throw e;
    }
  });

  return r;
}
