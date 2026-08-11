-- Two corrections to 0010 and 0011, both found by writing the tests that should
-- have accompanied them.

-- ---------------------------------------------------------------------------
-- 1. Realtime needs the whole row after all
-- ---------------------------------------------------------------------------
-- 0010 left REPLICA IDENTITY at its default, reasoning that FULL is only needed
-- for old_record and for evaluating RLS on DELETEs, neither of which this table
-- does. That was wrong, and quietly so: the publication was correct, the
-- subscription reached SUBSCRIBED, and no events were ever delivered.
--
-- Realtime evaluates the subscriber's RLS policy against the changed row before
-- deciding whether to forward it. With the default replica identity, the WAL
-- record carries only the primary key, so there is nothing to evaluate
-- leads_select against and every change is dropped -- including INSERTs, which
-- is what ruled out the old_record explanation.
--
-- The cost is real but small here: the previous version of the row is written
-- to WAL on every update, and leads carries a `search` tsvector. At two
-- operators and roughly forty sends a day that is noise. Revisit if the table
-- ever takes bulk updates.

alter table public.leads replica identity full;

-- ---------------------------------------------------------------------------
-- 2. Deleting a user also UPDATEs lead_events
-- ---------------------------------------------------------------------------
-- 0011 taught the append-only guard to permit a cascading DELETE, which fixed
-- dropping an org. Deleting a USER still failed, because lead_events.actor_id
-- is ON DELETE SET NULL -- so removing an operator fires an UPDATE on every
-- event they ever authored, and the guard refused those.
--
-- Allowed only in the exact shape the foreign key produces: actor_id going from
-- a value to null, every other column identical, and no row left in auth.users
-- for the old actor. Comparing the rows as jsonb minus that one key is what
-- makes "every other column" hold without listing them, so a column added to
-- lead_events later cannot silently widen this hole.

create or replace function app.block_event_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.allow_event_mutation', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  -- The parent is already gone: this is a cascade, not a hand-written delete.
  if tg_op = 'DELETE'
     and (
       not exists (select 1 from public.leads l where l.id = old.lead_id)
       or not exists (select 1 from public.orgs o where o.id = old.org_id)
     )
  then
    return old;
  end if;

  -- The author is already gone: this is leads_events_actor_id_fkey, not an edit.
  if tg_op = 'UPDATE'
     and old.actor_id is not null
     and new.actor_id is null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id')
     and not exists (select 1 from auth.users u where u.id = old.actor_id)
  then
    return new;
  end if;

  raise exception 'lead_events is append-only (attempted % on event %)',
    tg_op, coalesce(old.id::text, '?')
    using errcode = '0A000';
end;
$$;
