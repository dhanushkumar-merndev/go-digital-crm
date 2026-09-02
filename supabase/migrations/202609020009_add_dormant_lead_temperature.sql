begin;

-- DORMANT is "do not disturb": the customer asked not to be contacted, or the
-- dealership decided to stop contacting them. It sits on the same enum as the
-- intent ladder because it is set and cleared in the same place, by the same
-- person, and is audited through lead_temperature_history like any other change.
--
-- It is a suppression, not a low priority. HOT/WARM/COLD order an outbound
-- batch; DORMANT removes the lead from that batch entirely. See AGENTS.md 9.7.
--
-- The value is added on its own, with nothing using it. Postgres refuses to use
-- a new enum label in the same transaction that adds it, so the guard that
-- compares against 'DORMANT' lands in the next migration.
alter type public.lead_temperature add value if not exists 'DORMANT';

commit;
