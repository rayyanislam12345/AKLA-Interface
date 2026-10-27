import json, re, zipfile, collections, sys
sys.path.insert(0,'.')
from measure import Styles, val, onoff, NS, q, read
from lxml import etree
R=json.load(open('grouped.json'))
FAM={'Reports':'reports','Meetings & Correspondence':'letters','General/Legal':'opinions'}
def scan(path):
    z=zipfile.ZipFile(path); st=Styles(z); doc=read(z,'word/document.xml'); body=doc.find('w:body',NS)
    head=sc=0; parties=0; defparen=defquote=0; cover=False; first_pages=[]
    paras=[]
    for p in body.iter(q('p')):
        ppr=p.find('w:pPr',NS); sid=val(ppr,'pStyle') or st.default_para; chain=st.chain(sid)
        rs=[c.find('w:rPr',NS) for c in chain]+[st.rdef]
        chars=[]
        for r in p.iter(q('r')):
            t=''.join(x.text or '' for x in r.iter(q('t')))
            if not t: continue
            rpr=r.find('w:rPr',NS); rl=[rpr]+rs
            chars.append((t, st.rprop(rl,lambda x:onoff(x,'b')) or False, st.rprop(rl,lambda x:onoff(x,'smallCaps')) or False, st.rprop(rl,lambda x:onoff(x,'caps')) or False))
        text=''.join(c[0] for c in chars)
        if not text.strip(): continue
        paras.append((text,chars))
        vis=[c for c in chars if c[0].strip()]
        if 2<=len(text.strip())<=80 and vis and all(c[1] for c in vis):
            head+=1; sc+= all(c[2] for c in vis)
        flags=[]
        for c in chars: flags+=[c[1]]*len(c[0])
        for m in re.finditer(r"\((?:the|this|each|together|collectively)?[^()]{0,40}?\b([A-Z][\w&’' -]{1,40})\)", text):
            s,e=m.span(1)
            if all(flags[s:e]): defparen+=1
        for m in re.finditer(r"[“\"]([A-Z][^”\"]{1,50})[”\"]", text): defquote+=1
    opening=' '.join(t for t,_ in paras[:15])
    cover = bool(re.search(r"\b(By\s*&\s*Between|BY AND BETWEEN|Between)\b", opening, re.I)) and bool(re.search(r"Dated|DATED", opening))
    raw=b''.join(z.read(n) for n in z.namelist() if re.match(r'word/header\d*\.xml',n))
    water = b'textpath' in raw.lower() or b'PowerPlusWaterMarkObject' in raw
    hdr_sc = b'smallCaps' in raw
    logo = b'<w:drawing' in raw or b'v:imagedata' in raw
    title=paras[0] if paras else ('',[])
    tsc= all(c[2] for c in title[1] if c[0].strip()) if title[1] else False
    return dict(head=head, sc=sc, defparen=defparen, defquote=defquote, cover=cover, water=water, hdr_sc=hdr_sc, logo=logo, title_sc=tsc)
out=collections.defaultdict(list)
for r in R:
    if r['group'] not in ('akla','other','draft'): continue
    try: s=scan(('drafts/' if r['group']=='draft' else 'docs/')+(r['path'] if r['group']=='draft' else r['file']))
    except Exception as e: print('ERR',e); continue
    out[(r['group'], FAM.get(r['category'],'agreements') if r['group']!='draft' else 'draft')].append(s)
for k,v in sorted(out.items()):
    n=len(v)
    hs=[x['sc']/x['head'] for x in v if x['head']>=3]
    print(k, n, f"bold headings mostly small caps: {sum(h>0.5 for h in hs)}/{len(hs)}", f"title small caps {sum(x['title_sc'] for x in v)}/{n}", f"cover page {sum(x['cover'] for x in v)}/{n}", f"watermark {sum(x['water'] for x in v)}/{n}", f"header small caps {sum(x['hdr_sc'] for x in v)}/{n}", f"header logo {sum(x['logo'] for x in v)}/{n}", f"defined (bold in brackets) {sum(x['defparen'] for x in v)} vs quoted {sum(x['defquote'] for x in v)}")
