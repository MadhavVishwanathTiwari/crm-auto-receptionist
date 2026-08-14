-- The zone guard forced timezone_source := 'manual' on ANY change, which meant
-- the resolver's own writes came back out labelled as a human correction. The
-- protection that mattered - a later automated pass must never overwrite a
-- correction - lives in the transition, not in the blanket label:
--
--   null -> a zone, with a machine source supplied : keep the source
--   a zone -> anything else                        : manual, as before
--   anything -> null                               : no source, as before
--
-- Everything else in the function is 0011 verbatim.

create or replace function app.leads_guard_protected_columns() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_owner_deleted boolean;
begin
  if coalesce(current_setting('app.bypass_lead_guard', true), 'off') = 'on' then
    new.updated_at := now();
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     or new.terminal_outcome is distinct from old.terminal_outcome
     or new.halted_at is distinct from old.halted_at
     or new.halt_reason is distinct from old.halt_reason then
    raise exception
      'status is derived from lead_events, not written. Insert an event instead.'
      using errcode = '42501';
  end if;

  if new.claimed_by is distinct from old.claimed_by
     or new.claimed_at is distinct from old.claimed_at
     or new.claim_count is distinct from old.claim_count then

    v_owner_deleted :=
      new.claimed_by is null
      and old.claimed_by is not null
      and new.claim_count = old.claim_count
      and not exists (select 1 from auth.users u where u.id = old.claimed_by);

    if v_owner_deleted then
      new.claimed_at  := null;
      new.released_at := now();
    else
      raise exception
        'ownership is managed by claim_lead() / release_lead() / reassign_lead()'
        using errcode = '42501';
    end if;
  end if;

  if new.demo_txt_url is distinct from old.demo_txt_url
     or new.demo_web_url is distinct from old.demo_web_url
     or new.demo_slug is distinct from old.demo_slug
     or new.demo_ready_at is distinct from old.demo_ready_at then
    raise exception 'demo URLs are written by the demo ingest API'
      using errcode = '42501';
  end if;

  if new.timezone is distinct from old.timezone then
    if new.timezone is null then
      new.timezone_source := null;
    elsif old.timezone is null
      and new.timezone_source in ('coordinates', 'place', 'import') then
      -- Filling a hole, and the writer said how. Believe it.
      null;
    else
      -- Changing an existing zone is a human overriding one, whoever asked.
      new.timezone_source := 'manual';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
