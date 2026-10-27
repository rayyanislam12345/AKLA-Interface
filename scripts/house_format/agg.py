import json, collections, sys
R=json.load(open('grouped.json'))
FAM={'Reports':'reports','Meetings & Correspondence':'letters/minutes','General/Legal':'opinions/legal','DRAFT':'DRAFT'}
for r in R: r['fam']=FAM.get(r['category'],'agreements')
def pct(n,d): return f"{round(100*n/max(d,1))}%"
def summ(rs, label):
    n=len(rs)
    if not n: return
    C=collections.Counter
    print(f"\n=== {label}: {n} docs")
    print(" page:", C((r.get('page'), r.get('landscape')) for r in rs).most_common(4))
    print(" margins (t,b,l,r):", C(tuple(r.get('margins_cm',{}).get(k) for k in ('top','bottom','left','right')) for r in rs).most_common(5))
    print(" body font:", C(r['fonts'][0][0] if r['fonts'] else None for r in rs).most_common(6))
    print(" body size:", C(r['sizes'][0][0] if r['sizes'] else None for r in rs).most_common(6))
    print(" main alignment:", C(r['justify'][0][0] if r['justify'] else None for r in rs).most_common(4))
    print(" line spacing (line,rule):", C(tuple(r['line'][0][0]) if r['line'] else None for r in rs).most_common(6))
    print(" space after pt:", C(r['after_pt'][0][0] if r['after_pt'] else None for r in rs).most_common(6))
    print(" space before pt:", C(r['before_pt'][0][0] if r['before_pt'] else None for r in rs).most_common(4))
    print(" first-line indent:", C(r['first_indent_cm'][0][0] if r['first_indent_cm'] else None for r in rs).most_common(4))
    auto=sum(1 for r in rs if r['numbered']>r['manual'] and r['numbered']>=5); man=sum(1 for r in rs if r['manual']>r['numbered'] and r['manual']>=5)
    print(f" numbering: auto-numbered {pct(auto,n)}, typed-in numbers {pct(man,n)}, little/none {pct(n-auto-man,n)}")
    for L in ('0','1','2','3'):
        print(f"  level {L}:", C((x[0][0],x[0][1]) for r in rs for k,x in r['levels'].items() if k==L and x).most_common(5))
    for L in ('0','1','2'):
        print(f"  indent L{L} (left,hanging):", C((x[0][2],x[0][3]) for r in rs for k,x in r['levels'].items() if k==L and x).most_common(4))
    hf=C(); 
    for r in rs:
        h=sum(r['heading_feats'].get(k,0) for k in ()) 
        t=r['headings'] or 0
        if t: 
            for k in ('bold','caps','underline','numbered'): hf[k]+= r['heading_feats'].get(k,0)/t
    print(" headings (avg share):", {k: round(v/max(1,sum(1 for r in rs if r['headings'])),2) for k,v in hf.items()}, "jc:", C(k for r in rs for k,v in r['heading_feats'].items() if k.startswith('jc:') for _ in range(v)).most_common(3))
    db=sum(r['defined'][0] for r in rs); dt=sum(r['defined'][1] for r in rs)
    print(f" defined terms in quotes bold: {pct(db,dt)} of {dt}; docs mostly bold: {sum(1 for r in rs if r['defined'][1]>=3 and r['defined'][0]/r['defined'][1]>0.5)}/{sum(1 for r in rs if r['defined'][1]>=3)}")
    cq=sum(r['quotes'][0] for r in rs); sq=sum(r['quotes'][1] for r in rs); print(f" curly quotes {pct(cq,cq+sq)}")
    print(f" colour used (>2% of text): {pct(sum(1 for r in rs if r['colour_share']>0.02),n)}", C(r['colours'][0][0] for r in rs if r['colours'] and r['colour_share']>0.02).most_common(5))
    print(f" tables: {pct(sum(1 for r in rs if r['tables']),n)}; TOC: {pct(sum(1 for r in rs if r['toc']),n)}")
    fp=sum(1 for r in rs if any(f['page'] for f in r['hf']['footer'])); hp=sum(1 for r in rs if any(f['page'] for f in r['hf']['header']))
    ft=sum(1 for r in rs if any(f['text'] for f in r['hf']['footer'])); ht=sum(1 for r in rs if any(f['text'] for f in r['hf']['header']))
    print(f" page number in footer {pct(fp,n)}, in header {pct(hp,n)}; footer text {pct(ft,n)}, header text {pct(ht,n)}")
    print("  footer page jc:", C(j for r in rs for f in r['hf']['footer'] if f['page'] for j in f['jc'][:1]).most_common(3))
    print("  footer texts:", C(f['text'][:50] for r in rs for f in r['hf']['footer'] if f['text']).most_common(6))
    print("  header texts:", C(f['text'][:50] for r in rs for f in r['hf']['header'] if f['text']).most_common(6))
    # title: first paragraph
    T=[r['title'][0] for r in rs if r['title']]
    print(f" title para: centred {pct(sum(t['jc']=='center' for t in T),len(T))}, bold {pct(sum(t['bold'] for t in T),len(T))}, caps {pct(sum(t['caps'] for t in T),len(T))}, underlined {pct(sum(t['und'] for t in T),len(T))}; size:", C(t['size'] for t in T).most_common(4))
    mk=C()
    for r in rs:
        for k,v in r['marks'].items():
            if v: mk[k]+=1
    print(" structure (docs with):", {k: pct(v,n) for k,v in mk.most_common()})
    print(" styles:", C(s[0] for r in rs for s in r['styles'][:2]).most_common(8))
G=sys.argv[1:] or ['akla','other']
for g in G:
    rs=[r for r in R if r['group']==g]
    summ(rs, g+' ALL')
    for f in ('agreements','letters/minutes','reports','opinions/legal'):
        summ([r for r in rs if r['fam']==f], f"{g} / {f}")
