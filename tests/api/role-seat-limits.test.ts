import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const migration = source('supabase/migrations/202610080501_role_seat_limits.sql');
const org = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const teamA = randomUUID();
const teamB = randomUUID();
const superAdmin = randomUUID();
let db: PGlite;

// Only what the migration reads and patches. The two stub functions carry the
// exact lines the migration's text patches anchor on, as the deployed ones do.
const schema = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema app_private;
create function auth.uid() returns uuid language sql stable as
  $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
create type public.data_scope as enum
  ('OWN_RECORDS','OWN_TEAM','ONE_BRANCH','SELECTED_BRANCHES','ALL_BRANCHES','ORGANIZATION','PLATFORM');
create table public.organizations(id uuid primary key, name text default 'Dealer', status text default 'ACTIVE',
  deleted_at timestamptz);
create table public.profiles(id uuid primary key, organization_id uuid, full_name text default 'User',
  active boolean default true, deleted_at timestamptz);
create table public.branches(id uuid primary key default gen_random_uuid(), organization_id uuid,
  name text, active boolean default true, deleted_at timestamptz);
create table public.teams(id uuid primary key, organization_id uuid, branch_id uuid, active boolean default true);
create table public.roles(id uuid primary key default gen_random_uuid(), organization_id uuid, name text,
  role_key text, authority_level integer default 400, system_role boolean default true,
  mfa_required boolean default false, unique (organization_id, role_key));
create table public.permissions(id uuid primary key default gen_random_uuid(), permission_key text unique);
create table public.role_permissions(role_id uuid, permission_id uuid, primary key (role_id, permission_id));
create table public.user_role_assignments(id uuid primary key default gen_random_uuid(), organization_id uuid,
  user_id uuid, role_id uuid, data_scope public.data_scope, scope_branch_id uuid, selected_branch_ids uuid[],
  active boolean default true, created_at timestamptz default clock_timestamp());
create table public.team_members(organization_id uuid, team_id uuid, user_id uuid, active boolean default true,
  primary key (team_id, user_id));
create table public.user_branch_access(organization_id uuid, user_id uuid, branch_id uuid,
  active boolean default true, primary key (user_id, branch_id));
create table public.audit_logs(id uuid primary key default gen_random_uuid(), organization_id uuid,
  actor_id uuid, action text, resource_type text, resource_id text, request_id uuid, metadata jsonb);
create function app_private.is_platform_admin() returns boolean language sql stable as
  $$select auth.uid() = '${superAdmin}'::uuid$$;
create function app_private.mfa_policy_satisfied(target uuid) returns boolean language sql stable as $$select true$$;
create function app_private.block_writes() returns trigger language plpgsql as $$begin return new; end$$;
create trigger enforce_role_write_security before insert or update on public.roles
  for each row execute function app_private.block_writes();
create trigger enforce_role_permission_write_security before insert on public.role_permissions
  for each row execute function app_private.block_writes();
create function public.provision_default_roles(target_organization_id uuid) returns void language plpgsql as $$
begin
  insert into public.roles (organization_id, name, role_key, authority_level, system_role, mfa_required)
  values
    (target_organization_id, 'Showroom Manager', 'showroom_manager', 600, true, false),
    (target_organization_id, 'Digital Marketing Manager', 'digital_marketing_manager', 450, true, false)
  on conflict (organization_id, role_key) do update set name = excluded.name;
end;
$$;
create function app_private.get_access_context_with_legacy_policy() returns text language plpgsql as $$
declare role_key text := current_setting('test.role_key', true);
begin
  return case role_key
    when 'digital_marketing_manager' then 'digital-marketing'
    else replace(role_key, '_', '-')
  end;
end;
$$;
insert into public.permissions(permission_key)
  select unnest(array['marketing.view','marketing.manage','report.view','report.export','lead.view']);
