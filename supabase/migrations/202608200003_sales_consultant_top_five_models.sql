begin;

do $migration$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.get_sales_consultant_top_models(text)'::regprocedure
  ) into function_definition;

  if position(E'\n      limit 3\n' in function_definition) = 0 then
    raise exception 'TOP_MODELS_LIMIT_NOT_FOUND';
  end if;

  execute replace(
    function_definition,
    E'\n      limit 3\n',
    E'\n      limit 5\n'
  );
end;
$migration$;

commit;
