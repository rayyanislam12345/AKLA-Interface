-- Fills heading, heading_norm, clause_no and family on existing precedent
-- passages (20261021090000_clause_bank.sql). Safe to run more than once;
-- run in batches by document when applying through the management API.
-- --------------------------------------------------------------- backfill
update public.precedent_passages pp
   set heading = h.heading,
       heading_norm = public.clause_heading_norm(h.heading),
       clause_no = h.clause_no
  from public.documents d
  cross join lateral public.precedent_passage_headings(d.content, coalesce(d.heading_path, d.metadata->>'heading_path')) h
 where d.is_precedent
   and pp.document_id = d.id
   and pp.ordinal = h.ordinal
   and (pp.heading is distinct from h.heading or pp.clause_no is distinct from h.clause_no or pp.heading_norm is distinct from public.clause_heading_norm(h.heading));

update public.precedent_passages pp
   set family = public.clause_bank_family(dt.name)
  from public.document_types dt
 where dt.id = pp.document_type_id
   and pp.family is distinct from public.clause_bank_family(dt.name);
