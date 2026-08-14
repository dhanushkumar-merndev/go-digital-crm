begin;

create table public.mobile_link_challenges (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), user_id uuid not null references public.profiles(id),
  nonce_hash text not null, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now(),
  constraint mobile_link_short_lived check (expires_at <= created_at + interval '5 minutes')
);
alter table public.mobile_link_challenges enable row level security;
alter table public.mobile_link_challenges force row level security;
create policy own_mobile_link_challenges on public.mobile_link_challenges for select to authenticated using (user_id = auth.uid());
create index mobile_link_expiry_idx on public.mobile_link_challenges (expires_at) where used_at is null;

commit;
