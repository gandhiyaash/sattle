import { describe, expect, it } from 'vitest';

import { productionProblems, productionWarnings } from './env';

describe('productionProblems', () => {
  it('allows the demo settings outside production', () => {
    expect(productionProblems({ SEED: 'true', DEMO_USER_ID: 'u-yash' })).toEqual([]);
    expect(productionProblems({ NODE_ENV: 'development', SEED: 'true', DEMO_USER_ID: 'u-yash' })).toEqual([]);
  });

  it('names each demo setting a production server has', () => {
    const problems = productionProblems({ NODE_ENV: 'production', SEED: 'true', DEMO_USER_ID: 'u-yash' });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('SEED=true');
    expect(problems[1]).toContain('DEMO_USER_ID=u-yash');
  });

  it('accepts a production server without them, or with them switched off', () => {
    expect(productionProblems({ NODE_ENV: 'production' })).toEqual([]);
    expect(productionProblems({ NODE_ENV: 'production', SEED: 'false', DEMO_USER_ID: '' })).toEqual([]);
  });

  it('starts with simulated payments in production, but warns unless asked for on purpose', () => {
    for (const PAYMENTS of [undefined, '', 'sim']) {
      expect(productionProblems({ NODE_ENV: 'production', PAYMENTS })).toEqual([]);
      const warnings = productionWarnings({ NODE_ENV: 'production', PAYMENTS });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('PAYMENTS=nwc');
    }
    expect(productionWarnings({ NODE_ENV: 'production', PAYMENTS: 'nwc' })).toEqual([]);
    expect(productionWarnings({ NODE_ENV: 'production', ALLOW_SIMULATED_PAYMENTS: 'true' })).toEqual([]);
    expect(productionWarnings({ NODE_ENV: 'production', ALLOW_SIMULATED_PAYMENTS: 'yes' })).toHaveLength(1);
  });

  it('lets development simulate without saying so', () => {
    expect(productionWarnings({})).toEqual([]);
  });
});
