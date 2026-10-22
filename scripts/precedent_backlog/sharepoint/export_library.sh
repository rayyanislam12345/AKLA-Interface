#!/bin/zsh
# Snapshot of the precedent library (one row per file, with its opening text)
# and of the document types, for the shortlist and the library review.
cd "$(dirname "$0")"
./sql.sh "with f as (select d.metadata->>'storage_path' sp, min(d.metadata->>'filename') fn, dt.name type_name, dt.category, count(*) chunks, sum(length(d.content)) chars from documents d join document_types dt on dt.id=d.document_type_id where d.is_precedent group by 1,3,4), h as (select distinct on (d.metadata->>'storage_path') d.metadata->>'storage_path' sp, left(regexp_replace(d.content,'\s+',' ','g'),900) head from documents d where d.is_precedent order by d.metadata->>'storage_path', (d.metadata->>'chunk_index')::int nulls last, d.id) select f.*, h.head from f join h using(sp) order by f.type_name, f.fn" > data/library.json
./sql.sh "select id,name,category from document_types order by category,name" > data/types.json
python3 -c "import json; print(len(json.load(open('data/library.json'))), 'precedents,', len(json.load(open('data/types.json'))), 'types')"
