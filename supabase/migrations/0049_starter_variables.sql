-- Two starter drafts said "Name" and "Company" where they meant a variable.
--
-- "T1 dropping off" opened "Hey Name," and pointed at "Company's site"; "T1
-- Casual , PI" said "forms, name." and "I think Company would". Neither holds a
-- {{variable}}, so /write filled them in untouched and the leftover check that
-- stops a written email going out with braces showing had nothing to catch:
-- "Hey Name" was one Ctrl+Enter from a real prospect.
--
-- As variables they behave the way every other starter does. {{company_name}}
-- always fills. A lead with no first name keeps {{first_name}}, and the composer
-- refuses to send it until the operator types a name or drops the greeting --
-- which is exactly the decision that has to be made by a person.
--
-- Both stay drafts. {{first_name}} is null on most imports, and the dispatcher
-- skips a templated send with a missing variable (see CLAUDE.md), so neither is
-- fit for the planner as written.
--
-- Keyed by id AND by the text being replaced: on a fresh stack these rows do not
-- exist, and a draft somebody has since rewritten is theirs, not this file's.

update public.templates t
   set body = replace(replace(t.body,
                'Hey Name,', 'Hey {{first_name}},'),
                'on Company''s site', 'on {{company_name}}''s site')
 where t.id = '43b656bc-33ed-4a20-a082-d04de69635eb'
   and t.is_active = false
   and position('Hey Name,' in t.body) = 1;

update public.templates t
   set body = replace(replace(t.body,
                'filling forms, name.', 'filling forms, {{first_name}}.'),
                'I think Company would', 'I think {{company_name}} would')
 where t.id = '69e43ed9-c527-4bac-a83e-0c8a0293d441'
   and t.is_active = false
   and position('filling forms, name.' in t.body) > 0;
