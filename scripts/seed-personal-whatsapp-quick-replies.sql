-- Requested starter replies for the connected demo dealership only.
-- Re-running preserves existing names, edits and archived replies. Sends nothing.
begin;
with starter(name, body) as (values
  ('Welcome / Enquiry', 'Hello! Thank you for your enquiry. Which car model are you interested in? I will be happy to help.'),
  ('Preferred callback time', 'When would be a convenient time for a quick call to discuss your requirements?'),
  ('Model and variant preference', 'Could you share your preferred model, variant and colour? I can check the available options for you.'),
  ('Showroom visit', 'Would you like to visit our showroom? Please share a convenient date and time so I can check availability.'),
  ('Test drive request', 'I would be happy to help arrange a test drive. Which model would you like to drive, and what date and time would suit you?'),
  ('Quotation request', 'I can help prepare a quotation. Please confirm your preferred model and variant, and the city where you plan to register the vehicle.'),
  ('Finance enquiry', 'Would you like to explore finance options? Please share your approximate down payment and preferred loan tenure. Final terms depend on lender approval.'),
  ('Exchange enquiry', 'Are you planning to exchange your current car? Please share its make, model, year and approximate kilometres driven so we can discuss an evaluation.'),
  ('Availability check', 'Let me check the latest availability with our team. I will update you once I have confirmed the details.'),
  ('Appointment reschedule', 'No problem if your plans have changed. Please share a new preferred date and time, and I will check whether we can reschedule.'),
  ('Help with questions', 'Do you have any questions about the vehicle or the quotation? I will be happy to help clarify them.'),
  ('Thank you', 'Thank you for your time! Please message me here if you need any further help with your car enquiry.')
), inserted as (
  insert into public.templates(organization_id,channel,name,content,status)
  select '517ed037-3731-4baa-a864-e9c7786cf3d1'::uuid,'WHATSAPP_PERSONAL',s.name,
    jsonb_build_object('body',s.body,'format','TEXT'),'ACTIVE'
  from starter s
  where exists(select 1 from public.personal_whatsapp_sessions where organization_id='517ed037-3731-4baa-a864-e9c7786cf3d1' and owner_user_id='9242dd47-8449-4906-a18e-07d05d52a8b6')
    and not exists(select 1 from public.templates t where t.organization_id='517ed037-3731-4baa-a864-e9c7786cf3d1' and t.channel='WHATSAPP_PERSONAL' and t.name=s.name)
  returning id,organization_id
)
insert into public.audit_logs(organization_id,action,resource_type,resource_id,metadata)
select organization_id,'template.reply_seeded','template',id::text,
  '{"source":"requested_starter_replies","channel":"WHATSAPP_PERSONAL"}'::jsonb from inserted;
commit;
