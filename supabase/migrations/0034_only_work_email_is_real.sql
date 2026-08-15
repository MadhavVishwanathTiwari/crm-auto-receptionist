-- Dropping the addresses nothing was allowed to use.
--
-- `email_1`, `email_2`, `email_3` and `likely_email` came across from Clay and
-- were imported "for reference". Nothing ever read them. The scheduler, the
-- Gmail layer, the templates, the suppression checks and the dedupe keys all
-- work off `work_email` and `work_email_norm` alone — by design, and it is
-- non-negotiable 4. A column whose entire contract is that nobody may use it is
-- a column that exists to be used by mistake.
--
-- What they actually held was mostly not the business: webmaster addresses, a
-- site builder's support desk (`support@webador.com`), and placeholders left in
-- an unedited template (`example@domain.com`, `name@email.com`, `your@email.com`).
-- Promoting one to a send target would have been worse than having no address.
--
-- Safe to drop rather than merely stop writing:
--   * all four are empty on every lead in the database
--   * no index, view, constraint or generated column references them
--   * `leads.raw` still holds the original CSV row for every lead, so the
--     underlying values remain answerable if a question ever needs one
--
-- If a future export justifies a second address, it should arrive as a real
-- feature with a reason to read it, not as four spare columns.

alter table public.leads
  drop column if exists email_1,
  drop column if exists email_2,
  drop column if exists email_3,
  drop column if exists likely_email;
