-- app.template_lint() could never report a violation.
--
-- Found by tests/integration/template-lint-parity.test.ts on its first run.
-- Every rule appended its code with
--
--   v_rules := v_rules || 'em_dash';
--
-- and an unquoted literal in Postgres is of type `unknown`. Given
-- `text[] || unknown`, the parser prefers the `anyarray || anyarray` operator
-- over `anyarray || anyelement`, so it tried to parse 'em_dash' as an ARRAY
-- LITERAL and raised
--
--   malformed array literal: "em_dash"
--
-- The clean case never reached an append, so the function looked like it
-- worked: clean copy activated, and dirty copy was refused. It was refused for
-- the wrong reason, with an error about array syntax instead of the rule it
-- broke, and app.template_lint() itself was incapable of returning anything but
-- an empty array or an exception.
--
-- The fix is one cast per append. Repeated in full because create or replace
-- has no way to patch a single line.

create or replace function app.template_lint(p_subject text, p_body text)
returns text[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_rules   text[] := '{}';
  v_subject text := coalesce(p_subject, '');
  v_body    text := coalesce(p_body, '');
  v_asks    int;
  v_unknown boolean;
begin
  if btrim(v_subject) = '' then
    v_rules := v_rules || 'empty_subject'::text;
  end if;

  -- Everything below reads the body. An empty one fails all of them at once,
  -- and reporting that five ways is not more useful than reporting it once.
  if btrim(v_body) = '' then
    return v_rules || 'empty_body'::text;
  end if;

  -- U+2014 EM DASH and U+2013 EN DASH. Both: an en dash used as a clause break
  -- reads identically and is the obvious workaround.
  if v_subject ~ '[—–]' or v_body ~ '[—–]' then
    v_rules := v_rules || 'em_dash'::text;
  end if;

  -- Loss framing. A vocabulary rather than a sentiment model, because this has
  -- to be one line of SQL: a false negative costs one rewrite, a false positive
  -- would let bland copy through.
  if v_body !~* '\y(miss|misses|missed|missing|lose|loses|losing|lost|slip|slips|slipping|unanswered|ignored|leak|leaks|leaking|costing|walks away|walk away|walking away|never hears back|never hear back|straight to voicemail|goes to voicemail|no one answers|nobody answers|going elsewhere|somewhere else|someone else)\y' then
    v_rules := v_rules || 'loss_frame'::text;
  end if;

  -- The binary close: a question whose own sentence also contains "or".
  -- Bounded by sentence punctuation, so an "or" three sentences earlier does
  -- not satisfy it.
  if v_body !~* '[^.!?]*\yor\y[^.!?]*\?' then
    v_rules := v_rules || 'binary_close'::text;
  end if;

  v_asks := length(v_body) - length(replace(v_body, '?', ''));
  if v_asks <> 1 then
    v_rules := v_rules || 'one_ask'::text;
  end if;

  -- Aliased as m(parts) rather than bare `m`: a set-returning function in FROM
  -- names its single column after the alias, and being explicit here is the
  -- difference between reading a capture group and reading a whole row.
  select exists (
    select 1
      from regexp_matches(
             v_subject || ' ' || v_body,
             '\{\{\s*([a-zA-Z_]+)\s*\}\}',
             'g'
           ) as m(parts)
     where lower(parts[1]) <> all (app.template_variables())
  ) into v_unknown;

  if v_unknown then
    v_rules := v_rules || 'unknown_variable'::text;
  end if;

  return v_rules;
end;
$$;
