-- Every credit check recomputed the balance as sum(amount) over the whole
-- ledger for that organization, while holding the per-organization advisory
-- lock. consume_credits did it three times per call. That is O(ledger rows) on
-- a table that only ever grows, and the lock means the scans serialize: a
-- 50,000-recipient bulk send would run 50,000 full-ledger aggregates one after
-- another. Invisible at demo scale, a hard timeout in production.
--
-- The ledger stays the immutable source of truth. This adds a maintained
-- running total so a balance read is one indexed row instead of an aggregate.

create table public.credit_balances (
  organization_id uuid not null references public.organizations(id),
  ledger_kind public.credit_ledger_kind not null,
  balance bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (organization_id, ledger_kind)
);

alter table public.credit_balances enable row level security;
alter table public.credit_balances force row level security;
revoke insert, update, delete, truncate on public.credit_balances from anon, authenticated;

-- Derived from the ledger, so it is rebuilt rather than purged on its own.
insert into app_private.retention_table_allowlist (table_name, disposition, delete_order)
values ('credit_balances', 'DELETE', 787)
on conflict (table_name) do update
  set disposition = excluded.disposition, delete_order = excluded.delete_order;

-- Seed from the history that already exists. Runs once, as one aggregate.
insert into public.credit_balances (organization_id, ledger_kind, balance)
select organization_id, ledger_kind, sum(amount)
from public.credit_ledger
group by organization_id, ledger_kind
on conflict (organization_id, ledger_kind) do update set balance = excluded.balance;

-- credit_ledger is append-only: an existing trigger raises on update and delete,
-- so maintaining the total on insert alone keeps the two exactly in step.
create or replace function app_private.apply_credit_ledger_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.credit_balances (organization_id, ledger_kind, balance)
  values (new.organization_id, new.ledger_kind, new.amount)
  on conflict (organization_id, ledger_kind) do update
    set balance = public.credit_balances.balance + excluded.balance, updated_at = now();
  return null;
end;
$$;

drop trigger if exists credit_ledger_balance on public.credit_ledger;
create trigger credit_ledger_balance
  after insert on public.credit_ledger
  for each row execute function app_private.apply_credit_ledger_balance();

-- Reads the maintained total instead of aggregating the ledger. Behaviour,
-- permissions, idempotency and the advisory lock are unchanged.
create or replace function public.consume_credits(
  target_organization_id uuid,
  target_ledger public.credit_ledger_kind,
  requested_amount bigint,
  target_feature text,
  idempotency_key text,
  consumption_reason text
)
returns table (ledger_id uuid, balance bigint)
language plpgsql security definer set search_path = '' as $$
declare
  current_balance bigint;
  existing_entry public.credit_ledger%rowtype;
  new_id uuid;
begin
  if requested_amount <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_CREDIT_AMOUNT';
  end if;
  if nullif(btrim(idempotency_key), '') is null then
    raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if not app_private.has_permission(target_organization_id, 'credit.consume') then
    raise exception using errcode = '42501', message = 'PERMISSION_DENIED';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(target_organization_id::text || ':' || target_ledger::text, 0)
  );
  select * into existing_entry
  from public.credit_ledger ledger_row
  where ledger_row.organization_id = target_organization_id
    and ledger_row.ledger_kind = target_ledger
    and ledger_row.reference_id = idempotency_key;
  if found then
    if existing_entry.transaction_type <> 'CONSUMPTION'
      or existing_entry.amount <> -requested_amount
      or existing_entry.feature is distinct from target_feature
      or existing_entry.user_id is distinct from auth.uid()
    then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query
    select existing_entry.id,
      coalesce(
        (select balance_row.balance from public.credit_balances balance_row
         where balance_row.organization_id = target_organization_id
           and balance_row.ledger_kind = target_ledger), 0
      )::bigint;
    return;
  end if;

  select coalesce(balance_row.balance, 0) into current_balance
  from public.credit_balances balance_row
  where balance_row.organization_id = target_organization_id
    and balance_row.ledger_kind = target_ledger;
  current_balance := coalesce(current_balance, 0);
  if current_balance < requested_amount then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS';
  end if;

  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature,
    user_id, reference_id, reason, created_by
  ) values (
    target_organization_id, target_ledger, 'CONSUMPTION', -requested_amount,
    target_feature, auth.uid(), idempotency_key, consumption_reason, auth.uid()
  ) returning id into new_id;
  insert into public.audit_logs (
    organization_id, actor_id, action, resource_type, resource_id, metadata
  ) values (
    target_organization_id, auth.uid(), 'credit.consumed', 'credit_ledger', new_id::text,
    jsonb_build_object(
      'ledger_kind', target_ledger, 'amount', requested_amount,
      'feature', target_feature, 'reference_id', idempotency_key
    )
  );
  -- The insert above already moved the maintained total through the trigger.
  return query
  select new_id,
    coalesce(
      (select balance_row.balance from public.credit_balances balance_row
       where balance_row.organization_id = target_organization_id
         and balance_row.ledger_kind = target_ledger), 0
    )::bigint;
