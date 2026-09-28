-- A personal WhatsApp reply whose send call was ambiguous is stored as UNKNOWN
-- and later rescued by WhatsApp's own receipt (SENT / DELIVERED / READ).
-- send_result already allows that upgrade, but it kept `failed_at`, so three
-- rescued replies inside ten minutes still tripped the 30-minute send pause
-- even though every one of them reached the customer. A confirmed send now
-- clears `failed_at`; only genuinely failed or unconfirmed sends count.
--
-- Patched from the live definition rather than re-emitted from an older
-- migration, so any later change to this function is preserved.
do $patch$
declare
  def text := pg_get_functiondef(
    'public.personal_whatsapp_send_result(uuid,uuid,text)'::regprocedure
  );
  old_text constant text :=
    'failed_at=case when target_status in (''FAILED'',''UNKNOWN'') then coalesce(failed_at,now()) else failed_at end,';
  new_text constant text :=
    'failed_at=case when target_status in (''FAILED'',''UNKNOWN'') then coalesce(failed_at,now()) else null end,';
begin
  if position(old_text in def) = 0 then
    raise exception 'personal_whatsapp_send_result: failed_at target not found';
  end if;
  def := replace(def, old_text, new_text);
  if position(old_text in def) > 0 or position(new_text in def) = 0 then
    raise exception 'personal_whatsapp_send_result: failed_at patch did not apply';
  end if;
  execute def;
end;
$patch$;
