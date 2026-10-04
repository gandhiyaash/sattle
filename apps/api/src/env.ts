/**
 * Settings a production server must never run with. Both are for local
 * development: SEED loads the demo groups into an empty database, and
 * DEMO_USER_ID signs in every request without a token as one user. On a
 * live server that means strangers share an account full of fake data.
 *
 * The systemd unit sets NODE_ENV=production; `npm run dev` doesn't.
 */
export function productionProblems(env: Record<string, string | undefined>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (env.SEED === 'true') problems.push('SEED=true would load the demo groups into the live database.');
  if (env.DEMO_USER_ID) {
    problems.push(`DEMO_USER_ID=${env.DEMO_USER_ID} would sign in every request without a token as that user.`);
  }
  return problems;
}

/**
 * Settings a production server can run with but probably shouldn't. PAYMENTS
 * defaults to the simulator, where Pay goes through and balances move but no
 * money does. A server says on purpose that it simulates, for a public demo,
 * with ALLOW_SIMULATED_PAYMENTS=true.
 *
 * A warning rather than a refusal for now, so deploying this can't take the
 * live API down before its .env has PAYMENTS=nwc. Once it does, this can move
 * into productionProblems.
 */
export function productionWarnings(env: Record<string, string | undefined>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  if (env.PAYMENTS === 'nwc' || env.ALLOW_SIMULATED_PAYMENTS === 'true') return [];
  return [
    'PAYMENTS is not nwc, so settling up moves balances without moving money. Set PAYMENTS=nwc, or ALLOW_SIMULATED_PAYMENTS=true for a demo server.',
  ];
}
