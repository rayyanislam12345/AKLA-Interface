"""Shortlist the firm's SharePoint (synced by OneDrive) for precedent candidates, by name only.

The files are cloud-only, so nothing is opened here: only names, sizes and
dates. Each document's many copies across people's backups collapse to one,
anything already in the library or already judged from the Passport drive is
dropped, and only executed versions are queued (never drafts, and on an open
matter only signed copies).

    ./export_library.sh && python3 shortlist.py
Writes data/shortlist.json (every distinct document) and data/queue.json.
"""
import collections, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
sys.path.insert(0, os.path.dirname(HERE))
import filenames, classify  # noqa: E402

ROOT = os.path.expanduser("~/Library/CloudStorage/OneDrive-AliKhanLawAssociate/Ali Khan Law Associates - Documents/")
types = json.load(open(f"{DATA}/types.json"))
by_name = {t["name"]: t for t in types}
alias = classify.build_alias_table(types)

# The names the firm actually uses for its types, tried after the type names.
EXTRA = [
    (r"\bshareholders?'? agreement\b|\bsha\b", "Shareholders Agreement"),
    (r"\bjoint venture\b|\bjva\b|\bconsortium agreement\b", "Joint Venture Agreement"),
    (r"\bmou\b|\bmemorandum of understanding\b", "Memorandum of Understanding (MOU)"),
    (r"\bdirect agreement\b|\bcda\b", "Concession Direct Agreement"),
    (r"\bstandard concession\b|\bconcession agreement\b|\b(?<!e)ca\b", "Concession Agreement"),
    (r"\bimplementation agreement\b", "Implementation Agreement"),
    (r"\bindependent engineer\b|\bie agreement\b", "Independent Engineer's Agreement"),
    (r"\bo ?& ?m\b|\boperation and maintenance\b|\boperations? (and|&) maintenance\b", "Operation & Maintenance (O&M) Agreement"),
    (r"\bsite licen[cs]e\b|\bpsla\b", "Site License Agreement"),
    (r"\bmusharaka\b|\bijara\b|\bijarah\b|\bmurabaha\b|\bsukuk\b|\bistisna\b|\bdiminishing musharak", "Islamic Finance Agreement"),
    (r"\bintercreditor\b", "Intercreditor Agreement"),
    (r"\bcommon terms\b|\bcta\b", "Common Terms Agreement (CTA)"),
    (r"\bescrow\b", "Escrow Agreement"),
    (r"\bpledge\b", "Share Pledge Agreement"),
    (r"\bepc\b", "EPC Contract"),
    (r"\bsupply (agreement|contract)\b", "Supply Contract"),
    (r"\bsub-?contract", "Subcontracting Agreement"),
    (r"\btrack access\b|\btaa\b", "Track Access Agreement"),
    (r"\benergy purchase\b|\bepa\b|\bpower purchase\b|\bppa\b", "Energy Purchase Agreement (EPA)"),
    (r"\bframework agreement\b", "Framework Agreement"),
    (r"\bamendment\b|\baddendum\b|\bsupplemental agreement\b", "Amendment Agreement"),
    (r"\blegal opinion\b|\bopinion\b", "Legal Opinion"),
    (r"\bfee proposal\b|\bengagement letter\b|\bproposal\b", "Client Proposal Letter"),
    (r"\bminutes\b|\bmom\b", "Meeting Minutes"),
    (r"\bboard resolution\b|\bresolutions?\b", "Board Resolution"),
    (r"\bpower of attorney\b|\bpoa\b", "Power of Attorney"),
    (r"\bnoc\b|\bno objection\b|\bcertificate\b|\bconsent\b", "Certificate / Consent / NOC"),
    (r"\bdue diligence\b|\bdd report\b|\bldd\b", "Due Diligence Report"),
    (r"\brfp\b|\brequest for proposal\b|\binstructions? to bidders\b", "Request for Proposal (RFP)"),
    (r"\bresearch\b|\bmemo\b|\bmemorandum\b|\binternal note\b", "Research Memo"),
    (r"\bletter\b|\bnotice\b", "Letter / Notice"),
]
EXTRA = [(re.compile(p, re.I), by_name[n]) for p, n in EXTRA if n in by_name]

# A real legal instrument whose type the library doesn't have yet.
INSTRUMENT = re.compile(r"\b(agreement|contract|deed|undertaking|guarantee|indemnity|bond|lease|licen[cs]e|charter|bye-?laws|articles of association|memorandum of association|trust deed|offering|prospectus|term sheet|side letter)\b", re.I)

# Working papers, not drafting precedents.
NOISE = re.compile(
    r"compar|\btrack(ed)?\b|redline|mark-?up|\bmu\b|comments?\b|\bquestions?\b|key matters|\bbrief\b|tracker|checklist|"
    r"issues? list|\bnotes?\b|summary|\bemail\b|cover letter|translation|\btimeline\b|\bagenda\b|\bpresentation\b|"
    r"\binvoice\b|\breceipt\b|\bcv\b|\bresume\b|\bscan(ned)?\b|\bjudgment\b|\border\b|\bpetition\b|\btimesheet\b|"
    r"\bdictation\b|\btranscript\b|\bwork stream\b|\bmatrix\b|\binstructions? for\b|\bguidance\b|\bdeviation",
    re.I,
)
# The firm's matter-numbered names: "SKM93.3 - ", "PTQ6.8 - ", "ADB68.13 - ".
MATTER_PREFIX = re.compile(r"^\s*[A-Z][A-Za-z&]{1,7}\s*\[?X?\]?\d*(\.\d+)*\s*-\s*")
# Folders that sit between a backup and the matter folder.
CONTAINER = re.compile(r"^(akla|backup|backups|back ups|old transactions|active transactions|my transactions|assigned|office work|akla internal|\d+\.\s*backups.*|.*backup.*|resigned employees|akla - data room|.*\(old files\).*|.*\[.*20\d\d\].*)$", re.I)
EMPLOYEE = re.compile(r".* - backup$|^tayyaba hyder$|^moiz ali khan$|^fateh khan.*$|^mj$|^hj$", re.I)

