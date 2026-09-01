-- Standard versions are now uploaded (a real .docx) rather than edited
-- inline — content_html stays as the extracted text used for AI context,
-- but the actual uploaded file now needs a permanent home so associates
-- can also open/view the real document.
alter table public.document_type_templates
  add column storage_path text,
  add column filename text;
