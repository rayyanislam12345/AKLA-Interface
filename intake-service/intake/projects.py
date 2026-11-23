"""Projects the firm is working on that the Hub does not have yet.

Three ways a missing project gets made, none of them silent:

- propose_project: a name (or a Filer code) nothing on the Hub answers to becomes ONE
  open `new_project` item in Needs a look, however many agendas, documents or emails
  mention it. Each mention adds to its count and its latest five sightings.
- adopt_accepted: when a person answered such an item ("Create the project" or "It's
  this project"), the names kept under the code move onto the project.
- plan_projects / write_plan / read_plan / apply_plan: the owner's backfill. The plan
  lists every coded transaction with no Hub project; he edits the file (a client, a
  better name, create: false) and apply_plan creates what is left.

With intake_settings.auto_create_projects on, propose_project creates the project
itself, but only for a coded transaction whose client is known and that is not close
to any project already there.
"""
import json
import os
import pathlib
import re
import sqlite3

from . import actions, config, hub
from . import names as project_names
from .log import log, warn
from .match import name_key, norm

# Exactly the website's six (src/hooks/useMatters.ts DEFAULT_MATTER_STAGES); the first starts in progress.
STAGES = ('Origination', 'Due Diligence', 'Drafting', 'Negotiation', 'Financial Close', 'Post-Closing')
KEEP_SEEN = 5
PLAN_ABOUT = [
    'Transactions the firm codes that the Hub has no project for. Edit, save, then apply.',
    'To leave one out, change its "create" to false. "name" is the project name and "client" the client it is filed under;',
    'correct either. A client that does not exist yet is created. Leave "code" as it is. The two counts are only for information.',
]


# ---------------------------------------------------------------------------
# Creating a project, as the website does
# ---------------------------------------------------------------------------

def create_project(db, name, client, code, source, names=(), source_ref=None):
    """Creates a Hub project and returns its id.

    The client is found by name (case does not matter) or created; the project gets
    the six default stages; the names kept under `code` move onto it and its sheet
    rows are linked (names.adopt_code); `names` are further names to remember.
    `source` is where the need came from: agenda, whatsapp, email or excel."""
    name = re.sub(r'\s+', ' ', name or '').strip()
    client = re.sub(r'\s+', ' ', client or '').strip()
    code = (code or '').strip() or None
    if not name:
        raise ValueError('a project needs a name')
    if source not in actions.SOURCES:
        raise ValueError(f'unknown source {source!r}')      # said before anything is written
    user = hub.intake_user_id(db)
    client_id = None
    if client:
        for c in db.select('clients', {}, 'id,name'):
            if (c.get('name') or '').strip().lower() == client.lower():
                client_id = c['id']
                break
        if client_id is None:
            client_id = db.insert('clients', {'name': client, 'created_by': user})[0]['id']
    matter_id = db.insert('matters', {'name': name, 'client_id': client_id, 'code': code, 'created_by': user})[0]['id']
    db.insert('matter_stages', [{'matter_id': matter_id, 'name': stage, 'sort_order': i,
                                 'status': 'in_progress' if i == 0 else 'not_started'} for i, stage in enumerate(STAGES)])
    if code:
        project_names.adopt_code(db, code, matter_id)
    for extra in names:
        if extra and name_key(extra) != name_key(name):
            project_names.add_name(db, extra, 'alias', matter_id=matter_id, code=code, source='intake')
    actions.record(db, 'project_created', source, f'{name} · new project', source_ref=source_ref,
                   detail={'client': client, 'code': code}, matter_id=matter_id)
    log('project created: %s (%s)%s', name, client or 'no client', f' [{code}]' if code else '')
    return matter_id


# ---------------------------------------------------------------------------
# One tray item per missing project
# ---------------------------------------------------------------------------

