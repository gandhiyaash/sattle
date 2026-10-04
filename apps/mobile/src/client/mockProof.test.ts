import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });
const PROOF = 'ab'.repeat(32);

describe('MockClient proofs', () => {
  it('confirms the guest’s payment, and is fine to send twice', async () => {
    const c = client();
    const view = await c.submitGuestProof('demo', ` ${PROOF.toUpperCase()} `);
    expect(view.settlement).toMatchObject({ id: 'demo', status: 'confirmed', preimage: PROOF });
    expect((await c.submitGuestProof('demo', PROOF)).settlement?.status).toBe('confirmed');
  });

  it('confirms from the app too', async () => {
    expect(await client().submitProof('demo', PROOF)).toMatchObject({ status: 'confirmed', preimage: PROOF });
  });

  it('shows the errors: not a proof, and (64 zeros) a proof of another payment', async () => {
    const c = client();
    await expect(c.submitGuestProof('demo', 'abc')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.submitGuestProof('demo', '0'.repeat(64))).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'That proof is for a different payment.',
    });
    expect((await c.getGuestView('demo')).settlement?.status).toBe('awaiting_payment');
  });
});
