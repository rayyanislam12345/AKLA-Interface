-- Presentations and reports as first-class document types. Every existing
-- type is a transactional agreement (or a meeting output), so a client deck
-- or a diligence report uploaded to a matter had nothing honest to be filed
-- under. Category is free text, so these are just more rows — admins can
-- rename or extend them from Document Types.
insert into public.document_types (name, category) values
  ('Client Presentation', 'Presentations'),
  ('Pitch Deck', 'Presentations'),
  ('Training Presentation', 'Presentations'),
  ('Due Diligence Report', 'Reports'),
  ('Legal Opinion', 'Reports'),
  ('Status Report', 'Reports'),
  ('Research Memo', 'Reports')
on conflict (name) do nothing;
