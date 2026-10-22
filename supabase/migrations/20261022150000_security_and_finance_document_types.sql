-- Thirteen document types for the executed precedents harvested from the
-- firm's SharePoint on 22 Oct 2026. Most are security and finance documents
-- (assignments, hypothecation and other charges, liens, security trust deeds,
-- guarantees, sponsor support) that the library had no home for, so they were
-- either misfiled under the agreement they secure or left out altogether.
-- Names that meant the same thing were merged before creating any of them.
insert into public.document_types (name, category) values
  ('Assignment Agreement / Deed', 'Financing & Security'),
  ('Hypothecation / Mortgage / Charge', 'Financing & Security'),
  ('Letter of Lien and Set-Off', 'Financing & Security'),
  ('Security Trust Deed', 'Financing & Security'),
  ('Sponsor Support Agreement / Undertaking', 'Financing & Security'),
  ('Accession / Adherence Deed', 'General/Legal'),
  ('Guarantee / Indemnity', 'Financing & Security'),
  ('Facility Agreement', 'Financing & Security'),
  ('Fee Letter', 'Financing & Security'),
  ('Accounts Agreement', 'Financing & Security'),
  ('Share Purchase Agreement', 'Equity & Commercial'),
  ('Development Services Agreement', 'Project & Concession'),
  ('Utility Supply Agreement (Power / Gas / Water)', 'Project & Concession')
on conflict (name) do nothing;
