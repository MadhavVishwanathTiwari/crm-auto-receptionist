-- Adds madhav@tryautoreceptionist.com as a second login identity.
--
-- 0008 put login on the primary domain on the assumption that the secondary
-- domains were for sending only. That was backwards in practice: outreach runs
-- from the secondary domains, so that is where the working day happens, and
-- making someone switch Google accounts to reach the tool that drives it is
-- friction for no security gain. Both addresses are in the same Workspace and
-- belong to the same person.
--
-- Named as an address rather than a domain because the allowlist is keyed that
-- way and there is exactly one account on tryautoreceptionist.com. A second
-- account there would need its own row, which is the intended amount of
-- friction for adding a person.
--
-- KNOWN CONSEQUENCE, and the reason this is a comment rather than a silent
-- insert: the app identifies an operator by auth user, so these two addresses
-- are two operators. Leads claimed while signed in as one do not read as
-- "mine" while signed in as the other, the audit queue only offers a lead to
-- whoever holds it, and nothing errors when they diverge -- it just looks
-- wrong. Consolidating onto one login is free while the org holds no claimed
-- leads and stops being free after that.

insert into app.login_allowlist (email, role, org_id, note)
select 'madhav@tryautoreceptionist.com',
       'admin'::public.org_role,
       o.id,
       'Workspace secondary domain. Same human as madhav@autoreceptionist.io.'
  from public.orgs o
 where o.slug = 'auto-receptionist'
on conflict (email) do nothing;
