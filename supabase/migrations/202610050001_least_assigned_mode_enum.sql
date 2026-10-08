-- A third team assignment mode: give the lead to the eligible member carrying
-- the fewest open leads in the team.
--
-- Added in its own migration because a new enum value cannot be used until the
-- transaction that adds it has committed. 202610050002 wires it into the
-- assignment functions.
alter type public.assignment_mode add value if not exists 'LEAST_ASSIGNED';
