import json, re, collections
R=[json.loads(l) for l in open('m.jsonl')]
AK = re.compile(r"ali khan law|\bakla\b|usama siddiqui|usman siddiqui|ayaan qureshi|ahmed yasin|areen|zainab aamir|moiz ali khan|huroom|umer maroof|haya ansari|aiman mehmood|rumaisa|ali asgher", re.I)
OTHER = re.compile(r"vellani|haidermota|hmco|barker gillette|riaa|tayebaly|\bmtc\b|mt&co|axis law|ashurst|herbert smith|freehills|fkm|sojitz|kabraji|orr,? dignam|surridge|bnr|cms|clifford|allen|linklaters|norton|baker|dentons|pwc|pricewaterhouse|engelhard|engie|lmca|nlp|sattar|ebrahim", re.I)
def group(r):
    c = (r.get('creator') or '') + ' ' + (r.get('company') or '')
    m = r.get('lastModifiedBy') or ''
    if AK.search(c): return 'akla'
    if OTHER.search(c): return 'other'
    if AK.search(m) and not OTHER.search(m): return 'akla_edit'
    if OTHER.search(m): return 'other'
    return 'unknown'
for r in R: r['group'] = 'draft' if r['type']=='DRAFT' else group(r)
json.dump(R, open('grouped.json','w'))
print(collections.Counter(r['group'] for r in R))
print(collections.Counter((r['group'], r['category']) for r in R if r['group'] in ('akla','akla_edit')).most_common())
print('unknown creators:', collections.Counter(r.get('creator') for r in R if r['group']=='unknown').most_common(30))
