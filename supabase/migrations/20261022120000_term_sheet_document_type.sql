-- Term sheets and heads of terms record the commercial deal before the long
-- form is drafted. The library review found two filed under the agreements
-- they lead to (a shareholders agreement, an implementation agreement), and
-- the SharePoint harvest turns up more, so they get a type of their own.
insert into public.document_types (name, category) values
  ('Term Sheet / Heads of Terms', 'General/Commercial')
on conflict (name) do nothing;