def _client_guess(entry):
    """The CLIENT the sheet files the transaction under, or ''. Where the sheet spells the client
    two ways ("FBL" and its full name), the pair new rows are created under is the one meant."""
    if not entry or not entry.get('pairs'):
        return ''
    pairs = [(norm(c), norm(p)) for c, p in entry['pairs']]
    new_row = entry.get('new_row')
    if new_row and (norm(new_row[0]), norm(new_row[1])) in pairs:
        return new_row[0]
    return entry['pairs'][0][0]


def _project_for(matcher, name, code, sure=None):
    """The Hub project a code (or, with no code, a name) already answers to, or None.
    `sure` is the score a name must reach; the matcher's own bar for a transaction by default."""
    if code:
        return matcher.matter_for_code(code)
    entry, score = matcher.resolve_transaction(name)
    if entry is not None and score >= (sure or matcher.th['transaction_high']):
        return entry.get('matter_id')
    return None


def _proposals(db, matcher):
    """Every new_project item, read once per run and kept on the matcher."""
    if 'proposals' not in matcher.memo:
        matcher.memo['proposals'] = db.select('intake_tray', {'kind': 'eq.new_project'}, 'id,status,payload,guess,resolution',
                                              order='created_at.asc')
    return matcher.memo['proposals']


def _same(item, name, code):
    p = item.get('payload') or {}
    theirs = (p.get('code') or '').strip().upper()
    if code and theirs:
        return theirs == code.upper()
    return name_key(p.get('name')) == name_key(name)


def _seen(seen):
    if not seen:
        return None
    out = {k: (v.isoformat() if hasattr(v, 'isoformat') else v) for k, v in dict(seen).items()}
    for key in ('where', 'person', 'date'):
        out.setdefault(key, None)
    return out


def _near(matcher, *texts):
    best = {}
    for text in texts:
        for matter_id, name, score in matcher.near(text) if text else []:
            if score > best.get(matter_id, ('', 0.0))[1]:
                best[matter_id] = (name, score)
    ranked = sorted(best.items(), key=lambda kv: (-kv[1][1], kv[1][0]))[:3]
    return [{'matter_id': mid, 'name': name, 'confidence': f'{score:.2f}'} for mid, (name, score) in ranked]


def _close(db, item, matter_id, by):
    """An open proposal whose project now exists is answered, so nobody is asked twice."""
    resolution = {'matter_id': matter_id, 'adopted': True, 'closed_by': by}
    db.patch('intake_tray', {'id': f"eq.{item['id']}"}, {'status': 'accepted', 'resolution': resolution,
                                                        'resolved_at': hub.now_iso()})
    item.update(status='accepted', resolution=resolution)


