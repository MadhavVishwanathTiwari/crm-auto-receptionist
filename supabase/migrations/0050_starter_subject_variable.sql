-- The subject 0049 left behind.
--
-- 0049 turned "Hey Name," and "Company's site" in the body of "T1 dropping
-- off" into variables and left its subject alone: "got you this name". That is
-- the same placeholder written as a word, and lowercase at the end of a line it
-- is not something lib/write/placeholders.ts can tell from a real sentence, so
-- /write would put it in the subject box and send it on one Ctrl+Enter.
--
-- As a variable it behaves like the body now does: filled in when the lead has
-- a first name, refused by the composer's leftover check until the operator
-- writes one when it does not.
--
-- Keyed by id AND by the text being replaced, as 0049 was: on a fresh stack the
-- row does not exist, and a subject somebody has since rewritten is theirs.

update public.templates t
   set subject = 'got you this, {{first_name}}'
 where t.id = '43b656bc-33ed-4a20-a082-d04de69635eb'
   and t.is_active = false
   and t.subject = 'got you this name';
