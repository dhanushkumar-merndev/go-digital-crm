begin;
-- Route template events without refetching chats, and chat receipts without
-- refetching the template picker. No customer or message content is broadcast.
do $$ declare definition text; begin
  select pg_get_functiondef('app_private.broadcast_tenant_invalidation()'::regprocedure) into definition;
  definition := replace(definition, '''resource'', tg_argv[0],', '''resource'', tg_argv[0], ''table'', tg_table_name,');
  execute definition;
end $$;
-- Metadata-only notifications let already-open inboxes see admin changes.
create trigger personal_whatsapp_template_invalidation
after insert or update on public.templates
for each row when (new.channel = 'WHATSAPP_PERSONAL')
execute function app_private.broadcast_tenant_invalidation('communications');
commit;