def propose_project(db, matcher, name, code=None, seen=None, client=None, source=None):
    """Says "the firm is working on something the Hub has no project for", once per name.

    name    the name as seen (an agenda's Transaction, the Filer's transaction name, an email's)
    code    the Filer's code when there is one; items are then matched on the code
    seen    {'where': <file or subject>, 'person': <who>, 'date': <iso>}: one sighting
    client  the client, when the caller knows it (else the sheet's client for the code)
    source  agenda | whatsapp | email | excel: only used when the project is created outright

    Does nothing when the name or code already answers to a Hub project, when it is the
    firm's own (matcher.is_internal), or when a person has already answered or dropped the
    same proposal. Returns {'action': 'nothing'|'proposed'|'updated'|'created', ...}."""
    name = re.sub(r'\s+', ' ', name or '').strip().rstrip(' .;:,')     # agendas end the line with a full stop
    code = (code or '').strip() or None
    entry = matcher.entry_for_code(code) if code else None
    if not name:
        name = entry['name'] if entry else (code or '')
    if not name:
        return {'action': 'nothing', 'why': 'no name'}
    if matcher.is_internal(name):
        return {'action': 'nothing', 'why': 'internal'}
    matter_id = _project_for(matcher, name, code)
    if matter_id:
        return {'action': 'nothing', 'why': 'known', 'matter_id': matter_id}
    if not code:
        # a name the sheet or the Filer already codes is proposed under that code, so an agenda's
        # "Master Mining" and the Filer's MM documents end up in the same item
        found, score = matcher.resolve_transaction(name)
        entry = found if found is not None and score >= matcher.th['transaction_high'] else matcher.dormant_for(name)
        code = entry.get('code') if entry else None

    items = [i for i in _proposals(db, matcher) if _same(i, name, code)]
    item = next((i for i in items if i.get('status') == 'open'), None)
    # the project's name: the transaction's own when it is coded, else the name as first seen
    asked = ((item or {}).get('guess') or {}).get('new_project') or {}
    if entry and entry.get('name') and entry['name'] != entry.get('code'):
        project_name = entry['name']
    else:
        project_name = asked.get('name') or ((item or {}).get('payload') or {}).get('name') or name
    client = re.sub(r'\s+', ' ', client or '').strip() or _client_guess(entry) or asked.get('client') or ''
    near = _near(matcher, name, project_name)
    guess = {'new_project': {'name': project_name, 'client': client, 'code': code}, 'near': near}
    seen = _seen(seen)
    if item is None:
        for old in items:
            if old.get('status') == 'dropped':
                return {'action': 'nothing', 'why': 'dropped', 'tray_id': old.get('id')}
            answered = (old.get('resolution') or {}).get('matter_id')
            # answered, and the project is still there (or this matcher cannot tell): wait for adopt_accepted
            if old.get('status') == 'accepted' and (not matcher.overlaid or not answered or answered in matcher.projects):
                return {'action': 'nothing', 'why': 'answered', 'tray_id': old.get('id')}

    if code and client and not near and _auto_create(db, matcher):
        matter_id = create_project(db, project_name, client, code, source or 'agenda', names=[name],
                                   source_ref=(seen or {}).get('where'))
        matcher.learn_project(matter_id, project_name, code, client, [name])
        if item is not None:
            _close(db, item, matter_id, 'auto_create_projects')
        return {'action': 'created', 'matter_id': matter_id}

    if item is None:
        payload = {'name': name, 'code': code, 'count': 1, 'seen': [seen] if seen else []}
        saved = db.insert('intake_tray', {'kind': 'new_project', 'payload': payload, 'guess': guess})
        item = dict(saved[0] if saved else {}, status='open', payload=payload, guess=guess)
        _proposals(db, matcher).append(item)
        return {'action': 'proposed', 'tray_id': item.get('id')}

    payload = dict(item.get('payload') or {})
    sightings = list(payload.get('seen') or [])
    if seen and seen in sightings:
        return {'action': 'nothing', 'why': 'same sighting', 'tray_id': item.get('id')}
    payload['count'] = int(payload.get('count') or len(sightings)) + 1
    if seen:
        # the latest five, newest first (a sighting with no date goes last)
        sightings = sorted(sightings + [seen], key=lambda s: str(s.get('date') or ''), reverse=True)[:KEEP_SEEN]
    payload['seen'] = sightings
    if code and not payload.get('code'):
        payload['code'] = code
    db.patch('intake_tray', {'id': f"eq.{item['id']}"}, {'payload': payload, 'guess': guess})
    item.update(payload=payload, guess=guess)
    return {'action': 'updated', 'tray_id': item.get('id'), 'count': payload['count']}


def _auto_create(db, matcher):
    if 'auto_create_projects' not in matcher.memo:
        matcher.memo['auto_create_projects'] = db.setting('auto_create_projects', False) is True
    return matcher.memo['auto_create_projects']


