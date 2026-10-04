import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient receive address', () => {
  it('starts empty, saves a cleaned-up address, and clears', async () => {
    const c = client();
    expect(await c.getReceiveAddress()).toEqual({ address: null });
    expect(await c.setReceiveAddress(' Yash@Blink.SV ')).toEqual({ address: 'yash@blink.sv' });
    expect(await c.getReceiveAddress()).toEqual({ address: 'yash@blink.sv' });
    expect(await c.clearReceiveAddress()).toEqual({ address: null });
  });

  it('shows the errors: not an address, and (offline.example) one that doesn’t answer', async () => {
    const c = client();
    await expect(c.setReceiveAddress('lnbc10n1abc')).rejects.toMatchObject({ code: 'invalid_address' });
    await expect(c.setReceiveAddress('me@offline.example')).rejects.toMatchObject({ code: 'network' });
    expect(await c.getReceiveAddress()).toEqual({ address: null });
  });
});
