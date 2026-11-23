"""Every name a project goes by, kept on the Hub (project_names).

The firm calls one project by many names ("M6", "ADB", "Hyderabad Sukkur Motorway").
Until phase 3 those names lived only in config/transactions.yaml. seed_names copies
them to the Hub once; after that people add names there (a confirmed tray item, the
project's own page) and match.Matcher(db) reads them back.

PostgREST cannot upsert on the table's partial unique indexes, so nothing here
upserts: each function reads what is there, compares on name_key, and inserts
only what is missing.
"""
from . import config
from .db import in_list
from .log import log
from .match import LONG_ALIAS, name_key, norm, split_pair   # name_key is re-exported: names.name_key(text)

KINDS = ('alias', 'sheet', 'learned', 'contains')
SOURCES = ('config', 'hub', 'tray', 'intake')
BATCH = 200


def _family(kind):
    """'alias' and 'learned' are both just "a name": one of them is enough for the same words."""
    return 'name' if kind in ('alias', 'learned') else kind


def seed_names(db):
    """Copies what transactions.yaml knows into the Hub. Safe to run again: the second run adds nothing.

    - matters.code is set where the YAML gives a transaction its Hub project (and for the
      sister projects its matter_rules point at), when the column is still empty;
    - the code, the transaction's name, the extractor's keys and aliases and the sheet's
      spellings become 'alias' names; each [CLIENT, PROJECT] pair becomes a 'sheet' name
      "CLIENT / PROJECT"; each matter_rule becomes a 'contains' name on the rule's project;
    - a code the Hub has no project for keeps the same names under the code alone, and
      adopt_code moves them onto the project when it exists.
    """
    cfg = config.transactions()
    extractor = {m['code']: m for m in cfg.get('matters', [])}
    sheet = {e['code']: e for e in cfg.get('hub_clients', [])}
    codes = list(extractor) + [c for c in sheet if c not in extractor]
    summary = {'codes': len(codes), 'codes_set': 0, 'names_added': 0, 'names_existing': 0, 'code_only': [],
               'missing_projects': [], 'code_conflicts': []}

    hub = {m['id']: m for m in db.select('matters', {}, 'id,name,code', order='created_at.asc')}
    existing = db.select('project_names', {}, 'id,matter_id,code,name,kind')
    # With no keys there is nothing to check the YAML's project ids against; a dry run then prints them as given.
    on_hub = (lambda mid: mid in hub) if hub else (lambda mid: True)

    # 1. the codes
    wanted = {}
    for code, e in sheet.items():
        for mid in [e.get('matter_id')] + [r.get('matter_id') for r in e.get('matter_rules', [])]:
            if mid:
                wanted.setdefault(mid, code)
    to_set = {}
    for mid, code in wanted.items():
        m = hub.get(mid)
        if m is None:
            if hub:
                summary['missing_projects'].append({'code': code, 'matter_id': mid})
            continue
        if not (m.get('code') or '').strip():
            to_set.setdefault(code, []).append(mid)
            m['code'] = code
        elif m['code'].strip().upper() != code.upper():
            summary['code_conflicts'].append({'matter_id': mid, 'has': m['code'], 'yaml': code})
    for code, ids in to_set.items():
        db.patch('matters', {'id': in_list(ids)}, {'code': code})
        summary['codes_set'] += len(ids)

    # 2. the names
    have = set()
    for n in existing:
        key = (_family(n['kind']), name_key(n['name']))
        if n.get('matter_id'):
            have.add((n['matter_id'],) + key)
        if (n.get('code') or '').strip():
            # a name kept under the code counts for the code's project too, so a code that gains a project is not seeded twice
            have.add(('code:' + n['code'].strip().upper(),) + key)
    asked, rows = set(), []

    def want(name, kind, matter_id, code):
        name = str(name or '').strip()
        key = (_family(kind), name_key(name))
        if not key[1]:
            return
        scopes = [('code:' + code.upper(),) + key] + ([(matter_id,) + key] if matter_id else [])
        if any(s in asked for s in scopes):
            return                                  # the YAML lists it twice (or in two spellings of one key)
        asked.update(scopes)
        if any(s in have for s in scopes):
            summary['names_existing'] += 1
            return
        rows.append({'matter_id': matter_id, 'code': code, 'name': name, 'kind': kind, 'source': 'config'})

    for code in codes:
        base, e = extractor.get(code, {}), sheet.get(code, {})
        sisters = {r.get('matter_id') for r in e.get('matter_rules', [])}
        main = e.get('matter_id') if e.get('matter_id') and on_hub(e['matter_id']) else None
        if main is None:
            coded = [mid for mid, m in hub.items() if (m.get('code') or '').strip().upper() == code.upper()]
            main = next((mid for mid in coded if mid not in sisters), None)
        if main is None:
            summary['code_only'].append(code)
        for alias in [code, base.get('name')] + list(base.get('keys', [])) + list(base.get('aliases', [])) + list(e.get('aliases', [])):
            if alias and len(str(alias)) <= LONG_ALIAS:   # the longer ones are notes for the Filer's reader, not names
                want(alias, 'alias', main, code)
        for client, project in e.get('pairs', []):
            want(f'{client} / {project}', 'sheet', main, code)
        for rule in e.get('matter_rules', []):
            if rule.get('contains') and rule.get('matter_id') and on_hub(rule['matter_id']):
                want(rule['contains'], 'contains', rule['matter_id'], code)

    for start in range(0, len(rows), BATCH):
        db.insert('project_names', rows[start:start + BATCH])
    summary['names_added'] = len(rows)
    log('names: %d codes; %d project codes set; %d names added, %d already there; %d codes with no Hub project',
        summary['codes'], summary['codes_set'], summary['names_added'], summary['names_existing'], len(summary['code_only']))
    return summary


