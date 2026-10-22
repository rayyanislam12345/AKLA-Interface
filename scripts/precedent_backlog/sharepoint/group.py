"""Collapse the checked SharePoint keepers into distinct documents.

Copies are the same file (sha1), or the same kind of document whose opening
text is near-identical (90%+ of word runs shared) with the group's first
member. Comparing to the first member, not any member, stops chains of
similar-but-different documents (one bank's lien letter, then its
hypothecation letter) from merging. Writes data/groups.json.
"""
import collections, json, re

q = {r["path"]: r for r in json.load(open("data/queue.json"))}
items = []
for line in open("data/checked.jsonl"):
    r = json.loads(line)
    if r["path"] in q and r.get("keep"):
        items.append(dict(q[r["path"]], **r))

def sh(t, n=8):
    w = re.findall(r"[a-z0-9]+", (t or "").lower())[:150]
    return {" ".join(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}

def sim(a, b):
    return len(a & b) / max(1, min(len(a), len(b)))

NAME_NOISE = {"akla", "hmco", "mtc", "c", "clean", "ready", "review", "the", "of", "ex", "sec", "nrf", "fully", "and", "pdf", "docx"}

def name_key(it):
    """The document's name with numbering, brackets, dates and copy noise
    removed, so "[Execution Version] Malir - Payment Agreement" in two backups
    matches, while "...Specified Assets" and "...Project Assets" do not."""
    words = re.findall(r"[a-z]+", it["key"])
    return " ".join(w for w in words if w not in NAME_NOISE)

def kind(it):
    return it.get("type_id") or (it.get("new_type_name") or "").lower().replace("-", " ").replace("&", "and")

lib = [(r["fn"], sh(r["head"])) for r in json.load(open("data/library.json"))]
groups = []
for it in sorted(items, key=lambda x: (x["ext"] != "docx", x["executed"] != "signed")):
    s = sh(it.get("head"))
    it["lib_match"] = next((fn for fn, ls in lib if sim(s, ls) >= 0.9), None)
    for g in groups:
        first = g[0]
        if first["sha1"] == it["sha1"] or (
            kind(first) == kind(it) and sim(first["_sh"], s) >= 0.9 and name_key(first) == name_key(it)
        ):
            g.append(dict(it, _sh=s))
            break
    else:
        groups.append([dict(it, _sh=s)])
json.dump([[{k: v for k, v in x.items() if k != "_sh"} for x in g] for g in groups], open("data/groups.json", "w"), indent=1)
print(f"{len(items)} keepers -> {len(groups)} distinct documents; "
      f"{sum(1 for g in groups if g[0]['lib_match'])} already in the library")
