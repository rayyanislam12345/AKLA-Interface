-- Records public.precedent_paragraphs exactly as it runs in production
-- (read with pg_get_functiondef on 21 Oct 2026). Production had been changed
-- by hand after 20260921090000_precedent_passages.sql: a paragraph over 2,400
-- characters is cut by grouping whole sentences into pieces of about 2,000
-- characters, not by a .{1800,2200} repetition (Postgres refuses repetition
-- counts over 255). This file only brings the repository level with the
-- database; applying it to production changes nothing.
CREATE OR REPLACE FUNCTION public.precedent_paragraphs(p_content text)
 RETURNS TABLE(ordinal integer, body text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  with paragraphs as (
    select row_number() over () as n, b
    from (
      select btrim(regexp_replace(
               replace(replace(replace(replace(replace(
                 regexp_replace(part, '<[^>]*>', ' ', 'g'),
                 '&amp;', '&'), '&quot;', '"'), '&#39;', ''''), '&nbsp;', ' '), '&lt;', '<'),
               '\s+', ' ', 'g')) as b
      from regexp_split_to_table(
        regexp_replace(coalesce(p_content, ''), '<img[^>]*>', '', 'gi'),
        '</(?:p|li|h[1-6]|tr|td|div)>|<br\s*/?>|\n+', 'i') as part
    ) raw
    where length(b) >= 40
  ),
  sentences as (
    select p.n, s.k, s.sentence,
           sum(length(s.sentence) + 1) over (partition by p.n order by s.k) as upto
    from paragraphs p,
         lateral (
           select row_number() over () as k, sentence
           from regexp_split_to_table(regexp_replace(p.b, '([.;:])\s+', '\1' || chr(1), 'g'), chr(1)) as sentence
         ) s
    where length(p.b) > 2400
  ),
  pieces as (
    select n, 0::bigint as g, b as piece from paragraphs where length(b) <= 2400
    union all
    select n, ((upto - 1) / 2000)::bigint, string_agg(sentence, ' ' order by k)
    from sentences
    group by n, ((upto - 1) / 2000)::bigint
  )
  select (row_number() over (order by n, g))::integer, left(btrim(piece), 4000)
  from pieces
  where length(btrim(piece)) >= 40;
$function$;