def add_name(db, name, kind='alias', matter_id=None, code=None, source='intake'):
    """Adds one name to a project (or to a bare code) unless it is already there.
    Returns the row, the one found or the one added; None when there is nothing to add."""
    if kind not in KINDS:
        raise ValueError(f'unknown name kind {kind!r}')
    if source not in SOURCES:
        raise ValueError(f'unknown name source {source!r}')
    name, code = (name or '').strip(), (code or '').strip() or None
    key = name_key(name)
    if not key or not (matter_id or code):
        return None
    scope = {'matter_id': f'eq.{matter_id}'} if matter_id else {'matter_id': 'is.null', 'code': f'eq.{code}'}
    for n in db.select('project_names', scope, 'id,matter_id,code,name,kind'):
        if name_key(n['name']) == key and _family(n['kind']) == _family(kind):
            return n
    saved = db.insert('project_names', {'matter_id': matter_id, 'code': code, 'name': name, 'kind': kind, 'source': source})
    return saved[0] if saved else None


def adopt_code(db, code, matter_id):
    """A project now exists for a code: the names kept under the code alone move onto it, and
    the Transactions rows filed under the code's CLIENT / PROJECT pairs that have no project
    yet are given this one. Safe to run again. Returns {'names_moved', 'rows_linked'}."""
    out = {'names_moved': 0, 'rows_linked': 0}
    code = (code or '').strip()
    if not code or not matter_id:
        return out
    under_code = db.select('project_names', {'code': f'eq.{code}'}, 'id,matter_id,name,kind')
    on_project = db.select('project_names', {'matter_id': f'eq.{matter_id}'}, 'id,matter_id,name,kind')
    held = {(_family(n['kind']), name_key(n['name'])) for n in on_project}
    move = []
    for n in under_code:
        if n.get('matter_id'):
            continue
        key = (_family(n['kind']), name_key(n['name']))
        if key in held:
            continue            # the project already has this name; the spare stays under the code and does no harm
        held.add(key)
        move.append(n['id'])
    for start in range(0, len(move), BATCH):
        db.patch('project_names', {'id': in_list(move[start:start + BATCH])}, {'matter_id': matter_id})
    out['names_moved'] = len(move)

    # the sheet rows: every pair the code is filed under, from the YAML and from its 'sheet' names
    entry = next((e for e in config.transactions().get('hub_clients', []) if e['code'].upper() == code.upper()), {})
    pairs = {(norm(c), norm(p)) for c, p in entry.get('pairs', [])}
    for n in under_code + on_project:
        pair = split_pair(n['name']) if n['kind'] == 'sheet' else None
        if pair:
            pairs.add((norm(pair[0]), norm(pair[1])))
    # a deliverable that a 'contains' name sends to a sister project is not this project's
    elsewhere = [r['contains'].lower() for r in entry.get('matter_rules', [])
                 if r.get('contains') and r.get('matter_id') != matter_id]
    elsewhere += [n['name'].lower() for n in under_code
                  if n['kind'] == 'contains' and n.get('matter_id') and n['matter_id'] != matter_id]
    if pairs:
        rows = db.select('transaction_rows', {'matter_id': 'is.null'}, 'id,client,project,deliverable')
        ids = [r['id'] for r in rows if (norm(r['client']), norm(r['project'])) in pairs
               and not any(text in (r.get('deliverable') or '').lower() for text in elsewhere)]
        for start in range(0, len(ids), 100):
            db.patch('transaction_rows', {'id': in_list(ids[start:start + 100])}, {'matter_id': matter_id})
        out['rows_linked'] = len(ids)
    return out
