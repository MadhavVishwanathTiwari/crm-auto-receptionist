-- The demo link gets words on it.
--
-- T2 and T3 put {{demo_url}} on a line of its own because an email went out as
-- plain text and a bare address was the only link there was. The dispatcher now
-- sends an HTML part beside the text (lib/gmail/body.ts), so `[words](url)`
-- reads as the words, linked, and the plain part keeps the address beside them.
--
-- Only a body still holding the seeded sentence changes. A template somebody
-- rewrote is theirs, and replace() on a sentence it no longer contains is a
-- no-op. The copy still lints clean: no question mark or dash was added.

update templates
   set body = replace(
     body,
     $old$This is a live receptionist for {{company_name}}, answering the way yours would if anybody were free:

{{demo_url}}$old$,
     $new$[This is a live receptionist for {{company_name}}]({{demo_url}}), answering the way yours would if anybody were free.$new$
   )
 where name = 'T2 demo link';

update templates
   set body = replace(
     body,
     $old$The receptionist I built for {{company_name}} is still up:

{{demo_url}}$old$,
     $new$[The receptionist I built for {{company_name}}]({{demo_url}}) is still up.$new$
   )
 where name = 'T3 still live';

update templates
   set body = replace(
     body,
     $old$so you can hear it rather than take my word for it:

{{demo_url}}$old$,
     $new$so you can [hear it for yourself]({{demo_url}}) rather than take my word for it.$new$
   )
 where name = 'T2 no audit demo link';

update templates
   set body = replace(
     body,
     $old$The demo I built for {{company_name}} is still up:

{{demo_url}}$old$,
     $new$[The demo I built for {{company_name}}]({{demo_url}}) is still up.$new$
   )
 where name = 'T3 no audit still live';
