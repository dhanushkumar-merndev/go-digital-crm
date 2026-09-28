begin;

-- A Lost lead could still be quoted, have its quotation sent or accepted, and
-- be booked: none of save_quotation, transition_quotation_status or
-- create_booking_from_quotation looked at the lead's lifecycle, while
-- create_test_drive already refused a Lost lead. quick_book_lead composes these
-- three, so it inherits the same refusal.
--
-- A Lost lead is closed. Recovering it is a deliberate manager action that
-- moves it out of Lost first; a sales document must not silently revive it.
--
-- These functions are maintained by patching their deployed definitions, so
-- each patch asserts that its anchor was found and applied exactly once.
do $migration$
declare
  current_definition text;
  updated_definition text;
  guard_code constant text := 'LEAD_IS_LOST';
  save_anchor constant text :=
    E'  if not found then\n'
    || E'    raise exception using errcode = ''P0002'', message = ''QUOTATION_LEAD_NOT_FOUND'';\n'
    || E'  end if;\n';
  save_guard constant text :=
    E'  if lead_row.lifecycle_status = ''Lost'' then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_IS_LOST'';\n'
    || E'  end if;\n';
  transition_anchor constant text :=
    E'    raise exception using errcode = ''42501'', message = ''QUOTATION_SCOPE_DENIED'';\n'
    || E'  end if;\n';
  transition_guard constant text :=
    E'  if normalized_status in (''SENT'', ''ACCEPTED'') and exists (\n'
    || E'    select 1 from public.leads lead_row\n'
    || E'    where lead_row.organization_id = quotation_row.organization_id\n'
    || E'      and lead_row.id = quotation_row.lead_id\n'
    || E'      and lead_row.lifecycle_status = ''Lost''\n'
    || E'  ) then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_IS_LOST'';\n'
    || E'  end if;\n';
  booking_anchor constant text :=
    E'    raise exception using errcode = ''23505'', message = ''QUOTATION_ALREADY_BOOKED'';\n'
    || E'  end if;\n';
  booking_guard constant text :=
    E'  if exists (\n'
    || E'    select 1 from public.leads lead_row\n'
    || E'    where lead_row.organization_id = quotation_row.organization_id\n'
    || E'      and lead_row.id = quotation_row.lead_id\n'
    || E'      and lead_row.lifecycle_status = ''Lost''\n'
    || E'  ) then\n'
    || E'    raise exception using errcode = ''23514'', message = ''LEAD_IS_LOST'';\n'
    || E'  end if;\n';
begin
  -- save_quotation
  select pg_get_functiondef('public.save_quotation(uuid,bigint,uuid,jsonb,uuid)'::regprocedure)
    into current_definition;
  if position(guard_code in current_definition) = 0 then
    if (length(current_definition) - length(replace(current_definition, save_anchor, '')))
      / length(save_anchor) <> 1
    then
      raise exception 'SAVE_QUOTATION_LOST_GUARD_ANCHOR_NOT_UNIQUE';
    end if;
    updated_definition := replace(current_definition, save_anchor, save_anchor || save_guard);
    execute updated_definition;
  end if;

  -- transition_quotation_status
  select pg_get_functiondef(
    'public.transition_quotation_status(uuid,bigint,text,text,uuid)'::regprocedure
  ) into current_definition;
  if position(guard_code in current_definition) = 0 then
    if (length(current_definition) - length(replace(current_definition, transition_anchor, '')))
      / length(transition_anchor) <> 1
    then
      raise exception 'TRANSITION_QUOTATION_LOST_GUARD_ANCHOR_NOT_UNIQUE';
    end if;
    updated_definition := replace(
      current_definition, transition_anchor, transition_anchor || transition_guard
    );
    execute updated_definition;
  end if;

  -- create_booking_from_quotation
  select pg_get_functiondef(
    'public.create_booking_from_quotation(uuid,bigint,numeric,boolean,boolean,date,uuid)'::regprocedure
  ) into current_definition;
  if position(guard_code in current_definition) = 0 then
    if (length(current_definition) - length(replace(current_definition, booking_anchor, '')))
      / length(booking_anchor) <> 1
    then
      raise exception 'CREATE_BOOKING_LOST_GUARD_ANCHOR_NOT_UNIQUE';
    end if;
    updated_definition := replace(current_definition, booking_anchor, booking_anchor || booking_guard);
    execute updated_definition;
  end if;

  -- Every guard must now be live.
  if position(guard_code in pg_get_functiondef(
      'public.save_quotation(uuid,bigint,uuid,jsonb,uuid)'::regprocedure)) = 0
    or position(guard_code in pg_get_functiondef(
      'public.transition_quotation_status(uuid,bigint,text,text,uuid)'::regprocedure)) = 0
    or position(guard_code in pg_get_functiondef(
      'public.create_booking_from_quotation(uuid,bigint,numeric,boolean,boolean,date,uuid)'::regprocedure)) = 0
  then
    raise exception 'LOST_LEAD_SALES_DOCUMENT_GUARD_NOT_APPLIED';
  end if;
end;
$migration$;

commit;
