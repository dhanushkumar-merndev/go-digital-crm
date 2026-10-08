import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignmentModeLabel,
  assignmentModes,
  isAutomaticAssignmentMode,
} from '../../src/features/leads/assignment-mode';

const read = (path: string) => readFileSync(path, 'utf8');
const enumMigration = read('supabase/migrations/202610050001_least_assigned_mode_enum.sql');
const migration = read('supabase/migrations/202610050002_least_assigned_assignment.sql');
const executable = migration
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('LEAST_ASSIGNED team assignment mode', () => {
  it('adds the enum value before any function uses it', () => {
    // A new enum value is unusable inside the transaction that adds it.
    expect(enumMigration).toContain(
      "alter type public.assignment_mode add value if not exists 'LEAST_ASSIGNED'",
    );
    expect(enumMigration).not.toContain('begin;');
  });

  it('every database mode parses on the web', () => {
    const coreEnum = read('supabase/migrations/202608140001_core.sql').match(
      /create type public\.assignment_mode as enum \(([^)]*)\)/,
    )?.[1];
    const databaseModes = [...(coreEnum ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect([...databaseModes, 'LEAST_ASSIGNED'].sort()).toEqual([...assignmentModes].sort());
    for (const file of [
      'src/features/administration/branch-team-api.ts',
      'src/features/leads/lead-assignment-workspace-api.ts',
    ]) {
      expect(read(file)).toContain('z.enum(assignmentModes)');
      expect(read(file)).not.toContain("z.enum(['ROUND_ROBIN', 'MANUAL_ASSIGNMENT'])");
    }
  });

  it('labels the modes and treats only manual as person-chosen', () => {
    expect(assignmentModeLabel('LEAST_ASSIGNED')).toBe('Least Assigned');
    expect(assignmentModeLabel('ROUND_ROBIN')).toBe('Round Robin');
    expect(isAutomaticAssignmentMode('LEAST_ASSIGNED')).toBe(true);
    expect(isAutomaticAssignmentMode('ROUND_ROBIN')).toBe(true);
    expect(isAutomaticAssignmentMode('MANUAL_ASSIGNMENT')).toBe(false);
  });

  it('picks the lightest open book, tie-broken by rotation, under a team lock', () => {
    expect(executable).toContain(
      'create or replace function app_private.claim_least_assigned_member(',
    );
    expect(executable).toContain("and lead_row.lifecycle_status <> 'Lost'");
    expect(executable).toMatch(
      /order by candidate\.open_leads asc,\s+candidate\.last_assigned_at asc nulls first,\s+candidate\.joined_at asc,\s+candidate\.user_id/,
    );
    expect(executable).toMatch(/from public\.teams team_row[\s\S]*?for update;/);
    // Fresh intake only to Telecallers, qualified only to Sales Consultants.
    expect(executable).toContain("when assignment_kind = 'FRESH' then 'telecaller_bdc'");
    expect(executable).toContain("else 'sales_consultant'");
    expect(executable).toContain(
      'revoke all on function app_private.claim_least_assigned_member(uuid, uuid, text)',
    );
  });

  it('patches deployed functions instead of re-emitting old bodies', () => {
    for (const signature of [
      'public.create_lead(uuid,uuid,uuid,text,text,text,text,text,text,text)',
      'public.ingest_provider_lead(',
      'public.assign_lead(uuid,uuid,text,text)',
      'public.transfer_lead_to_sales(uuid,uuid,text)',
    ]) {
      expect(executable).toContain(`'${signature}`);
    }
    expect(executable).not.toContain('create or replace function public.create_lead(');
    expect(executable).not.toContain('create or replace function public.transfer_lead_to_sales(');
    // Every anchor must match an exact count or the migration stops.
    expect(executable).toContain("message = label || '_PATCH_TARGET_NOT_FOUND'");
  });

  it('records the rule that actually chose the assignee', () => {
    expect(executable).toContain(
      "else coalesce(team_mode, ''ROUND_ROBIN'') end::public.assignment_mode",
    );
    expect(executable).toContain(
      "''FRESH'', team_row.fresh_assignment_mode, ''Provider lead ingestion''",
    );
    expect(executable).toContain("when qualified_mode = ''ROUND_ROBIN'' then ''ROUND_ROBIN''");
    expect(executable).toContain("else ''LEAST_ASSIGNED''");
  });

  it('keeps the handoff recommendation in step with the automatic pick', () => {
    expect(executable).toContain(
      "order by case when qualified_mode = ''ROUND_ROBIN'' then 0 else candidate.open_leads end asc",
    );
    expect(executable).toContain(
      "order by case when qualified_mode = 'ROUND_ROBIN' then 0 else loaded_row.open_leads end asc",
    );
    expect(read('src/features/leads/lead-workspace-api.ts')).toContain(
      'assignment_mode: AssignmentMode;',
    );
  });

  it('escalates to AI voice for any automatic fresh assignment', () => {
    expect(executable).toContain("E'method in (''ROUND_ROBIN'', ''LEAST_ASSIGNED'') and '");
    expect(executable).toContain("'app_private.enqueue_ai_voice_after_assignment()'::regprocedure");
  });
});
