import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The lead-flow workspaces, keyed by the query variable their table renders.
const workspaces = {
  'src/features/leads/lead-workspace.tsx': 'workspace',
  'src/features/work/workspace.tsx': 'workspace',
  'src/features/test-drives/test-drive-workspace.tsx': 'workspace',
  'src/features/sales/sales-document-workspace.tsx': 'workspace',
  'src/features/calls/call-workspace.tsx': 'workspace',
  'src/features/inventory/inventory-workspace.tsx': 'page',
  'src/features/operations/operational-case-workspace.tsx': 'workspace',
} as const;

describe('a failed background refresh keeps the rows on screen', () => {
  for (const [file, query] of Object.entries(workspaces)) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');

    it(`${file} shows a refresh notice instead of blanking the table`, () => {
      expect(source).toContain(
        "import { RefreshFailedNotice } from '@/components/shared/refresh-failed-notice';",
      );
      expect(source).toMatch(new RegExp(`<RefreshFailedNotice[^>]*${query}\\.isError`, 's'));
    });

    it(`${file} keeps its full error state for a page that never loaded`, () => {
      // `x.isError ||` on its own in a page-level gate replaces loaded rows
      // with the error card whenever a single refetch fails.
      expect(source).not.toMatch(new RegExp(`\\(\\s*${query}\\.isError\\s*\\|\\|`));
      expect(source).not.toMatch(new RegExp(`\\|\\|\\s*${query}\\.isError\\s*\\)`));
      expect(source).not.toMatch(new RegExp(`\\|\\|\\s*${query}\\.isError\\s*\\|\\|`));
    });
  }
});
