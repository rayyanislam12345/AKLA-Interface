-- Split the eleven-file "Legal Opinion" document (project c5bc1387) into separate
-- documents. Approved by Rayyan on 18 Oct 2026.
--
-- On 7 Sep, before bulk upload existed, eleven unrelated files were uploaded as
-- eleven "versions" of one document. Versions 1-10 become their own documents,
-- titled from their file names, each as version 1; the legal opinion (v11) stays
-- on the original document as its only version. Nothing is deleted: the files
-- and their read passages are kept and re-linked. Comparisons between the
-- unrelated "versions" are cleared; proof checks are kept.
--
-- Run the whole file once in the Supabase SQL editor. The last SELECT reports
-- 10 moved, 1 left on the original, and the number of passages re-linked.

begin;
create temp table split_map on commit drop as
select v.id as version_id, v.version_number, gen_random_uuid() as doc_id, t.title, v.created_at
  from public.document_versions v
  join (values
    (1,'Implementation Agreement'),
    (2,'EPA Schedule'),
    (3,'EPA Agreement (pages 1-46)'),
    (4,'EPA Agreement (pages 47-92)'),
    (5,'Determination of Tariff for ZEPL (TRF-95, 23 May 2008)'),
    (6,'EPA Agreement (pages 93-138)'),
    (7,'ZEPL Licence LAG-104 (21 Jan 2008)'),
    (8,'RE Policy for Development of Power Generation 2006'),
    (9,'Submission of Signed Novation Agreement - Regulatory Compliance'),
    (10,'Decision of ZEPL (13 Dec 2011)')) t(version_number, title) on t.version_number = v.version_number
 where v.matter_document_id = 'c9dc0fa9-c4cc-420c-9595-854afc99b582';

insert into public.matter_documents (id, matter_id, document_type_id, title, status, owner_id, created_by, created_at, updated_at, last_version_number)
select doc_id, 'c5bc1387-df6f-4b04-b342-389d164d7d15', null, title, 'drafting', null,
       'ccac1529-27df-4d2b-9524-2042d671c741', created_at, now(), 1
  from split_map;

update public.document_versions v
   set matter_document_id = m.doc_id, version_number = 1,
       compared_with_version_id = null, changes_from_previous = null
  from split_map m where v.id = m.version_id;

update public.documents d
   set matter_document_id = m.doc_id, version_number = 1
  from split_map m where d.document_version_id = m.version_id;

-- The legal opinion becomes the original document's version 1.
update public.document_versions
   set version_number = 1, compared_with_version_id = null, changes_from_previous = null
 where matter_document_id = 'c9dc0fa9-c4cc-420c-9595-854afc99b582';
update public.matter_documents set last_version_number = 1, updated_at = now()
 where id = 'c9dc0fa9-c4cc-420c-9595-854afc99b582';

select (select count(*) from split_map) as moved,
       (select count(*) from public.document_versions where matter_document_id = 'c9dc0fa9-c4cc-420c-9595-854afc99b582') as left_on_original,
       (select count(*) from public.documents d join split_map m on d.document_version_id = m.version_id where d.matter_document_id = m.doc_id) as passages_relinked;
commit;
