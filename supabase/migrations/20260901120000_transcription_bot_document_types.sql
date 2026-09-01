-- New document types for meeting output uploaded from transcription-bot
-- (a separate Electron app) — nothing existing fits meeting transcripts,
-- minutes, or client proposal letters; every current document_type is a
-- transactional agreement category.
insert into public.document_types (name, category) values
  ('Meeting Transcript', 'Meetings & Correspondence'),
  ('Meeting Minutes', 'Meetings & Correspondence'),
  ('Client Proposal Letter', 'Meetings & Correspondence');