`;

const roleIds = new Map<string, string>();

async function addRole(key: string, name: string) {
  const result = await db.query<{ id: string }>(
    'insert into public.roles(organization_id,name,role_key) values($1,$2,$3) returning id',
    [org, name, key],
  );
  roleIds.set(key, result.rows[0].id);
}

/** A user holding `role`, placed in a branch through scope or a team. */
async function user(
  role: string,
  placement: { branch?: string; team?: string; scope?: string; selected?: string[] } = {},
) {
  const id = randomUUID();
  await db.query('insert into public.profiles(id,organization_id) values($1,$2)', [id, org]);
  const scope = placement.scope ?? (placement.team ? 'OWN_RECORDS' : 'ONE_BRANCH');
  await db.query(
    `insert into public.user_role_assignments(organization_id,user_id,role_id,data_scope,scope_branch_id,
       selected_branch_ids) values($1,$2,$3,$4::public.data_scope,$5,$6)`,
    [org, id, roleIds.get(role), scope, placement.branch ?? null, placement.selected ?? null],
  );
  if (placement.team)
    await db.query(
      'insert into public.team_members(organization_id,team_id,user_id) values($1,$2,$3)',
      [org, placement.team, id],
    );
  return id;
}

/** Expected errors abort the transaction; a savepoint keeps the test usable. */
async function refused(call: () => Promise<unknown>, message: string) {
  await db.exec('savepoint expected_error');
  await expect(call()).rejects.toThrow(message);
  await db.exec('rollback to savepoint expected_error');
}

async function setLimit(role: string, maxUsers: number | null) {
  await db.query(
    'insert into public.organization_role_seat_limits(organization_id,role_key,max_users) values($1,$2,$3)',
    [org, role, maxUsers],
  );
}

describe('role seat limits per dealership', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(schema);
    await db.query('insert into public.organizations(id) values($1)', [org]);
    await db.query(
      "insert into public.branches(id,organization_id,name) values($1,$3,'MG Road'),($2,$3,'Whitefield')",
      [branchA, branchB, org],
    );
    await db.query(
      'insert into public.teams(id,organization_id,branch_id) values($1,$3,$4),($2,$3,$5)',
      [teamA, teamB, org, branchA, branchB],
    );
    for (const [key, name] of [
      ['telecaller_bdc', 'Telecaller / BDC Executive'],
      ['business_owner', 'Business Owner'],
      ['finance_manager', 'Finance Manager'],
      ['client_admin', 'Client Admin'],
    ])
      await addRole(key, name);
    await db.exec(migration);
    await db.query('insert into public.profiles(id,organization_id) values($1,null)', [superAdmin]);
  }, 30_000);
  beforeEach(async () => {
    await db.exec('begin');
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('refuses the 11th telecaller in a branch and allows one in another branch', async () => {
    for (let index = 0; index < 10; index += 1) await user('telecaller_bdc', { team: teamA });
    await refused(() => user('telecaller_bdc', { team: teamA }), 'ROLE_SEAT_LIMIT_REACHED');
    await expect(user('telecaller_bdc', { team: teamB })).resolves.toBeTruthy();
  });

  it('names the full branch and the limit in the error detail', async () => {
    await setLimit('telecaller_bdc', 1);
    await user('telecaller_bdc', { team: teamA });
    await db.exec('savepoint expected_error');
    const error = await user('telecaller_bdc', { team: teamA }).catch((caught: unknown) => caught);
    await db.exec('rollback to savepoint expected_error');
    expect((error as { detail?: string }).detail).toBe(
      'MG Road already has 1 of the 1 Telecaller / BDC Executive allowed.',
    );
  });

  it('allows one Business Owner for the whole dealership', async () => {
    await user('business_owner', { branch: branchA });
    await refused(() => user('business_owner', { branch: branchB }), 'ROLE_SEAT_LIMIT_REACHED');
  });

  it('counts an all-branches holder in every branch', async () => {
    await user('finance_manager', { branch: branchB });
    await refused(
      () => user('finance_manager', { scope: 'ALL_BRANCHES' }),
      'ROLE_SEAT_LIMIT_REACHED',
    );
    await expect(user('finance_manager', { branch: branchA })).resolves.toBeTruthy();
  });

  it('does not count a user against themselves when their unchanged role is saved again', async () => {
    const manager = await user('finance_manager', { branch: branchA });
    // The user-update RPC deactivates the assignment and inserts an identical one.
    await db.query('update public.user_role_assignments set active=false where user_id=$1', [
      manager,
    ]);
    await db.query(
      `insert into public.user_role_assignments(organization_id,user_id,role_id,data_scope,scope_branch_id)
       values($1,$2,$3,'ONE_BRANCH',$4)`,
      [org, manager, roleIds.get('finance_manager'), branchA],
    );
    // Lowered below what the branch already holds: the saved-again row is still fine.
    await setLimit('finance_manager', 0);
    await db.query('update public.user_role_assignments set active=false where user_id=$1', [
      manager,
    ]);
    await expect(
      db.query(
        `insert into public.user_role_assignments(organization_id,user_id,role_id,data_scope,scope_branch_id)
         values($1,$2,$3,'ONE_BRANCH',$4)`,
        [org, manager, roleIds.get('finance_manager'), branchA],
      ),
    ).resolves.toBeTruthy();
  });

  it('checks a re-activated user and ignores an inactive one', async () => {
    await setLimit('telecaller_bdc', 1);
    const first = await user('telecaller_bdc', { team: teamA });
    await db.query('update public.profiles set active=false where id=$1', [first]);
    const second = await user('telecaller_bdc', { team: teamA });
    expect(second).toBeTruthy();
    await refused(
      () => db.query('update public.profiles set active=true where id=$1', [first]),
      'ROLE_SEAT_LIMIT_REACHED',
    );
  });

  it('checks a move into a full branch through team membership', async () => {
    await setLimit('telecaller_bdc', 1);
    await user('telecaller_bdc', { team: teamB });
    const mover = await user('telecaller_bdc', { team: teamA });
    await refused(
      () => db.query('update public.team_members set team_id=$1 where user_id=$2', [teamB, mover]),
      'ROLE_SEAT_LIMIT_REACHED',
    );
  });

  it('applies an override over the default and treats an explicit null as unlimited', async () => {
    await setLimit('business_owner', null);
    await user('business_owner', { branch: branchA });
    await expect(user('business_owner', { branch: branchB })).resolves.toBeTruthy();
    // Roles without a default, like Client Admin, are never limited.
    await user('client_admin', { scope: 'ORGANIZATION' });
    await expect(user('client_admin', { scope: 'ORGANIZATION' })).resolves.toBeTruthy();
  });

  it('refuses a branch beyond the dealership limit, including a re-activated one', async () => {
    await db.query('update public.organizations set max_branches=3 where id=$1', [org]);
    const third = randomUUID();
    await db.query("insert into public.branches(id,organization_id,name) values($1,$2,'HSR')", [
      third,
      org,
    ]);
    await refused(
      () =>
        db.query("insert into public.branches(organization_id,name) values($1,'Indiranagar')", [
          org,
        ]),
      'BRANCH_LIMIT_REACHED',
    );
    await db.query('update public.branches set active=false where id=$1', [third]);
    await db.query("insert into public.branches(organization_id,name) values($1,'Indiranagar')", [
      org,
    ]);
    await refused(
      () => db.query('update public.branches set active=true where id=$1', [third]),
      'BRANCH_LIMIT_REACHED',
    );
  });

  it('previews the seat before an invite without writing anything', async () => {
    await setLimit('telecaller_bdc', 1);
    await user('telecaller_bdc', { team: teamA });
    const preview = async (team: string) =>
      (
        await db.query<{ result: { available: boolean; message?: string } }>(
          `select public.check_role_seat_available($1,$2,'OWN_RECORDS',null,null,$3) as result`,
          [org, roleIds.get('telecaller_bdc'), [team]],
        )
      ).rows[0].result;
    expect(await preview(teamA)).toEqual({
      available: false,
      message: 'MG Road already has 1 of the 1 Telecaller / BDC Executive allowed.',
    });
    expect(await preview(teamB)).toEqual({ available: true });
  });

  it('lets only a platform admin read and change the limits, with validation and audit', async () => {
    const claims = (sub: string) =>
      db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub })]);
    await claims(randomUUID());
    await refused(
      () => db.query('select public.get_organization_seat_limits($1)', [org]),
      'PLATFORM_SEAT_LIMITS_ACCESS_REQUIRED',
    );

    await claims(superAdmin);
    await user('telecaller_bdc', { team: teamA });
    const save = (limits: unknown, maxBranches: number | null = 10) =>
      db.query<{ result: { max_branches: number; roles: Array<Record<string, unknown>> } }>(
        'select public.set_organization_seat_limits($1,$2,$3::jsonb,$4) as result',
        [org, maxBranches, JSON.stringify(limits), randomUUID()],
      );
    const saved = (
      await save(
        [
          { role_key: 'telecaller_bdc', max_users: 20 },
          { role_key: 'business_owner', max_users: null },
        ],
        5,
      )
    ).rows[0].result;
    expect(saved.max_branches).toBe(5);
    expect(saved.roles.find((role) => role.role_key === 'telecaller_bdc')).toMatchObject({
      role_name: 'Telecaller / BDC Executive',
      limit_scope: 'BRANCH',
      default_max_users: 10,
      max_users: 20,
      overridden: true,
      in_use: 1,
      busiest_branch: 'MG Road',
    });
    expect(saved.roles.find((role) => role.role_key === 'business_owner')).toMatchObject({
      max_users: null,
      overridden: true,
    });
    const reset = (await save([{ role_key: 'telecaller_bdc', use_default: true }])).rows[0].result;
    expect(reset.roles.find((role) => role.role_key === 'telecaller_bdc')).toMatchObject({
      max_users: 10,
      overridden: false,
    });
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from public.audit_logs where action='organization.seat_limits_updated'",
    );
    expect(audit.rows[0].n).toBe(2);

    await refused(() => save([{ role_key: 'not_a_role', max_users: 1 }]), 'INVALID_SEAT_LIMITS');
    await refused(
      () => save([{ role_key: 'telecaller_bdc', max_users: -1 }]),
      'INVALID_SEAT_LIMITS',
    );
    await refused(
      () => save([{ role_key: 'telecaller_bdc', max_users: 1.5 }]),
      'INVALID_SEAT_LIMITS',
    );
    await refused(() => save([], 0), 'INVALID_SEAT_LIMITS');
  });

  it('renames Showroom Manager and adds the Digital Marketing Executive role for new dealerships', async () => {
    const fresh = randomUUID();
    await db.query('insert into public.organizations(id) values($1)', [fresh]);
    await db.query('select public.provision_default_roles($1)', [fresh]);
    const roles = await db.query<{ role_key: string; name: string }>(
      'select role_key, name from public.roles where organization_id=$1 order by role_key',
      [fresh],
    );
    expect(roles.rows).toEqual([
      { role_key: 'digital_marketing_executive', name: 'Digital Marketing Executive' },
      { role_key: 'digital_marketing_manager', name: 'Digital Marketing Manager' },
      { role_key: 'showroom_manager', name: 'Sales Manager' },
    ]);
    const granted = await db.query<{ permission_key: string }>(
      `select permission_row.permission_key from public.role_permissions grant_row
       join public.roles role_row on role_row.id=grant_row.role_id
       join public.permissions permission_row on permission_row.id=grant_row.permission_id
       where role_row.organization_id=$1 and role_row.role_key='digital_marketing_executive'
       order by 1`,
      [fresh],
    );
    expect(granted.rows.map((row) => row.permission_key)).toEqual([
      'lead.view',
      'marketing.manage',
      'marketing.view',
      'report.view',
    ]);
  });

  it('opens the Digital Marketing workspace for the executive', async () => {
    await db.query("select set_config('test.role_key','digital_marketing_executive',true)");
    const route = await db.query<{ route: string }>(
      'select app_private.get_access_context_with_legacy_policy() as route',
    );
    expect(route.rows[0].route).toBe('digital-marketing');
  });
});
