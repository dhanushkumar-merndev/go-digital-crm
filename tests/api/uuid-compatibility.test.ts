import { describe, expect, it } from 'vitest';
import { createUuid } from '../../src/lib/uuid';

describe('UUID compatibility', () => {
  it('always produces a version-4 UUID for client request identifiers', () => {
    expect(createUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
