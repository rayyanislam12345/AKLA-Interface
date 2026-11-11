"""Names to rows: the transaction an agenda names, the row a deliverable means, the people.

Scores are 0 to 1. Nothing here touches the database; the callers pass the rows in.
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


def norm(text):
    text = (text or '').replace('\u2013', '-').replace('\u2014', '-').replace('\u2019', "'")   # en dash, em dash, curly quote
    text = re.sub(r'[. ]', ' ', text.lower())
    text = re.sub(r'\s*-\s*', ' - ', text)
    return re.sub(r'\s+', ' ', text).strip(' -:;,')


def stem(word):
    """amendments -> amendment, copies -> copy: enough for the sheet's English."""
    if word.endswith('ies') and len(word) > 4:
        return word[:-3] + 'y'
    if word.endswith('s') and not word.endswith('ss') and len(word) > 3:
        return word[:-1]
    return word


def tokens(text):
    return {stem(t) for t in re.findall(r'[a-z0-9&]+', norm(text)) if t not in STOP and len(t) > 1}


class Matcher:
    def __init__(self):
        cfg = config.transactions()
        self.th = config.thresholds()
        self.entries = []
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
            entry = dict(entry, aliases=sorted({norm(a) for a in aliases if a}, key=len, reverse=True))
            entry['pairs'] = [tuple(p) for p in entry.get('pairs', [])]
            self.entries.append(entry)
        self.internal = {norm(t) for t in cfg.get('internal_transactions', [])}
        people = config.people()
        self.names = list(people.get('names', []))
        self.aliases = {norm(k): v for k, v in (people.get('aliases') or {}).items()}
        self._by_norm = {norm(n): n for n in self.names}

    # ---- transactions
    def is_internal(self, text):
        t = norm(text)
        # the firm's own tooling is logged under "AKLA ..." names; none of it is a client deliverable
        return t in self.internal or t in ('', 'n/a', 'na', '-') or t.startswith('akla ')

    def resolve_transaction(self, text):
        """The best entry for a Transaction string: (entry, score) or (None, 0)."""
        t = norm(text)
        if not t:
            return None, 0.0
        parts = [p for p in t.split(' - ') if p]
        best, best_score = None, 0.0
        for entry in self.entries:
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
            if score < 0.85:
                # a spelling slip ("Explsoives") still counts; anything further off is no match at all
                ratio = max(difflib.SequenceMatcher(None, t, alias).ratio() for alias in entry['aliases'])
                if ratio * 0.9 >= 0.6:
                    score = max(score, round(ratio * 0.9, 3))
            if score > best_score or (score == best_score and best and len(entry['pairs']) > len(best['pairs'])):
                best, best_score = entry, score
        return best, best_score

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
