import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync('src/features/leads/lead-workspace.tsx', 'utf8');

describe('Telecaller lead filter preset', () => {
  it('offers only Telecaller-relevant lifecycle stages', () => {
    expect(workspace).toContain(
      "role === 'telecaller'\n      ? ['all', 'New', 'Contacted', 'Transferred to Sales', 'Lost']",
    );
  });

  it('shows the complete canonical source set plus any scoped source returned by the server', () => {
    expect(workspace).toContain('new Set([...leadSources, ...data.filters.sources])');
    expect(workspace).toContain('sourceOptions.map((source)');
    for (const source of [
      'Facebook',
      'Instagram',
      'Google Ads',
      'Website',
      'WhatsApp Business',
      'CarWale',
      'CarDekho',
      'Justdial',
      'IndiaMART',
      'Manual',
      'Other',
    ])
      expect(workspace).toContain(`'${source}'`);
  });
});
