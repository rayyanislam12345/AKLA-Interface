"""Small synthetic .docx files in the agendas' shape. No real agenda content here."""
import os
import sys
import zipfile
from html import escape

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def para(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def table(rows):
    body = ''
    for row in rows:
        cells = ''.join(f'<w:tc>{para(c)}</w:tc>' for c in row)
        body += f'<w:tr>{cells}</w:tr>'
    return f'<w:tbl>{body}</w:tbl>'


def write_docx(path, paragraphs, table_rows=None, extra_xml=''):
    parts = ''.join(para(p) for p in paragraphs)
    if table_rows:
        parts += table(table_rows)
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           + parts + extra_xml + '<w:sectPr/></w:body></w:document>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr('word/document.xml', xml)
    return path


NEW_STYLE = [
    'Daily Agenda', 'Date: October 30, 2026', 'Associate: Test Person', 'Deliverables', '*Note: To be discussed with Boss',
    'Transaction: ADB – M6', 'Scope of Task: Finalise the concession agreement and circulate it.',
    'Complete Deliverable: The Finalised M6 Concession Agreement.', 'Day Deliverable: The Finalised M6 Concession Agreement.',
    'Deliverable Assigned By: Self assigned.', 'Current Deliverable Status: Pending with me and is in progress.',
    'Transaction: Internal', 'Scope of Task: Preparing the to-do lists.', 'Complete Deliverable: N/A.', 'Day Deliverable: N/A.',
    'Deliverable Assigned By: Self assigned.',
    '[***The Rest Of This Page Has Been Intentionally Left Blank***]',
    'Daily Timesheet', 'Date: October 29, 2026', 'Associate: Test Person',
]
NEW_TABLE = [
    ['Sr. No.', 'Transaction', 'Matter & Description', 'Hours', 'Billable Hours', 'AK Billable Hours'],
    ['', 'Internal', 'Agenda call.', '0.5', '-', '-'],
    ['', 'ADB – M6', 'Reworked the concession agreement.', '7.0', '6.0', '1.0'],
    ['Total Hours', '7.5', '6.0', '1.0'],
]
OLD_STYLE = [
    'Daily Agenda', 'Date: October 12, 2026', 'Intern: Test Intern', 'Deliverables',
    'Client: Zorlu', 'Scope of work: Revising the carbon credits response.', 'Day Deliverable: Revised response.',
    'Deliverable : Revised Carbon Credits response.', 'Current Status: Pending with me.',
    '[Subject To Allocation Of Tasks During The Day]',
    'Daily Timesheet', 'Date: October 8, 2026', 'Intern: Test Intern',
]
OLD_TABLE = [
    ['Sr. No.', 'Transaction', 'Matter & Description', 'Hours', 'Billable Hours'],
    ['', 'Internal', 'Agenda call.', '0.50', '-'],
    ['', 'Zorlu', 'Worked on the response.', '8', '-'],
    ['Total Hours', '8.50', '-'],
    ['Percentage of Billable Hours', '-'],
]