def close_resolved(db, matcher):
    """Open proposals whose name or code has since found its project (a backfill, a learned
    name, a project made by hand) are closed as answered. Returns how many.

    A person's open question is only closed on a plain answer: the code has a project, or the
    name is one of a project's names outright (the whole string, or a whole part between
    dashes). A name that merely contains a project's word stays open for a person."""
    closed = 0
    for item in db.select('intake_tray', {'kind': 'eq.new_project', 'status': 'eq.open'}, 'id,payload'):
        p = item.get('payload') or {}
        matter_id = _project_for(matcher, p.get('name') or '', (p.get('code') or '').strip() or None, sure=0.95)
        if matter_id:
            _close(db, item, matter_id, 'intake')
            closed += 1
    matcher.memo.pop('proposals', None)
    return closed


def adopt_accepted(db, matcher):
    """Follows up the new_project items a person accepted (resolution.matter_id, not yet adopted).

    With a code on the item: the names kept under the code move onto the project and its sheet
    rows are linked (names.adopt_code), the project takes the code when it has none, and the
    code is kept as one of its names (which is what ties a second code to a project that
    already has one). The matcher is told at once, so the same run can file what was waiting.
    Open proposals that have meanwhile found their project are closed too. Returns how many
    accepted items were adopted."""
    adopted = 0
    for item in db.select('intake_tray', {'kind': 'eq.new_project', 'status': 'eq.accepted'}, 'id,payload,resolution',
                          order='created_at.asc'):
        resolution = item.get('resolution') or {}
        matter_id = resolution.get('matter_id')
        if not matter_id or resolution.get('adopted'):
            continue
        payload = item.get('payload') or {}
        code = (payload.get('code') or '').strip() or None
        matter = db.one('matters', {'id': f'eq.{matter_id}'}, 'id,name,code,client:clients(name)')
        if not matter:
            warn('new project "%s": the project it was pointed at is not on the Hub; left as it is', payload.get('name'))
            continue
        if code:
            project_names.adopt_code(db, code, matter_id)
            if not (matter.get('code') or '').strip():
                db.patch('matters', {'id': f'eq.{matter_id}'}, {'code': code})
            project_names.add_name(db, code, 'alias', matter_id=matter_id, code=code, source='tray')
        db.patch('intake_tray', {'id': f"eq.{item['id']}"}, {'resolution': dict(resolution, adopted=True)})
        matcher.learn_project(matter_id, matter.get('name') or '', code or matter.get('code'),
                              (matter.get('client') or {}).get('name') or '', [payload.get('name')])
        adopted += 1
    close_resolved(db, matcher)
    return adopted


# ---------------------------------------------------------------------------
# The owner's backfill
# ---------------------------------------------------------------------------

def _filer_counts(path):
    """Filed documents per code from the Filer's own record, read-only; None when it cannot be read."""
    if not path or not os.path.exists(path):
        return None
    try:
        con = sqlite3.connect(pathlib.Path(os.path.abspath(path)).as_uri() + '?mode=ro', uri=True)
        try:
            return {code: n for code, n in con.execute(
                "SELECT code, COUNT(*) FROM files WHERE action = 'filed' AND web_url IS NOT NULL "
                "AND code IS NOT NULL GROUP BY code")}
        finally:
            con.close()
    except sqlite3.Error as e:
        warn('the Filer record at %s could not be read: %r', path, e)
        return None


def plan_projects(db, matcher, filer_db=None):
    """Every transaction code in transactions.yaml that has no Hub project, as a list the owner can edit:
    {code, name, client, sheet_rows, filer_documents, create}."""
    cfg = config.transactions()
    codes = [m['code'] for m in cfg.get('matters', [])]
    codes += [e['code'] for e in cfg.get('hub_clients', []) if e['code'] not in codes]
    rows = hub.load_rows(db)
    filed = _filer_counts(filer_db)
    plan = []
    for code in codes:
        entry = matcher.entry_for_code(code)
        if entry is None or entry.get('matter_id') or entry.get('matters'):
            continue
        pairs = {(norm(c), norm(p)) for c, p in entry['pairs']}
        item = {'code': code, 'name': entry.get('name') or code, 'client': _client_guess(entry),
                'sheet_rows': sum(1 for r in rows if (norm(r['client']), norm(r['project'])) in pairs),
                'filer_documents': None if filed is None else int(filed.get(code, 0)), 'create': True}
        if matcher.is_internal(item['name']):
            item['note'] = ('The firm\'s own work: agenda lines under this name are skipped as internal. '
                            'Set "create" to false if it should not be a project.')
        plan.append(item)
    return plan


