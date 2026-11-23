"""Names to rows: the transaction an agenda names, the row a deliverable means, the people.

Scores are 0 to 1. The rows are passed in by the callers. The only thing read
from the database is the list of names each project goes by, once, when a
Matcher is built with a db: `Matcher(db)` lays the Hub's `matters` and
`project_names` over what config/transactions.yaml knows. `Matcher()` is the
YAML alone, exactly as in phase 1.
"""
import difflib
import re

from . import config

STOP = {'the', 'a', 'an', 'of', 'for', 'and', 'to', 'on', 'in', 'with', 'from', 'by', 'at', 'as', 'is',
        'be', 'this', 'that', 'its', 'draft', 'drafts', 'final', 'finalised', 'finalized', 'revised',
        'version', 'preparation', 'prepare', 'prepared', 'review', 'reviewed', 'same', 'deliverable',
        'deliverables', 'task', 'tasks', 'work', 'matter', 'matters', 'subject', 'meeting', 'discussion',
        'amended', 'aligned', 'updated', 'complete', 'completed', 'finalise', 'finalize', 'execution',
        'versions', 'changes', 'comments', 'comment', 'reviewing', 'review', 'preparing', 'prepare'}
CONTINUATION = re.compile(r'^(continuation of comments\b.*|.*\(contd\.?\)\s*)$', re.I)
# Words that say nothing about which project a name means ("X Project", "X (Private) Limited").
GENERIC = {'the', 'of', 'and', 'for', 'project', 'projects', 'limited', 'ltd', 'private', 'pvt', 'group',
           'company', 'co', 'matter', 'matters', 'transaction', 'deal'}
NEAR = 0.75            # two names this close may be one project: offer it rather than open a second
LONG_ALIAS = 60        # the extractor's longer "aliases" are notes for its reader, not names


def norm(text):
    text = (text or '').replace('–', '-').replace('—', '-').replace('’', "'")   # en dash, em dash, curly quote
    text = re.sub(r'[. ]', ' ', text.lower())
    text = re.sub(r'\s*-\s*', ' - ', text)
    return re.sub(r'\s+', ' ', text).strip(' -:;,')


def name_key(text):
    """A name as project_names.name_key stores it: lower case, every run of anything
    but a-z and 0-9 turned into one space, trimmed. Must stay equal to the SQL:
    btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g'))."""
    return re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).strip(' ')


def split_pair(text):
    """'CLIENT / PROJECT' (a 'sheet' name) to (client, project), or None when it is not a pair."""
    for sep in (' / ', '/'):
        if sep in (text or ''):
            client, project = text.split(sep, 1)
            if client.strip() and project.strip():
                return client.strip(), project.strip()
    return None


def stem(word):
    """amendments -> amendment, copies -> copy: enough for the sheet's English."""
    if word.endswith('ies') and len(word) > 4:
        return word[:-3] + 'y'
    if word.endswith('s') and not word.endswith('ss') and len(word) > 3:
        return word[:-1]
    return word


def tokens(text):
    return {stem(t) for t in re.findall(r'[a-z0-9&]+', norm(text)) if t not in STOP and len(t) > 1}


def closeness(a, b):
    """How likely two names are one project, 0 to 1: the same words, one name inside
    the other ("OSLER" and "Osler Cardiovascular Group"), or a spelling apart."""
    ka, kb = name_key(a), name_key(b)
    if not ka or not kb:
        return 0.0
    if ka == kb:
        return 1.0
    ta = {t for t in ka.split(' ') if t not in GENERIC and len(t) > 1}
    tb = {t for t in kb.split(' ') if t not in GENERIC and len(t) > 1}
    ratio = difflib.SequenceMatcher(None, ka, kb).ratio()
    score = ratio if ratio >= NEAR else 0.0
    if ta and tb:
        if ta == tb:
            return 0.95
        small, big = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if small <= big:
            # every word of the shorter name is in the longer one; a lone two-letter word proves nothing
            if any(len(t) >= 3 for t in small):
                score = max(score, 0.9)
        else:
            shared = len(ta & tb) / len(ta | tb)
            if shared >= 0.5:
                score = max(score, round(0.5 + 0.4 * shared, 3))
    return round(score, 3)