STATUS_RANK = [(r"execution|\bexe\b|signed|executed", 6), (r"pre-?exe", 5), (r"final", 4), (r"cir(culated)? ?ver|\bcir\b", 3), (r"clean", 2)]

# Only closed, executed instruments go into the library (Rayyan, 22 Oct 2026):
# no earlier drafts, and nothing still being negotiated on an open matter.
SIGNED = re.compile(r"\bsigned\b|\bexecuted\b|fully executed", re.I)
EXECUTION_VERSION = re.compile(r"execution version|\bexe(cution)? ver\b|\[exe\]|\bexecution\b", re.I)
STILL_A_DRAFT = re.compile(r"draft|pre-?exe|\bwd\b|working|rough|\bcir\b|circulated|for review|proposed|unsigned", re.I)
# The Hub's active matters (matters.status = 'active'), as their SharePoint
# folders and file prefixes name them, plus anything filed as an active transaction.
OPEN_MATTER = re.compile(
    r"/active transactions/|qayyumabad|qayumabad|\bptq\d*\b|\bm6\b|pakistan railways|\bpr\d+\b|zorlu|sapphire|\bsadb\b|"
    r"manora|gas pipeline|discos?\b|\bosler\b|privati[sz]ation commission",
    re.I,
)


def executed_stage(rel, stem):
    """'signed' or 'execution' for a closed instrument, else None."""
    if STILL_A_DRAFT.search(stem):
        return None
    if SIGNED.search(stem):
        return "signed"
    if EXECUTION_VERSION.search(stem) and not OPEN_MATTER.search("/" + rel.lower()):
        # An execution version on an open matter may still change before it
        # is signed, so there only a signed copy counts.
        return "execution"
    return None


def type_of(stem):
    s = stem.lower()
    for a, dt in alias:
        if re.search(rf"\b{re.escape(a)}\b", s):
            return dt
    for rx, dt in EXTRA:
        if rx.search(stem):
            return dt
    return None


def matter_of(rel):
    for p in rel.split("/")[:-1]:
        if not (CONTAINER.match(p.strip()) or EMPLOYEE.match(p.strip())):
            return p.strip()
    return "?"


def status_rank(name):
    n = name.lower()
    return max((r for p, r in STATUS_RANK if re.search(p, n)), default=0)


def norm_key(stem):
    stem = filenames.strip_numbering(MATTER_PREFIX.sub("", stem))
    k = filenames.group_key(stem)
    k = re.sub(r"\b(akla|wd|working|latest|version|ver|copy|updated|new|cir|circulated|pre exe|exe|execution|us|ay|ey|rec|\d+(st|nd|rd|th))\b", " ", k)
    return re.sub(r"\s+", " ", k).strip()


def main():
    listing = f"{DATA}/files.txt"
    if not os.path.exists(listing):
        with open(listing, "w") as f:
            subprocess.run(["find", ROOT, "-type", "f", "(", "-iname", "*.docx", "-o", "-iname", "*.pdf", ")"], stdout=f, check=True)

    lib_keys = {norm_key(os.path.splitext(r["fn"])[0]) for r in json.load(open(f"{DATA}/library.json"))}
    judged = {}
    for v in json.load(open(os.path.join(os.path.dirname(HERE), "manifest.json"))).values():
        judged.setdefault(norm_key(os.path.splitext(os.path.basename(v["path"]))[0]), v["outcome"])

    rows = []
    for line in open(listing):
        path = line.rstrip("\n")
        fn = os.path.basename(path)
        if fn.startswith("~"):  # Word lock files, some with mangled names
            continue
        stem, ext = os.path.splitext(fn)
        clean = MATTER_PREFIX.sub("", stem)
        if NOISE.search(clean):
            continue
        dt = type_of(clean)
        if not dt and not INSTRUMENT.search(clean):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        rel = path[len(ROOT):]
        rows.append({
            "path": path, "rel": rel, "filename": fn, "ext": ext.lower().lstrip("."), "size": st.st_size, "mtime": st.st_mtime,
            "matter": matter_of(rel), "key": norm_key(stem),
            "type": dt["name"] if dt else None, "type_id": dt["id"] if dt else None,
            "date": str(filenames.extract_date(stem) or ""), "status": status_rank(stem), "executed": executed_stage(rel, stem),
        })
    print("name-matched files:", len(rows))

    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r["matter"].lower(), r["key"])].append(r)

    out = []
    for (_matter, key), g in groups.items():
        # Only an executed copy can win. Among those a Word file beats a PDF,
        # because a signed PDF is usually a scan with no text.
        g.sort(key=lambda r: (r["executed"] is not None, r["ext"] == "docx", r["executed"] == "signed", r["date"], r["mtime"]), reverse=True)
        best = dict(g[0], copies=len(g))
        best["known"] = "in_library" if key in lib_keys else ("passport_" + judged[key] if key in judged else None)
        out.append(best)
    json.dump(out, open(f"{DATA}/shortlist.json", "w"), indent=1)

    queue = [r for r in out if not r["known"] and r["executed"] and r["size"] > 0]
    # Word files first: smaller, quicker to fetch, and the better precedents.
    queue.sort(key=lambda r: (r["ext"] != "docx", r["size"]))
    json.dump(queue, open(f"{DATA}/queue.json", "w"), indent=1)
    print(f"distinct documents: {len(out)}; queued (executed, not yet known): {len(queue)}")


if __name__ == "__main__":
    main()
