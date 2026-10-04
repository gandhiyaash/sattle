import { describe, expect, it } from 'vitest';

import { productionProblems } from './env';

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
});