def write_plan(path, plan):
    with open(path, 'w', encoding='utf8') as fh:
        json.dump({'about': PLAN_ABOUT, 'projects': plan}, fh, indent=2, ensure_ascii=False)
        fh.write('\n')
    return path


def read_plan(path):
    with open(path, encoding='utf8') as fh:
        data = json.load(fh)
    plan = data.get('projects', []) if isinstance(data, dict) else data
    if not isinstance(plan, list) or not all(isinstance(p, dict) for p in plan):
        raise ValueError(f'{path}: the plan should be a list of projects')
    return plan


def _yes(value):
    return value is True or str(value).strip().lower() in ('true', 'yes', 'y', '1')


def apply_plan(db, matcher, plan, source='excel'):
    """Creates each project the plan marks create: true that the Hub still lacks, and records
    a run of kind 'projects'. Running it again creates nothing new."""
    run_id = hub.start_run(db, 'projects')
    summary = {'in_plan': len(plan), 'created': 0, 'already_there': 0, 'left_out': 0, 'same_name': 0, 'no_name': 0,
               'proposals_closed': 0, 'created_projects': [], 'same_name_projects': [], 'dry_run': bool(db.dry_run)}
    try:
        on_hub = db.select('matters', {}, 'id,name,code')
        coded = {m['code'].strip().upper(): m['id'] for m in on_hub if (m.get('code') or '').strip()}
        named = {name_key(m.get('name')): m['id'] for m in on_hub}
        for item in plan:
            code = (item.get('code') or '').strip() or None
            name = re.sub(r'\s+', ' ', item.get('name') or '').strip()
            client = re.sub(r'\s+', ' ', item.get('client') or '').strip()
            if not _yes(item.get('create')):
                summary['left_out'] += 1
                continue
            if not name:
                summary['no_name'] += 1
                continue
            if code and (coded.get(code.upper()) or matcher.matter_for_code(code)):
                summary['already_there'] += 1
                continue
            if name_key(name) in named:
                # a project of exactly this name is on the Hub without the code: a person should say it is the same
                summary['same_name'] += 1
                summary['same_name_projects'].append({'code': code, 'name': name, 'matter_id': named[name_key(name)]})
                continue
            matter_id = create_project(db, name, client, code, source, source_ref='plan')
            if code:
                coded[code.upper()] = matter_id
            named[name_key(name)] = matter_id
            matcher.learn_project(matter_id, name, code, client)
            summary['created'] += 1
            summary['created_projects'].append({'code': code, 'name': name, 'client': client, 'matter_id': matter_id})
        summary['proposals_closed'] = close_resolved(db, matcher)
        hub.finish_run(db, run_id, True, summary)
    except Exception as e:
        hub.finish_run(db, run_id, False, summary, repr(e))
        raise
    return summary


def ready_matcher(db, dry_run=False):
    """The matcher every run starts from: the Hub's names, after carrying out what people
    decided about projects in Needs a look (a project created or pointed to there takes
    its code's names and rows, so what was waiting for it can be placed in this same run)."""
    from .match import Matcher
    matcher = Matcher(db)
    if dry_run or getattr(db, 'dry_run', False) or getattr(db, 'offline', False):
        return matcher
    try:
        if adopt_accepted(db, matcher):
            matcher = Matcher(db)
    except Exception as e:      # a decision that cannot be carried out must not stop the run
        warn('project decisions from Needs a look could not be carried out: %r', e)
    return matcher