end;
$$;

create or replace function public.reserve_ai_credits(
  target_organization_id uuid,
  target_amount integer,
  target_feature text,
  target_reference_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare current_balance bigint; ledger_id uuid;
  reservation_row public.ai_credit_reservations%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if target_amount <= 0 or nullif(btrim(target_feature), '') is null
    or nullif(btrim(target_reference_id), '') is null then
    raise exception using errcode = '22023', message = 'INVALID_AI_CREDIT_RESERVATION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target_organization_id::text || ':AI', 0));
  select * into reservation_row
  from public.ai_credit_reservations existing_reservation
  where existing_reservation.organization_id = target_organization_id
    and existing_reservation.reference_id = target_reference_id
  for update;
  if found then
    if reservation_row.amount <> target_amount
      or reservation_row.feature <> btrim(target_feature) then
      raise exception using errcode = '22023', message = 'AI_CREDIT_IDEMPOTENCY_MISMATCH';
    end if;
    if reservation_row.status = 'REVERSED' then
      raise exception using errcode = 'P0001', message = 'AI_CREDIT_REFERENCE_REVERSED';
    end if;
    return reservation_row.id;
  end if;
  select coalesce(balance_row.balance, 0) into current_balance
  from public.credit_balances balance_row
  where balance_row.organization_id = target_organization_id
    and balance_row.ledger_kind = 'AI';
  current_balance := coalesce(current_balance, 0);
  if current_balance < target_amount then
    raise exception using errcode = 'P0001', message = 'INSUFFICIENT_CREDITS';
  end if;
  insert into public.credit_ledger (
    organization_id, ledger_kind, transaction_type, amount, feature, source,
    reference_id, reason
  ) values (
    target_organization_id, 'AI', 'CONSUMPTION', -target_amount, btrim(target_feature),
    'AI_CREDIT_RESERVATION', 'reserve:' || target_reference_id,
    'Reserved before external AI work'
  ) returning id into ledger_id;
  insert into public.ai_credit_reservations (
    organization_id, feature, reference_id, amount, ledger_id
  ) values (
    target_organization_id, btrim(target_feature), target_reference_id, target_amount, ledger_id
  ) returning * into reservation_row;
  return reservation_row.id;
end;
$$;

-- A reconciliation the ledger can always settle, for use if a balance is ever
-- suspected of drifting from the history it is derived from.
create or replace function public.rebuild_credit_balances()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare rebuilt integer;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  insert into public.credit_balances (organization_id, ledger_kind, balance)
  select organization_id, ledger_kind, sum(amount)
  from public.credit_ledger
  group by organization_id, ledger_kind
  on conflict (organization_id, ledger_kind) do update
    set balance = excluded.balance, updated_at = now();
  get diagnostics rebuilt = row_count;
  return rebuilt;
end;
$$;

revoke all on function public.rebuild_credit_balances() from public, anon, authenticated;
grant execute on function public.rebuild_credit_balances() to service_role;
