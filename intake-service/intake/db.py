"""The Hub's database through PostgREST, with the service role, using only urllib.

Every call sends the key in `apikey` and `Authorization`. A dry-run Db answers
reads from the database (when there are keys) and prints writes instead of
sending them, handing back made-up ids so the callers can carry on.
"""
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import config
from .log import log

TIMEOUT = 60


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class DbError(RuntimeError):
    pass


class Db:
    def __init__(self, dry_run=False, offline=False):
        self.dry_run = dry_run
        # offline: no keys at all; reads return nothing and writes are printed.
        self.offline = offline or not config.has_supabase()
        self._opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl_context()))
        if not self.offline:
            e = config.env()
            self._base = e['SUPABASE_URL'].rstrip('/') + '/rest/v1/'
            self._key = e['SUPABASE_SERVICE_ROLE_KEY']

    # ---- the wire
    def _request(self, method, table, params=None, body=None, prefer=None):
        url = self._base + table
        if params:
            url += '?' + urllib.parse.urlencode(params, quote_via=urllib.parse.quote, safe='(),.*:')
        headers = {'apikey': self._key, 'Authorization': f'Bearer {self._key}', 'Accept': 'application/json'}
        if prefer:
            headers['Prefer'] = prefer
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, default=str).encode()
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self._opener.open(req, timeout=TIMEOUT) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf8', 'replace')[:500]
            raise DbError(f'{method} {table} -> {e.code}: {detail}') from None
        return json.loads(raw) if raw else []

    # ---- reads
    def select(self, table, filters=None, columns='*', order=None, limit=None):
        """filters: {'status': 'eq.open', 'id': 'in.(a,b)'} in PostgREST's own syntax."""
        if self.offline:
            return []
        params = dict(filters or {})
        params['select'] = columns
        if order:
            params['order'] = order
        if limit:
            params['limit'] = str(limit)
        return self._request('GET', table, params)

    def one(self, table, filters, columns='*'):
        rows = self.select(table, filters, columns, limit=1)
        return rows[0] if rows else None

    # ---- writes
    def insert(self, table, rows):
        rows = rows if isinstance(rows, list) else [rows]
        if not rows:
            return []
        if self.dry_run or self.offline:
            for row in rows:
                log('  would insert into %s: %s', table, _short(row))
            return [dict(row, id=row.get('id') or str(uuid.uuid4())) for row in rows]
        return self._request('POST', table, body=rows, prefer='return=representation')

    def upsert(self, table, rows, on_conflict):
        rows = rows if isinstance(rows, list) else [rows]
        if not rows:
            return []
        if self.dry_run or self.offline:
            for row in rows:
                log('  would upsert into %s (%s): %s', table, on_conflict, _short(row))
            return [dict(row, id=row.get('id') or str(uuid.uuid4())) for row in rows]
        return self._request('POST', table, {'on_conflict': on_conflict}, body=rows,
                             prefer='return=representation,resolution=merge-duplicates')

    def patch(self, table, filters, data):
        if self.dry_run or self.offline:
            log('  would update %s where %s: %s', table, filters, _short(data))
            return [dict(data)]
        return self._request('PATCH', table, filters, body=data, prefer='return=representation')

    # ---- settings
    def setting(self, key, default=None):
        row = self.one('intake_settings', {'key': f'eq.{key}'}, 'value')
        return default if row is None else row['value']


def in_list(values):
    """A PostgREST `in.(...)` filter value; every item quoted so commas and spaces survive."""
    quoted = ','.join('"' + str(v).replace('"', '\\"') + '"' for v in values)
    return f'in.({quoted})'


def _short(row):
    text = json.dumps(row, default=str, ensure_ascii=False)
    return text if len(text) <= 300 else text[:297] + '...'
