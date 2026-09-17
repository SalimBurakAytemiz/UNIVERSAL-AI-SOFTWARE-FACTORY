import { describe, expect, it } from 'vitest';
import { currentFactoryName } from './index.js';

describe('foundation-kernel bootstrap', () => {
  it('reports the canonical factory name', () => {
    expect(currentFactoryName()).toBe('UNIVERSAL-AI-SOFTWARE-FACTORY');
  });
});
