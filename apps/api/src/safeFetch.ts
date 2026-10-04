/**
 * Fetching a URL a user typed. A Lightning address names a domain, and the
 * server goes and asks it for an invoice, so whoever types the address
 * chooses where the server connects. Unchecked, that's a way to make it
 * talk to things only it can reach: a cloud metadata endpoint, the database
 * port, an admin page on localhost.
 *
 * So, for every request:
 *   - https only, on the default port
 *   - the name is resolved once, every address it resolves to is checked,
 *     and the connection goes to the address that was checked. Checking and
 *     then connecting by name would let DNS answer differently the second
 *     time (rebinding).
 *   - redirects are refused, not followed: each hop would need the same
 *     checks, and LNURL servers have no reason to send one
 *   - one deadline for the whole request, body included, and a size cap
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export type SafeFetchErrorCode = 'NOT_ALLOWED' | 'BLOCKED_ADDRESS' | 'REDIRECT' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK' | 'BAD_JSON';

export class SafeFetchError extends Error {
  override name = 'SafeFetchError';
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Seams for tests: a plain-http server on loopback, and a fake DNS. Never set these in the app. */
export interface SafeFetchTestDeps {
  request?: typeof httpsRequest;
  protocol?: 'https:' | 'http:';
  lookup?: (host: string, cb: (err: Error | null, addresses: LookupAddress[]) => void) => void;
  isAllowed?: (address: string) => boolean;
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/** GET a JSON document from a user-supplied URL. Non-2xx statuses resolve; the caller reads them. */
export function getJson(url: string, opts: SafeFetchOptions = {}, deps: SafeFetchTestDeps = {}): Promise<JsonResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const protocol = deps.protocol ?? 'https:';
  const allowed = deps.isAllowed ?? isPublicAddress;
  const resolve = deps.lookup ?? ((host, cb) => dnsLookup(host, { all: true, verbatim: true }, cb));

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new SafeFetchError('NOT_ALLOWED', 'Not a URL.'));
  }
  if (target.protocol !== protocol) return Promise.reject(new SafeFetchError('NOT_ALLOWED', 'Only https is allowed.'));
  if (target.port !== '' && protocol === 'https:') return Promise.reject(new SafeFetchError('NOT_ALLOWED', 'Only the default port is allowed.'));
  if (target.username || target.password) return Promise.reject(new SafeFetchError('NOT_ALLOWED', 'Credentials in the URL aren’t allowed.'));

  const host = target.hostname.replace(/^\[|\]$/g, '');
  // Node skips the lookup for an IP literal, so it's checked here instead.
  if (isIP(host) && !allowed(host)) {
    return Promise.reject(new SafeFetchError('BLOCKED_ADDRESS', 'That address is private.'));
  }

  /** Resolves once and hands the socket only an address that passed. */
  const checkedLookup: LookupFunction = (hostname, options, cb) => {
    resolve(hostname, (err, addresses) => {
      if (err) return cb(err, '', 0);
      if (addresses.length === 0) return cb(new SafeFetchError('NETWORK', 'The name didn’t resolve.'), '', 0);
      // Every address must pass, not just the one we'd pick: otherwise
      // a name with one public and one private answer slips through.
      const bad = addresses.find((a) => !allowed(a.address));
      if (bad) return cb(new SafeFetchError('BLOCKED_ADDRESS', 'That address is private.'), '', 0);
      const wanted = options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
      const first = wanted[0] ?? addresses[0];
      if (options.all) return (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, wanted.length ? wanted : addresses);
      cb(null, first.address, first.family);
    });
  };

  return new Promise<JsonResponse>((resolvePromise, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (e: SafeFetchError) => finish(() => {
      req.destroy();
      reject(e);
    });

    const options: RequestOptions = {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'Sattle' },
      lookup: checkedLookup,
      // No connection reuse: a pooled socket would skip the lookup check.
      agent: false,
    };
    const req = (deps.request ?? httpsRequest)(target, options, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return fail(new SafeFetchError('REDIRECT', 'The server sent a redirect, which isn’t followed.'));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        return fail(new SafeFetchError('TOO_LARGE', 'The answer is too large.'));
      }

      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) return fail(new SafeFetchError('TOO_LARGE', 'The answer is too large.'));
        chunks.push(chunk);
      });
      res.on('end', () =>
        finish(() => {
          try {
            resolvePromise({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            reject(new SafeFetchError('BAD_JSON', 'The answer isn’t JSON.'));
          }
        })
      );
      res.on('error', () => fail(new SafeFetchError('NETWORK', 'The connection dropped.')));
    });

    const timer = setTimeout(() => fail(new SafeFetchError('TIMEOUT', 'The server didn’t answer in time.')), timeoutMs);
    req.on('error', (e) => fail(e instanceof SafeFetchError ? e : new SafeFetchError('NETWORK', 'Couldn’t reach the server.')));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Which addresses are public
// ---------------------------------------------------------------------------

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** An IPv4 address hidden in an IPv6 one, which must pass the IPv4 rules. */
function embeddedIpv4(address: string) {
  const v = address.toLowerCase();
  // ::ffff:a.b.c.d (mapped), 64:ff9b::a.b.c.d (NAT64), ::a.b.c.d (compatible)
  const dotted = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) return dotted[1];
  const hexed = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hexed) {
    const hi = parseInt(hexed[1], 16);
    const lo = parseInt(hexed[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return undefined;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = embeddedIpv4(address);
  if (v4) return isPublicAddress(v4);
  // Any other address inside ::ffff:0:0/96 or 64:ff9b::/96 is malformed for
  // our purposes; refuse rather than guess.
  if (/^(::ffff:|64:ff9b::)/i.test(address)) return false;
  return !blocked.check(address, 'ipv6');
}
