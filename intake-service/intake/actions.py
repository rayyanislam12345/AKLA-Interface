"""Everything the intake does on its own is written down here, so a person can undo it.

One arrival (an agenda line, a filed document, an email) may do several things:
file a version, add a line to a row, keep a note. They share a group id, so
undoing the filing takes its row line with it (public.undo_intake_action).

    group = actions.new_group()
    update, action = actions.add_row_update(db, row, 'v4 received from …', source='email',
                                            source_ref='filer:812', group_id=group)
    actions.record(db, 'version_filed', 'email', 'Common Terms Agreement · v4 filed',
                   group_id=group, matter_id=…, document_id=…, version_id=…)
"""
import uuid

from .hub import now_iso

KINDS = ('version_filed', 'row_update', 'row_moved', 'row_created', 'note_added', 'project_created')
SOURCES = ('agenda', 'whatsapp', 'email', 'excel')
ROW_FIELDS = ('status', 'currently_with')        # what a move may change, and what Undo puts back


def new_group():
    return str(uuid.uuid4())


def record(db, kind, source, summary, *, source_ref=None, detail=None, group_id=None, matter_id=None,
           row_id=None, document_id=None, version_id=None, update_id=None, note_id=None,
           intake_document_id=None, message_id=None, before=None, after=None):
    """Writes one intake_actions row and returns it (with its id and group_id)."""
    if kind not in KINDS:
        raise ValueError(f'unknown action kind {kind!r}')
    if source not in SOURCES:
        raise ValueError(f'unknown action source {source!r}')
    row = {
        'group_id': group_id or new_group(), 'kind': kind, 'source': source, 'source_ref': source_ref,
        'summary': (summary or '').strip()[:300] or kind, 'detail': detail or {}, 'matter_id': matter_id,
        'row_id': row_id, 'document_id': document_id, 'version_id': version_id, 'update_id': update_id,
        'note_id': note_id, 'intake_document_id': intake_document_id, 'message_id': message_id,
        'before': before, 'after': after,
    }
    saved = db.insert('intake_actions', row)
    return saved[0] if saved else row


def add_row_update(db, row, body, *, source, source_ref=None, at=None, author=None, author_id=None,
                   changes=None, summary=None, detail=None, group_id=None, intake_document_id=None,
                   message_id=None):
    """Adds a dated line to a Transactions row, applies a move if one is given, and logs it for Undo.

    row      the row as hub.load_rows gives it (id, deliverable, status, currently_with, matter_id)
    changes  {'status': 'With Client', 'currently_with': 'NSCL'}: only the fields that really differ are
             applied; the row dict is updated in place so later lines in the same run see the move.
    Returns (update, action).
    """
    changes = {k: v for k, v in (changes or {}).items() if k in ROW_FIELDS and (v or None) != (row.get(k) or None)}
    update = db.insert('transaction_updates', {
        'row_id': row['id'], 'at': at or now_iso(), 'author': author, 'author_id': author_id,
        'body': body, 'source': source, 'source_ref': source_ref,
    })[0]
    before = after = None
    if changes:
        before = {k: row.get(k) for k in changes}
        after = dict(changes)
        db.patch('transaction_rows', {'id': f"eq.{row['id']}"}, dict(changes, updated_source=source))
        row.update(changes)
    action = record(
        db, 'row_moved' if changes else 'row_update', source,
        summary or f"{row.get('deliverable') or 'Row'}: {body}", source_ref=source_ref, detail=detail,
        group_id=group_id, matter_id=row.get('matter_id'), row_id=row['id'], update_id=update.get('id'),
        intake_document_id=intake_document_id, message_id=message_id, before=before, after=after)
    return update, action