def _sorted(aliases):
    return sorted(aliases, key=lambda a: (-len(a), a))


class Matcher:
    def __init__(self, db=None):
        cfg = config.transactions()
        self.th = config.thresholds()
        self.entries = []      # every transaction known; resolve_transaction looks through all but the dormant
        self.dormant = {}      # code -> entry: a transaction the firm codes that has no sheet rows and no Hub project
        self.projects = {}     # Hub projects by id ({id, name, code, client}); empty without a db
        self.overlaid = False  # True once the Hub's names have been laid over the YAML
        self.memo = {}         # per-run notes for callers (projects.py keeps the open proposals here)
        extractor = {m['code']: m for m in cfg.get('matters', [])}
        for entry in cfg.get('hub_clients', []):
            aliases = set(entry.get('aliases', []))
            base = extractor.get(entry['code'], {})
            aliases.update(base.get('aliases', []))
            aliases.update(base.get('keys', []))
            aliases.add(entry['code'])
            for client, project in entry.get('pairs', []):
                aliases.add(client)
                aliases.add(project)
            entry = dict(entry, aliases=_sorted({norm(a) for a in aliases if a}))
            entry['pairs'] = [tuple(p) for p in entry.get('pairs', [])]
            # phase 3: the transaction's name, every Hub project under its code, and (filled only
            # from the Hub) short names that count as a whole string or dash part, never inside one
            entry['name'] = base.get('name') or entry['code']
            entry['matter_rules'] = [dict(r) for r in entry.get('matter_rules', [])]
            entry['matters'] = []
            for mid in [entry.get('matter_id')] + [r.get('matter_id') for r in entry['matter_rules']]:
                if mid and mid not in entry['matters']:
                    entry['matters'].append(mid)
            entry['exact'] = []
            self.entries.append(entry)
        # The codes the Filer numbers files under that the sheet has no rows for. Each is an entry
        # (found by entry_for_code, listed for a reader) but marked dormant: resolve_transaction
        # passes over it, as phase 1 never knew these and their aliases are loose words meant for
        # the Filer's reader. The mark comes off when the Hub has a project for the code.
        sheet_codes = {e['code'] for e in self.entries}
        for code, base in extractor.items():
            if code in sheet_codes:
                continue
            entry = {'code': code, 'name': base.get('name') or code, 'pairs': [], 'aliases': [], 'exact': [],
                     'matter_rules': [], 'matters': [], 'dormant': True}
            self._add_names(entry, [code, base.get('name')] + list(base.get('keys', []))
                            + [a for a in base.get('aliases', []) if len(str(a)) <= LONG_ALIAS])
            self.dormant[code] = entry
            self.entries.append(entry)
        self.internal = {norm(t) for t in cfg.get('internal_transactions', [])}
        people = config.people()
        self.names = list(people.get('names', []))
        self.aliases = {norm(k): v for k, v in (people.get('aliases') or {}).items()}
        self._by_norm = {norm(n): n for n in self.names}
        if db is not None:
            self._overlay(db)

    # ---- the Hub's names over the YAML
    @staticmethod
    def _add_names(entry, names):
        """Adds names to an entry's aliases. A new name of one or two characters ("OR", "PC")
        goes to `exact`: it names the transaction only as the whole string or a dash part."""
        aliases, exact = set(entry['aliases']), set(entry['exact'])
        for name in names:
            a = norm(str(name)) if name else ''
            if not a or a in aliases or a in exact:
                continue
            (exact if len(a) <= 2 else aliases).add(a)
        entry['aliases'], entry['exact'] = _sorted(aliases), _sorted(exact)

    def _fold(self, entry, matter_ids, names):
        """Lays Hub projects and project_names rows onto one entry.

        names: rows of project_names ({name, kind, matter_id}) for these projects or for the bare code."""
        for mid in matter_ids:
            if mid not in entry['matters']:
                entry['matters'].append(mid)
        plain = [self.projects[mid]['name'] for mid in entry['matters'] if mid in self.projects]
        if entry.get('code'):
            plain.append(entry['code'])
        for n in names:
            kind, text = n.get('kind') or 'alias', (n.get('name') or '').strip()
            if not text:
                continue
            pair = split_pair(text) if kind == 'sheet' else None
            if pair:
                # a CLIENT / PROJECT pair as the sheet writes it; both halves name the transaction, as in the YAML
                if not any((norm(c), norm(p)) == (norm(pair[0]), norm(pair[1])) for c, p in entry['pairs']):
                    entry['pairs'].append(pair)
                plain.extend(pair)
            elif kind == 'contains':
                # within the code, a deliverable containing this text belongs to this (sister) project
                mid = n.get('matter_id')
                if mid and not any(r.get('matter_id') == mid and (r.get('contains') or '').lower() == text.lower()
                                   for r in entry['matter_rules']):
                    entry['matter_rules'].append({'contains': text, 'matter_id': mid})
            else:
                plain.append(text)
        self._add_names(entry, plain)
        if not entry.get('matter_id') and entry['matters']:
            # the code's own project is one no 'contains' name points at: a sister project takes only
            # the deliverables its name picks out, never the rest of the code's work
            sisters = {r.get('matter_id') for r in entry['matter_rules']}
            entry['matter_id'] = next((m for m in entry['matters'] if m not in sisters), None)

    def _overlay(self, db):
        """Two reads: every Hub project (with its client's name) and every project name.
        A db with no keys answers both with nothing, and the YAML stands alone."""
        matters = db.select('matters', {}, 'id,name,code,client:clients(name)', order='created_at.asc')
        names = db.select('project_names', {}, 'matter_id,code,name,kind', order='created_at.asc')
        if not matters and not names:
            return
        self.overlaid = True
        by_code, names_by_matter, names_by_code = {}, {}, {}
        for m in matters:
            code = (m.get('code') or '').strip() or None
            self.projects[m['id']] = {'id': m['id'], 'name': (m.get('name') or '').strip(), 'code': code,
                                      'client': ((m.get('client') or {}).get('name') or '').strip()}
            if code:
                by_code.setdefault(code.upper(), []).append(m['id'])
        for n in names:
            code = (n.get('code') or '').strip().upper()
            if n.get('matter_id'):
                names_by_matter.setdefault(n['matter_id'], []).append(n)
                # a name on a project that also carries a code ties that code to the project: this is
                # how a second code ("it's this project") reaches a project that already has its own
                if code and n['matter_id'] in self.projects and n['matter_id'] not in by_code.setdefault(code, []):
                    by_code[code].append(n['matter_id'])
            elif code:
                names_by_code.setdefault(code, []).append(n)

        def rows_for(ids, code):
            out = [n for mid in ids for n in names_by_matter.get(mid, [])]
            return out + (names_by_code.pop(code.upper(), []) if code else [])

        # 0. the Hub says which projects exist: one the YAML still points at but the Hub no longer has
        #    is forgotten, so nothing is filed into (or linked to) a project that is gone
        if matters:
            for entry in self.entries:
                if any(mid not in self.projects for mid in entry['matters']):
                    entry['matters'] = [mid for mid in entry['matters'] if mid in self.projects]
                    entry['matter_rules'] = [r for r in entry['matter_rules'] if r.get('matter_id') in self.projects]
                    if entry.get('matter_id') not in self.projects:
                        entry['matter_id'] = None
        # 1. the transactions the YAML knows: their Hub projects (by id, and by code) and their names
        claimed = set()
        for entry in list(self.entries):
            ids = list(entry['matters'])
            ids += [mid for mid in by_code.get(entry['code'].upper(), []) if mid not in ids]
            self._fold(entry, ids, rows_for(ids, entry['code']))
            claimed.update(ids)
        # 2. a coded transaction that now has a project (or sheet rows) is looked through like the rest
        for code, entry in list(self.dormant.items()):
            if entry['matters'] or entry['pairs']:
                self._wake(entry)
        # 3. Hub projects no YAML entry covers: one entry each (one per code when several share a code)
        yaml_codes = {e['code'].upper() for e in self.entries}
        groups = {}
        for mid, p in self.projects.items():
            if p['code'] and p['code'].upper() not in yaml_codes:
                groups.setdefault(('code', p['code'].upper()), []).append(mid)
            elif not p['code'] and mid not in claimed:
                groups.setdefault(('id', mid), []).append(mid)
        for ids in groups.values():
            first = self.projects[ids[0]]
            entry = {'code': first['code'], 'name': first['name'], 'pairs': [], 'aliases': [], 'exact': [],
                     'matter_rules': [], 'matters': []}
            self._fold(entry, ids, rows_for(ids, first['code']))
            if not entry['pairs']:
                entry['pairs'] = [(self.projects[m]['client'], self.projects[m]['name']) for m in ids
                                  if self.projects[m]['client'] and self.projects[m]['name']]
            self.entries.append(entry)
        # 4. names kept under a code that is neither in the YAML nor on a project yet
        for code, rows in list(names_by_code.items()):
            entry = {'code': rows[0]['code'].strip(), 'name': (rows[0].get('name') or code).strip(), 'pairs': [],
                     'aliases': [], 'exact': [], 'matter_rules': [], 'matters': []}
            self._fold(entry, [], rows)
            if not entry['pairs']:
                entry['dormant'] = True
                self.dormant[entry['code']] = entry
            self.entries.append(entry)

    def _wake(self, entry):
        entry.pop('dormant', None)
        for code, held in list(self.dormant.items()):
            if held is entry:
                del self.dormant[code]

    def learn_project(self, matter_id, name='', code=None, client='', names=()):
        """Tells this matcher, mid-run, of a project just created or adopted, so the next lookup
        finds it without reading the Hub again. Returns the entry it now sits under."""
        if not matter_id:
            return None
        self.projects[matter_id] = {'id': matter_id, 'name': (name or '').strip(), 'code': (code or '').strip() or None,
                                    'client': (client or '').strip()}
        entry = self.entry_for_code(code) if code else None
        if entry is None:
            entry = next((e for e in self.entries if matter_id in e['matters']), None)
        if entry is None:
            entry = {'code': (code or '').strip() or None, 'name': (name or '').strip(), 'aliases': [],
                     'pairs': [(client.strip(), name.strip())] if (client or '').strip() and (name or '').strip() else [],
                     'exact': [], 'matter_rules': [], 'matters': []}
            self.entries.append(entry)
        self._wake(entry)
        self._fold(entry, [matter_id], [{'name': n, 'kind': 'alias'} for n in names if n])
        return entry

    def transactions(self):
        """Every transaction known, with or without a Hub project (for a list shown to a reader)."""
        return list(self.entries)

    # ---- transactions
    def is_internal(self, text):
        t = norm(text)
        # the firm's own tooling is logged under "AKLA ..." names; none of it is a client deliverable
        return t in self.internal or t in ('', 'n/a', 'na', '-') or t.startswith('akla ')

    @staticmethod
    def _score(entry, t, parts):
        """How surely the normalised string t names this entry."""
        score = 0.0
        for alias in entry['aliases']:
            if alias == t:
                score = 1.0
            elif alias in parts:
                score = max(score, 0.95)
            elif re.search(r'(?<![a-z0-9])' + re.escape(alias) + r'(?![a-z0-9])', t):
                # a whole-word hit; a long alias is surer than a two-letter code
                score = max(score, 0.9 if len(alias) > 2 else 0.85)
            if score >= 1.0:
                break
        for alias in entry.get('exact', ()):
            if alias == t:
                score = 1.0
            elif alias in parts:
                score = max(score, 0.95)
        if score < 0.85 and entry['aliases']:
            # a spelling slip ("Explsoives") still counts; anything further off is no match at all
            ratio = max(difflib.SequenceMatcher(None, t, alias).ratio() for alias in entry['aliases'])
            if ratio * 0.9 >= 0.6:
                score = max(score, round(ratio * 0.9, 3))
        return score

    def resolve_transaction(self, text):
        """The best entry for a Transaction string: (entry, score) or (None, 0)."""
        t = norm(text)
        if not t:
            return None, 0.0
        parts = [p for p in t.split(' - ') if p]
        best, best_score = None, 0.0
        for entry in self.entries:
            if entry.get('dormant'):
                continue
            score = self._score(entry, t, parts)
            if score > best_score or (score == best_score and best and len(entry['pairs']) > len(best['pairs'])):
                best, best_score = entry, score
        return best, best_score

    def dormant_for(self, text):
        """The coded transaction with no Hub project that a string names outright (the whole
        string or a whole dash part is one of its names), or None. Stricter than
        resolve_transaction on purpose: it only decides which code a proposal is filed under."""
        t = norm(text)
        if not t:
            return None
        parts = [p for p in t.split(' - ') if p]
        best, best_score = None, 0.0
        for entry in self.dormant.values():
            names = entry['aliases'] + entry['exact']
            score = 1.0 if t in names else (0.95 if any(p in names for p in parts) else 0.0)
            if score > best_score:
                best, best_score = entry, score
        return best

    def entry_for_code(self, code):
        """The transaction a Filer code names (with or without a Hub project), or None."""
        c = (code or '').strip().upper()
        if not c:
            return None
        for entry in self.entries:
            if (entry.get('code') or '').upper() == c:
                return entry
        return None

    def matter_for_code(self, code, text=''):
        """The Hub project for a code, or None. `text` (a document's title, a deliverable) picks a
        sister project when it contains one of the code's 'contains' names."""
        entry = self.entry_for_code(code)
        if not entry:
            return None
        d = (text or '').lower()
        for rule in entry.get('matter_rules', []):
            if d and (rule.get('contains') or '').lower() in d:
                return rule.get('matter_id')
        return entry.get('matter_id')

    def near(self, text, limit=3):
        """Hub projects whose names are close to this one: [(matter_id, project name, score)], best first."""
        found = {}
        for entry in self.entries:
            main = entry.get('matter_id')
            for mid in entry['matters']:
                project = self.projects.get(mid, {}).get('name') or ''
                names = [project] if project else []
                if mid == main:
                    names += [a for a in entry['aliases'] if len(a) > 2]
                score = max((closeness(text, n) for n in names), default=0.0)
                if score >= NEAR and score > found.get(mid, ('', 0.0))[1]:
                    found[mid] = (project or entry.get('name') or entry.get('code') or '', score)
        ranked = sorted(((mid, name, score) for mid, (name, score) in found.items()), key=lambda x: (-x[2], x[1]))
        return ranked[:limit]

    def entry_for_pair(self, client, project):
        key = (norm(client), norm(project))
        for entry in self.entries:
            if any((norm(c), norm(p)) == key for c, p in entry['pairs']):
                return entry
        return None

    def matter_for(self, client, project, deliverable):
        """The Hub project id for a row, from config; a deliverable may be routed elsewhere by a rule."""
        entry = self.entry_for_pair(client, project)
        if not entry:
            return None
        d = (deliverable or '').lower()
        for rule in entry.get('matter_rules', []):
            if rule.get('contains', '').lower() in d:
                return rule.get('matter_id')
        return entry.get('matter_id')

    # ---- deliverables
    @staticmethod
    def deliverable_score(a, b, weights=None, drop=frozenset()):
        """How surely text a names row deliverable b, 0 to 1.

        Words are weighted by how rare they are among the transaction's own rows
        (weights: word -> weight), so "agreement" counts for little and "concession"
        for much; words that only name the transaction (drop) count for nothing.
        A near-identical string scores by its character ratio instead."""
        na, nb = norm(a), norm(b)
        if not na or not nb:
            return 0.0
        if na == nb:
            return 1.0
        ratio = difflib.SequenceMatcher(None, na, nb).ratio()
        ta, tb = tokens(a) - drop, tokens(b) - drop
        if not ta or not tb:
            return round(ratio if ratio >= 0.8 else ratio * 0.5, 3)
        w = weights or {}
        shared = ta & tb
        if not shared:
            return round(ratio if ratio >= 0.8 else 0.0, 3)
        weight = lambda ts: sum(w.get(t, 1.0) for t in ts)
        cov_a, cov_b = weight(shared) / weight(ta), weight(shared) / weight(tb)
        score = 0.65 * max(cov_a, cov_b) + 0.35 * min(cov_a, cov_b)
        return round(max(score, ratio if ratio >= 0.8 else 0.0), 3)

    @staticmethod
    def weights_for(rows):
        """A word's weight among these rows' deliverables: 1 / (1 + rows that use it)."""
        df = {}
        for r in rows:
            for t in tokens(r['deliverable']):
                df[t] = df.get(t, 0) + 1
        return {t: 1.0 / (1 + n) for t, n in df.items()}

    def candidate_rows(self, rows, entry):
        pairs = {(norm(c), norm(p)) for c, p in entry['pairs']} if entry else set()
        return [r for r in rows if (norm(r['client']), norm(r['project'])) in pairs
                and not r.get('archived_at') and not CONTINUATION.match((r['deliverable'] or '').strip())]

    def match_row(self, texts, rows, transaction=''):
        """texts: the block's texts, surest first (Complete Deliverable, Day Deliverable, Scope).
        Words of the Transaction string ("M6") name every row alike, so they are dropped.
        Returns (row, score, ranked[:3]); a near tie between two rows lowers the score to unsure."""
        if not rows:
            return None, 0.0, []
        weights = self.weights_for(rows)
        drop = tokens(transaction)
        factors = (1.0, 0.95, 0.85)
        scored = []
        for row in rows:
            best = 0.0
            for text, factor in zip(texts, factors):
                if text:
                    best = max(best, self.deliverable_score(text, row['deliverable'], weights, drop) * factor)
            scored.append((round(best, 3), row))
        scored.sort(key=lambda x: -x[0])
        top, runner = scored[0][0], scored[1][0] if len(scored) > 1 else 0.0
        if top >= self.th['deliverable_high'] and runner >= top - 0.05 \
                and norm(scored[0][1]['deliverable']) != norm(scored[1][1]['deliverable']):
            top = round(self.th['deliverable_high'] - 0.01, 3)      # two rows fit equally well: ask
        return scored[0][1], top, scored[:3]

    def grade(self, transaction_score, deliverable_score):
        th = self.th
        if transaction_score >= th['transaction_high'] and deliverable_score >= th['deliverable_high']:
            return 'high'
        if deliverable_score >= th['deliverable_low'] and transaction_score >= th['deliverable_low']:
            return 'unsure'
        return 'none'

    # ---- people
    def person(self, text):
        """One name as the profiles spell it, or the text as written when unknown."""
        t = norm(text).strip('.')
        if not t:
            return None
        if t in self.aliases:
            return self.aliases[t]
        if t in self._by_norm:
            return self._by_norm[t]
        return text.strip()

    def split_team(self, cell):
        """A TEAM cell (names on separate lines, initials with commas, or run together) to full names."""
        if not cell:
            return []
        names = []
        for piece in re.split(r'\n|,|;|/|&|\band\b', str(cell)):
            piece = piece.strip(' .')
            if not piece:
                continue
            names.extend(self._names_in(piece))
        seen, out = set(), []
        for n in names:
            if n and n not in seen:
                seen.add(n)
                out.append(n)
        return out

    def _names_in(self, piece):
        known = self.person(piece)
        if known != piece.strip():
            return [known]
        if norm(piece) in self._by_norm:
            return [known]
        # several names run together ("Ayaan Qureshi Rayyan Haya Huroom"): take known names left to right
        words = piece.split()
        out, i, unknown = [], 0, []
        while i < len(words):
            hit = None
            for n in (3, 2, 1):
                cand = ' '.join(words[i:i + n])
                if norm(cand) in self._by_norm or norm(cand) in self.aliases:
                    hit = self.person(cand)
                    i += n
                    break
            if hit:
                out.append(hit)
            else:
                unknown.append(words[i])
                i += 1
        if unknown and not out:
            return [' '.join(unknown)]
        if unknown:
            out.append(' '.join(unknown))
        return out
