-- Lead search matches a typed number as a prefix of normalized_phone
-- (`normalized_phone like '98765%'`). The existing (organization_id,
-- normalized_phone) index uses the database collation, which cannot serve a
-- LIKE prefix, so a phone search read every lead in scope: ~120 ms for an
-- org-wide manager on the 75,000-lead Scale Test org. text_pattern_ops lets
-- the windowed lead workspace walk (202609280005) range-scan it instead.
create index if not exists leads_org_phone_prefix_idx
  on public.leads (organization_id, normalized_phone text_pattern_ops)
  where deleted_at is null;
