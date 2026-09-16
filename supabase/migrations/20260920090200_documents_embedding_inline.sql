-- Every library search was taking one to eight seconds on a table of 7,000
-- rows: the planner reads the rows a filter allows and computes the
-- distance for each, and each embedding (4 KB, stored out of line in TOAST)
-- cost several page reads to fetch. Kept inline, the row still fits a page
-- (the document text itself stays in TOAST) and an exact scan of the whole
-- table is a fraction of a second.
alter table public.documents alter column embedding set storage plain;
-- The storage mode only applies to values written from now on, and an update
-- that leaves a column's value unchanged keeps its existing TOAST pointer,
-- so the rewrite has to produce a new datum: adding a zero vector does,
-- exactly. The text column is untouched, so its TOAST data stays put.
update public.documents set embedding = embedding + array_fill(0::real, array[1024])::vector;
analyze public.documents;
