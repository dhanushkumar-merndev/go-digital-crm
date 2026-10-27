import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/202610270193_followup_overdue_status_normalize.sql'),
  'utf8',
);

describe('follow-up overdue is derived, never stored', () => {
  it('reopens stored OVERDUE follow-ups without moving their due time', () => {
    expect(migration).toContain("set status = 'OPEN',");
    expect(migration).toContain("where status = 'OVERDUE';");
    expect(migration).not.toMatch(/set[^;]*due_at/);
  });

  it('no longer allows OVERDUE as a stored status', () => {
    expect(migration).toContain(
      "check (status = any (array['OPEN'::text, 'COMPLETED'::text, 'CANCELLED'::text]))",
    );
  });
});
