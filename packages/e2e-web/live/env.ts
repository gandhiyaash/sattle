/**
 * Where the hosted app and API are, for the live check. Both come from the
 * environment (GitHub secrets in CI) and are never written into the repo.
 */

function url(name: string): string {
  const set = process.env[name]?.trim();
  if (!set) throw new Error(`${name} is not set: the live check needs the hosted app's and API's addresses.`);
  let parsed: URL;
  try {
    parsed = new URL(set);
  } catch {
    throw new Error(`${name} isn't a URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${name} must be https.`);
  return set.replace(/\/+$/, '');
}

export const LIVE_WEB_URL = url('LIVE_WEB_URL');
export const LIVE_API_URL = url('LIVE_API_URL');
