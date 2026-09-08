import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/202609080007_followup_active_lead_visibility.sql',
  'utf8',
);
const org = randomUUID();
const user = randomUUID();
const branch = randomUUID();
const liveLead = randomUUID();
const deletedLead = randomUUID();
let db: PGlite;

function definition(file: string, name: string, renamed = name) {
  const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
  const start = sql.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  return sql.slice(start, sql.indexOf('$$;', start) + 3).replace(name, renamed);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema app_private;
    create function app_private.normalize_phone_digits(text) returns text language sql as $$ select regexp_replace($1, '[^0-9]', '', 'g') $$;
    create table leads(id uuid primary key, organization_id uuid, assigned_user_id uuid, deleted_at timestamptz, customer_name text, phone text, normalized_phone text, interested_model text, source text, temperature text);
    create table customers(id uuid, organization_id uuid, full_name text, primary_phone text, normalized_name text, normalized_phone text, deleted_at timestamptz);
    create table branches(id uuid, organization_id uuid, name text);
    create table teams(id uuid, organization_id uuid, branch_id uuid, name text);
    create table profiles(id uuid, organization_id uuid, full_name text);
    create table followups(id uuid primary key default gen_random_uuid(), organization_id uuid, version bigint default 1, lead_id uuid, customer_id uuid, reason text default 'Confirm visit', priority text default 'NORMAL', due_at timestamptz default now() - interval '1 day', status text default 'OPEN', assigned_user_id uuid, created_by uuid, branch_id uuid, team_id uuid, completed_at timestamptz, cancelled_at timestamptz, updated_at timestamptz default now());
  `);
  const funcs = [
    [
      '202609040008_telecaller_followup_task_fast_path.sql',
      'app_private.get_telecaller_followup_workspace_filtered_page',
    ],
    [
      '202608310001_fix_followup_filtered_page_timeout.sql',
      'app_private.get_sales_consultant_followup_workspace_filtered_page',
    ],
    [
      '202608310001_fix_followup_filtered_page_timeout.sql',
      'public.get_followup_workspace_filtered_page',
    ],
    [
      '202608290001_followup_workspace_owner_scope_and_tab_counts.sql',
      'app_private.get_sales_consultant_followup_workspace_page',
    ],
    [
      '202608290001_followup_workspace_owner_scope_and_tab_counts.sql',
      'public.get_followup_workspace_page_legacy',
    ],
    [
      '202608220004_sales_consultant_work_drive_task_hot_paths.sql',
      'app_private.get_sales_consultant_followup_calendar',
    ],
    [
      '202608200005_followup_calendar.sql',
      'public.get_followup_calendar',
      'public.get_followup_calendar_legacy',
    ],
  ];
  for (const [file, name, renamed] of funcs) await db.exec(definition(file!, name!, renamed));
  await db.query('insert into branches values ($1,$2,$3)', [branch, org, 'Test branch']);
  await db.query('insert into profiles values ($1,$2,$3)', [user, org, 'Telecaller']);
  await db.query(
    "insert into leads(id, organization_id, assigned_user_id, customer_name, deleted_at) values ($1,$3,$4,'Active enquiry',null),($2,$3,$4,'Deleted enquiry',now())",
    [liveLead, deletedLead, org, user],
  );
  for (const lead of [liveLead, deletedLead, null]) {
    await db.query(
      'insert into followups(organization_id,lead_id,assigned_user_id,branch_id) values ($1,$2,$3,$4)',
      [org, lead, user, branch],
    );
  }
}, 30000);
afterAll(async () => {
  await db?.close();
});

async function page(role: 'telecaller' | 'sales_consultant', branchIds = [branch], owner = user) {
  const result = await db.query<{
    result: {
      records: { lead_id: string | null }[];
      total: number;
      kpis: { overdue: number };
      status_counts: { all: number; overdue: number };
    };
  }>(
    `select app_private.get_${role}_followup_workspace_filtered_page($1,$2,$3,true,'','all','all',null,null,null,1,25,'scheduled:asc','Asia/Kolkata') result`,
    [org, owner, branchIds],
  );
  return result.rows[0]!.result;
}

describe('follow-ups linked to soft-deleted leads', () => {
  it('reproduces the old actionable deleted-lead row, then excludes it before all aggregates', async () => {
    expect((await page('telecaller')).records.some((row) => row.lead_id === deletedLead)).toBe(
      true,
    );
    await db.exec(migration);
    for (const role of ['telecaller', 'sales_consultant'] as const) {
      const result = await page(role);
      expect(result.records.map((row) => row.lead_id)).toEqual(
        expect.arrayContaining([liveLead, null]),
      );
      expect(result.records.some((row) => row.lead_id === deletedLead)).toBe(false);
      expect(result.total).toBe(2);
      expect(result.kpis.overdue).toBe(2);
      expect(result.status_counts.all).toBe(2);
      expect(result.status_counts.overdue).toBe(2);
    }
    expect((await db.query('select id from followups')).rows).toHaveLength(3);
  });
  it('retains branch and owner scope restrictions', async () => {
    expect((await page('telecaller', [randomUUID()])).records).toEqual([]);
    expect((await page('telecaller', [branch], randomUUID())).records).toEqual([]);
  });
});
