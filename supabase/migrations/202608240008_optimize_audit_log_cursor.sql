-- Tenant audit reads already use audit_logs_cursor_idx. Platform audit reads
-- span organizations, so they need the same stable cursor order without the
-- organization_id prefix.
create index concurrently if not exists audit_logs_global_cursor_idx
  on public.audit_logs (created_at desc, id desc);

-- Audit logs are high-volume and these are the only two user-filterable text
-- fields. Trigram indexes keep the bounded substring filters from degrading to
-- full-table scans as the immutable log grows.
create index concurrently if not exists audit_logs_action_trgm_idx
  on public.audit_logs using gin (action gin_trgm_ops);

create index concurrently if not exists audit_logs_resource_type_trgm_idx
  on public.audit_logs using gin (resource_type gin_trgm_ops);
