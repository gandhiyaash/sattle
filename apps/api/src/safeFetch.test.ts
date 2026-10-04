import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { getJson, isPublicAddress, SafeFetchError, type SafeFetchTestDeps } from './safeFetch';

describe('isPublicAddress', () => {
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '104.16.0.1',
    '2606:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:1.1.1.1',
  ])('lets %s through', (a) => expect(isPublicAddress(a)).toBe(true));

  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', // loopback, mapped into IPv6
    '::ffff:7f00:1', // the same, written in hex
    '::ffff:a9fe:a9fe', // metadata, in hex
    '64:ff9b::10.0.0.1', // private, through NAT64
    'not an address',
  ])('blocks %s', (a) => expect(isPublicAddress(a)).toBe(false));
});

describe('getJson refuses before connecting', () => {
  const refused = async (url: string, deps: SafeFetchTestDeps = {}) => {
    const e = await getJson(url, {}, deps).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SafeFetchError);
    return (e as SafeFetchError).code;
  };
  const dns = (answers: Record<string, string[]>): SafeFetchTestDeps['lookup'] => (host, cb) =>
    cb(null, (answers[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('anything but https on the default port, or with credentials', async () => {
    expect(await refused('http://example.com/.well-known/lnurlp/a')).toBe('NOT_ALLOWED');
    expect(await refused('https://example.com:8443/x')).toBe('NOT_ALLOWED');
    expect(await refused('https://user:pw@example.com/x')).toBe('NOT_ALLOWED');
    expect(await refused('file:///etc/passwd')).toBe('NOT_ALLOWED');
    expect(await refused('not a url')).toBe('NOT_ALLOWED');
  });

  it('a private IP written into the URL', async () => {
    expect(await refused('https://169.254.169.254/latest/meta-data')).toBe('BLOCKED_ADDRESS');
    expect(await refused('https://[::1]/x')).toBe('BLOCKED_ADDRESS');
    expect(await refused('https://127.0.0.1/x')).toBe('BLOCKED_ADDRESS');
  });

  it('a name that resolves to a private address', async () => {
    expect(await refused('https://evil.example/x', { lookup: dns({ 'evil.example': ['10.0.0.5'] }) })).toBe('BLOCKED_ADDRESS');
    expect(await refused('https://evil.example/x', { lookup: dns({ 'evil.example': ['::ffff:127.0.0.1'] }) })).toBe('BLOCKED_ADDRESS');
  });

  it('a name with one public and one private answer', async () => {
    const lookup = dns({ 'evil.example': ['1.1.1.1', '127.0.0.1'] });
    expect(await refused('https://evil.example/x', { lookup })).toBe('BLOCKED_ADDRESS');
  });
});

describe('getJson against a server', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  /** A loopback http server reached as lnurl.test, with the address checks swapped out. */
  async function serve(handle: (res: ServerResponse, path: string) => void) {
    server = createServer((req, res) => handle(res, req.url ?? ''));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const deps: SafeFetchTestDeps = {
      request: httpRequest as unknown as SafeFetchTestDeps['request'],
      protocol: 'http:',
      isAllowed: () => true,
      lookup: (host, cb) =>
        host === 'lnurl.test' ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(new Error('ENOTFOUND'), []),
    };
    return (path: string, opts = {}) => getJson(`http://lnurl.test:${port}${path}`, opts, deps);
  }

  it('returns the status and parsed body, error statuses included', async () => {
    const get = await serve((res, path) => {
      res.writeHead(path === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(path === '/missing' ? { status: 'ERROR', reason: 'no such user' } : { tag: 'payRequest' }));
    });
    expect(await get('/.well-known/lnurlp/yash')).toEqual({ status: 200, body: { tag: 'payRequest' } });
    expect(await get('/missing')).toEqual({ status: 404, body: { status: 'ERROR', reason: 'no such user' } });
  });

  it('refuses a redirect instead of following it', async () => {
    const get = await serve((res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await expect(get('/x')).rejects.toMatchObject({ code: 'REDIRECT' });
  });

  it('stops reading past the size cap, declared or not', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(2_000) });
    const get = await serve((res, path) => {
      if (path === '/declared') {
        res.writeHead(200, { 'content-length': Buffer.byteLength(big) });
        res.end(big);
      } else {
        res.writeHead(200); // chunked, no length
        res.write(big.slice(0, 1_000));
        res.end(big.slice(1_000));
      }
    });
    await expect(get('/declared', { maxBytes: 1_024 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(get('/chunked', { maxBytes: 1_024 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect((await get('/declared', { maxBytes: 4_096 })).status).toBe(200);
  });

  it('gives up at the deadline, even mid-body', async () => {
    const get = await serve((res, path) => {
      if (path === '/slow-body') {
        res.writeHead(200);
        res.write('{"tag":'); // and never finishes
      }
      // /silent: never answers at all
    });
    await expect(get('/silent', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(get('/slow-body', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('says so when the answer isn’t JSON', async () => {
    const get = await serve((res) => res.end('<html>hello</html>'));
    await expect(get('/x')).rejects.toMatchObject({ code: 'BAD_JSON' });
  });
});
