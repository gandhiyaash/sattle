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
