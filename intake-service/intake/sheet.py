"""The Excel: read its rows, rewrite its rows from the Hub, fill the Agenda Log.

Rows 1 to 5 (the title block and the header) are never touched. Each written
data row takes the cell styles of the sheet's first data row. Column I holds
the Hub's row id, narrow and hidden, so the next read-back knows which row is which.
"""
import copy
from datetime import date

import openpyxl
from openpyxl.utils import get_column_letter

from . import config

COLUMNS = ('sort_order', 'client', 'project', 'deliverable', 'team', 'currently_with', 'comments', 'status')
LOG_COLUMNS = ('Agenda Date', 'Employee', 'Agenda File', 'Agenda Transaction', 'Matched Transaction',
               'Transaction Score', 'Day Deliverable', 'Complete Deliverable', 'Matched Hub Deliverable',
               'Deliverable Score', 'Hub Row(s)', 'Status', 'Note')
HUB_ID_HEADER = 'Hub ID'


def _s():
    return config.settings()['sheet']


def status_short(value):
    """'Deliverable With Boss' -> 'With Boss'; an unknown value is kept as written."""
    text = (value or '').strip()
    prefix = _s()['status_prefix']
    if text.lower().startswith(prefix.lower()):
        text = text[len(prefix):].strip()
    return text or 'Not Started'


def status_long(value):
    text = (value or '').strip()
    return text if not text or text.lower().startswith(_s()['status_prefix'].lower()) else _s()['status_prefix'] + text


def team_cell(names):
    return '\n\n'.join(n for n in names if n)


def open_workbook(path_or_bytes):
    if isinstance(path_or_bytes, (bytes, bytearray)):
        import io
        return openpyxl.load_workbook(io.BytesIO(path_or_bytes))
    return openpyxl.load_workbook(path_or_bytes)


def read_rows(wb):
    """The data rows as written: [{excel_row, sort_order, client, project, deliverable,
    team_text, currently_with, comments, status (short), hub_id}]. Blank rows are skipped."""
    s = _s()
    ws = wb[s['sheet_name']]
    rows = []
    for r in range(s['first_data_row'], ws.max_row + 1):
        values = [ws.cell(r, c).value for c in range(1, 9)]
        if all(v is None or str(v).strip() == '' for v in values):
            continue
        sort_order, client, project, deliverable, team, with_, comments, status = values
        hub_id = ws.cell(r, s['hub_id_column']).value
        rows.append({
            'excel_row': r,
            'sort_order': int(sort_order) if isinstance(sort_order, (int, float)) else len(rows) + 1,
            'client': _text(client), 'project': _text(project), 'deliverable': _text(deliverable),
            'team_text': _text(team), 'currently_with': _text(with_) or None, 'comments': _text(comments),
            'status': status_short(_text(status)), 'hub_id': _text(hub_id) or None,
        })
    return rows


def _text(value):
    if value is None:
        return ''
    if isinstance(value, (date,)):
        return f'{value:%B %d, %Y}'
    return str(value).strip()


def write_rows(wb, rows):
    """Replace the data rows. rows: [{id, sort_order, client, project, deliverable, team (list),
    currently_with, comments (text), status (short)}] in order."""
    s = _s()
    ws = wb[s['sheet_name']]
    first = s['first_data_row']
    styles = [copy.copy(ws.cell(first, c)._style) for c in range(1, s['hub_id_column'] + 1)]
    widths = [ws.column_dimensions[get_column_letter(c)].width or 10 for c in range(1, 9)]
    # clear everything below the header, styles included, so a shorter list leaves no tail
    if ws.max_row >= first:
        ws.delete_rows(first, ws.max_row - first + 1)
    for i, row in enumerate(rows):
        r = first + i
        values = [row['sort_order'], row['client'], row['project'], row['deliverable'],
                  team_cell(row.get('team') or []), row.get('currently_with') or '-',
                  row.get('comments') or '', status_long(row['status']), row['id']]
        for c, value in enumerate(values, 1):
            cell = ws.cell(r, c, value)
            cell._style = copy.copy(styles[c - 1])
        # Excel does not re-fit wrapped rows on opening a file it did not save, so size them here
        ws.row_dimensions[r].height = _row_height(values[:8], widths)
    col = get_column_letter(s['hub_id_column'])
    ws.cell(s['header_row'], s['hub_id_column'], HUB_ID_HEADER)
    ws.column_dimensions[col].width = 4
    ws.column_dimensions[col].hidden = True
    return ws


def _row_height(values, widths):
    """Points for a row whose cells wrap: the longest cell's wrapped line count at 15 points a line."""
    lines = 1
    for value, width in zip(values, widths):
        text = str(value) if value is not None else ''
        chars = max(int(width * 1.1), 1)             # Arial 11 fits about 1.1 characters per width unit
        count = sum(max(1, -(-len(line) // chars)) for line in text.split('\n'))
        lines = max(lines, count)
    return min(409, max(15.0, lines * 15.0))


def write_agenda_log(wb, entries):
    """Fill the Agenda Log sheet (header kept, rows replaced). entries: dicts keyed by LOG_COLUMNS."""
    s = _s()
    name = s['log_sheet_name']
    ws = wb[name] if name in wb.sheetnames else wb.create_sheet(name)
    if ws.max_row >= 2:
        ws.delete_rows(2, ws.max_row - 1)
    header = [ws.cell(1, c).value for c in range(1, len(LOG_COLUMNS) + 1)]
    if header != list(LOG_COLUMNS):
        for c, title in enumerate(LOG_COLUMNS, 1):
            ws.cell(1, c, title)
    for r, entry in enumerate(entries, 2):
        for c, key in enumerate(LOG_COLUMNS, 1):
            value = entry.get(key)
            ws.cell(r, c, f'{value:%B %d, %Y}' if isinstance(value, date) else value)
    return ws


def save(wb, path):
    wb.save(path)


def to_bytes(wb):
    import io
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
