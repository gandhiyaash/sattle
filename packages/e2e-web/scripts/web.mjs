/**
 * The web app under test: exported from apps/mobile with the test servers'
 * addresses baked in, then served the way deploy/nginx.conf serves it, so a
 * deep link like /s/<token> loads index.html and /privacy loads privacy.html.
 *
 * Playwright starts this (playwright.config.ts) and waits for the port. Set
 * E2E_SKIP_EXPORT=1 to serve the last export as it is, for a quick local loop.
 */

import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const mobile = path.resolve(pkg, '../../apps/mobile');
const dist = path.join(pkg, '.dist');

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3900';
const webUrl = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:8900';
const port = Number(process.env.E2E_WEB_PORT ?? 8900);

// What the last export was built for. Served again only when it was built for these addresses.
const stamp = path.join(dist, '.e2e-built-for');
const wanted = JSON.stringify({ apiUrl, webUrl });
const reusable = existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted;

if (!(process.env.E2E_SKIP_EXPORT === '1' && reusable)) {
  rmSync(dist, { recursive: true, force: true });
  const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', dist], {
    cwd: mobile,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: '1',
      // These win over apps/mobile/.env, so a developer's settings can't leak into the build.
      EXPO_PUBLIC_USE_MOCK: 'false',
      EXPO_PUBLIC_API_URL: apiUrl,
      EXPO_PUBLIC_APP_URL: webUrl,
      EXPO_PUBLIC_APP_VERSION: 'e2e',
    },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  writeFileSync(stamp, wanted);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * nginx's `try_files $uri $uri.html /index.html`, kept inside dist. A bundle
 * under /_expo/static/ that isn't there is a 404, as nginx answers, not the
 * app's page with a 200 (undefined). Null for a path that escapes dist.
 */
function fileFor(url) {
  let clean;
  try {
    clean = decodeURIComponent(url.split('?')[0]);
  } catch {
    return null;
  }
  const target = path.normalize(path.join(dist, clean));
  if (!target.startsWith(dist)) return null;
  for (const candidate of [target, `${target}.html`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (clean.startsWith('/_expo/static/')) return undefined;
  return path.join(dist, 'index.html');
}

/**
 * The headers apps/mobile/deploy/nginx.conf sends with every answer, so a change
 * the policy would block in production (an inline script, an eval, a new host
 * the app talks to) fails here too. The API's address is the one baked into the
 * build. No Strict-Transport-Security: a browser ignores it over plain http.
 */
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    `font-src 'self' data:; connect-src 'self' ${apiUrl}; frame-ancestors 'none'; base-uri 'none'; ` +
    "form-action 'none'; object-src 'none'",
};

createServer((req, res) => {
  const file = fileFor(req.url ?? '/');
  if (file === null || file === undefined) {
    res.writeHead(file === null ? 403 : 404, HEADERS);
    res.end();
    return;
  }
  res.writeHead(200, { ...HEADERS, 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`e2e web app on ${webUrl}, API at ${apiUrl}`);
});
