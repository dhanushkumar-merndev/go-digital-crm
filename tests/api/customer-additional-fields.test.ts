import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';

let db: PGlite;
const customer = randomUUID();
describe('customer additional fields database', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create role anon; create role authenticated; create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as $$select '00000000-0000-4000-8000-000000000001'::uuid$$;
      create function app_private.has_permission(uuid,text) returns boolean language sql as $$select true$$;
      create function app_private.normalize_phone_digits(text) returns text language sql as $$select regexp_replace($1,'[^0-9]','','g')$$;
      create function app_private.can_access_customer(uuid,uuid) returns boolean language sql as $$select coalesce(current_setting('test.allowed',true),'yes') <> 'no'$$;
      create table profiles(id uuid,organization_id uuid,active boolean,deleted_at timestamptz);
      create table customers(id uuid primary key,organization_id uuid,full_name text,primary_phone text,primary_email text,created_at timestamptz default now(),updated_at timestamptz default now(),deleted_at timestamptz);
      create table customer_contacts(id uuid,organization_id uuid,customer_id uuid,type text,value text,is_primary boolean,created_at timestamptz);
      create table customer_addresses(id uuid,organization_id uuid,customer_id uuid,address_type text,address jsonb,created_at timestamptz);
      create table customer_vehicles(id uuid,organization_id uuid,customer_id uuid,registration text,brand text,model text,variant text,model_year integer,created_at timestamptz);
      create table custom_field_definitions(id uuid,organization_id uuid,field_key text,label text,field_type text,options jsonb,required boolean,module text,active boolean);
      create table custom_field_values(organization_id uuid,definition_id uuid,resource_type text,resource_id uuid,value jsonb);
      create table audit_logs(organization_id uuid,actor_id uuid,action text,resource_type text,resource_id text,request_id uuid,metadata jsonb);
      insert into profiles values(auth.uid(),auth.uid(),true,null);
    `);
    await db.exec(
      readFileSync('supabase/migrations/202609080002_customer_additional_fields.sql', 'utf8'),
    );
    await db.query(
      "insert into customers(id,organization_id,full_name) values($1,auth.uid(),'Customer')",
      [customer],
    );
  }, 30000);
  afterAll(async () => {
    await db?.close();
  });
  it('saves, reopens, and audits field/value rows with the customer update', async () => {
    const version = (
      await db.query<{ v: string }>('select updated_at::text v from customers where id=$1', [
        customer,
      ])
    ).rows[0].v;
    const fields = [{ label: 'Preferred contact time', value: 'After 6 pm' }];
    await db.query('select update_customer_360($1,$2,$3,$4)', [
      customer,
      version,
      JSON.stringify({ full_name: 'Customer', additional_fields: fields }),
      randomUUID(),
    ]);
    const read = await db.query<{ data: { additional_fields: unknown } }>(
      'select get_customer_360_edit_data($1) data',
      [customer],
    );
    expect(read.rows[0].data.additional_fields).toEqual(fields);
    const audit = await db.query<{ metadata: Record<string, unknown> }>(
      'select metadata from audit_logs',
    );
    expect(audit.rows[0].metadata.additional_fields_before).toEqual([]);
    expect(audit.rows[0].metadata.additional_fields_after).toEqual(fields);
  });
  it.each([
    null,
    {},
    [{ label: '', value: 'x' }],
    [{ label: 'Name', value: '' }],
    [{ label: 'Name', value: 5 }],
    [
      { label: 'Name', value: 'a' },
      { label: ' name ', value: 'b' },
    ],
    Array.from({ length: 26 }, (_, i) => ({ label: String(i), value: 'x' })),
  ])('rejects malformed additional data %#', async (fields) => {
    const result = await db.query<{ valid: boolean }>(
      'select app_private.valid_customer_additional_fields($1::jsonb) valid',
      [JSON.stringify(fields)],
    );
    expect(result.rows[0].valid).toBe(false);
  });
  it('denies reading a customer outside the actor scope', async () => {
    await db.exec("select set_config('test.allowed','no',false)");
    await expect(db.query('select get_customer_additional_fields($1)', [customer])).rejects.toThrow(
      /CUSTOMER_ACCESS_DENIED/,
    );
  });
});
