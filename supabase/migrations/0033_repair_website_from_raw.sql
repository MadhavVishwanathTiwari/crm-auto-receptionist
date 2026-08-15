-- Putting the company site back where a directory link got imported instead.
--
-- `url` was a synonym of `website`, and in the Clay export that column holds the
-- Google Maps search link rather than the business. It is also the first column
-- in the file, and auto-mapping takes the first exact match, so it won that
-- field before the real `website` column was ever considered.
--
-- website_domain is generated from website, and a maps link normalizes to
-- `google.com`. That is not cosmetic: it is the key GET /api/v1/demos/pending
-- hands the demo builder, the key POST /api/v1/demos joins on, and the second
-- thing partitionRows() checks for near-duplicates — so a whole second batch
-- would collide on one domain and land in /review instead of leads.
--
-- The mapping is fixed in lib/csv/mapping.ts. This repairs what is already in.
-- It can, because commitImport stores the original CSV row as `leads.raw`, so
-- the real website is still in the database, just not in the column.
--
-- Admin only, dry run by default, and re-runnable.

-- Directory and social hosts. A lead whose website is one of these has no
-- company domain at all, so the demo join and duplicate detection both degrade
-- to matching everything against everything.
create or replace function app.aggregator_domains() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'google.com', 'google.co.uk', 'goo.gl',
    'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com',
    'twitter.com', 'x.com',
    'yelp.com', 'yellowpages.com', 'bbb.org', 'nextdoor.com',
    'angi.com', 'thumbtack.com',
    'bing.com', 'apple.com', 'maps.apple.com'
  ]::text[];
$$;

-- The best website candidate inside a stored CSV row.
--
-- `raw` is keyed by the file's ORIGINAL header names, whatever they were, so
-- this matches them the same way normalizeHeader() does in TypeScript — lowercase,
-- strip everything that is not alphanumeric — rather than naming two columns and
-- hoping. Values are cleaned the way lib/csv/clean.ts cleans them, because Clay
-- reports enrichment status inside the value: "✅ http://acme.com".
create or replace function app.website_from_raw(p_raw jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_value text;
  v_norm  text;
begin
  if p_raw is null or jsonb_typeof(p_raw) <> 'object' then
    return null;
  end if;

  for v_value in
    select value
      from jsonb_each_text(p_raw)
     where lower(regexp_replace(key, '[^a-zA-Z0-9]', '', 'g')) in
           ('website', 'companywebsite', 'scrapewebsite', 'site', 'domain')
     -- A column literally called `website` beats a scraper's echo of it, and
     -- both beat a bare `domain`. jsonb_each_text has no inherent order, so
     -- without this the answer would vary between runs on the same row.
     order by case lower(regexp_replace(key, '[^a-zA-Z0-9]', '', 'g'))
                when 'website'        then 1
                when 'companywebsite' then 2
                when 'scrapewebsite'  then 3
                when 'site'           then 4
                else 5
              end
  loop
    v_value := btrim(coalesce(v_value, ''));

    -- A failure marker means the enrichment found nothing; what follows it is
    -- an error message, not a URL.
    if left(v_value, 1) = '❌' then
      continue;
    end if;
    if left(v_value, 1) = '✅' then
      v_value := btrim(substr(v_value, 2));
    end if;
    if v_value = '' then
      continue;
    end if;

    v_norm := app.normalize_domain(v_value);
    if v_norm is null or v_norm = any (app.aggregator_domains()) then
      continue;
    end if;

    return v_value;
  end loop;

  return null;
end;
$$;

create or replace function public.repair_lead_websites(
  p_dry_run boolean default true
) returns table (
  lead_id     uuid,
  company     text,
  old_website text,
  new_website text,
  outcome     text
)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_row record;
  v_candidate text;
begin
  if v_org is null then
    raise exception 'not a member of any org' using errcode = '42501';
  end if;

  -- Matching the other repair RPCs: rewriting a column across the whole org
  -- from stored data is an administrative act, not a member one.
  if not app.is_admin() then
    raise exception 'only an admin can repair websites' using errcode = '42501';
  end if;

  for v_row in
    select l.id, l.company_name, l.website, l.raw, l.demo_ready_at
      from public.leads l
     where l.org_id = v_org
       and l.website_domain = any (app.aggregator_domains())
     order by l.created_at
  loop
    lead_id     := v_row.id;
    company     := v_row.company_name;
    old_website := v_row.website;
    new_website := null;

    v_candidate := app.website_from_raw(v_row.raw);

    -- Nothing recoverable. Leaving the directory link is worse than nothing
    -- only if we could do better, and here we cannot.
    if v_candidate is null then
      outcome := 'no candidate in raw';
      return next;
      continue;
    end if;

    new_website := v_candidate;

    if not p_dry_run then
      -- `website` is not one of the guarded columns, so this is an ordinary
      -- update and website_domain regenerates itself.
      update public.leads set website = v_candidate where id = v_row.id;
    end if;

    -- The demo was built against google.com, so its slug does not describe this
    -- business and no amount of fixing the column changes that. Call it out
    -- rather than reporting a clean repair.
    if v_row.demo_ready_at is not null then
      outcome := 'repaired, but a demo already exists';
    else
      outcome := 'repaired';
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.repair_lead_websites(boolean) from public, anon;
grant execute on function public.repair_lead_websites(boolean) to authenticated;

comment on function public.repair_lead_websites(boolean) is
  'Re-reads the company website out of leads.raw for leads whose website is a '
  'directory or maps link. Admin only. Dry run by default.';
