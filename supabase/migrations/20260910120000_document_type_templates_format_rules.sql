-- A short description of how the standard .docx is formatted (its clause
-- numbering scheme, heading treatment, body font), computed from the file
-- when it is uploaded, so the drafting prompt can tell the model how its
-- Markdown maps onto the firm's numbering. The file itself is what the
-- export is built inside of; this column is only the words for the prompt.
alter table public.document_type_templates
  add column if not exists format_rules text;
