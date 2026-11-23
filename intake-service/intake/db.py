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
PAGE = 1000                 # PostgREST's own cap on rows per call
STORAGE_TIMEOUT = 300      # one file of up to 50 MB


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
            self._storage = e['SUPABASE_URL'].rstrip('/') + '/storage/v1/'
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
        # No limit asked for: the API hands back at most PAGE rows a call, so keep
        # asking until a short page. (Give an order when a table can pass PAGE rows.)
        out, offset = [], 0
        while True:
            page = self._request('GET', table, dict(params, limit=str(PAGE), offset=str(offset)))
            out.extend(page)
            if len(page) < PAGE:
                return out
            offset += PAGE

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

    def delete(self, table, filters):
        """Deletes the rows the filters name. Refuses to run without a filter."""
        if not filters:
            raise DbError(f'delete from {table} needs a filter')
        if self.dry_run or self.offline:
            log('  would delete from %s where %s', table, filters)
            return []
        return self._request('DELETE', table, filters, prefer='return=representation')

    def rpc(self, function, args, write=True):
        """Calls a database function. A write is only printed on a dry run (and returns None)."""
        if self.offline or (write and self.dry_run):
            log('  would call %s(%s)', function, _short(args))
            return None
        return self._request('POST', 'rpc/' + function, body=args)

    # ---- storage (the Hub's file buckets)
    def storage_upload(self, bucket, path, data, content_type='application/octet-stream'):
        """Puts a new object in a bucket. Never overwrites: an existing path is an error."""
        if self.dry_run or self.offline:
            log('  would upload %d bytes to %s/%s', len(data), bucket, path)
            return path
        url = self._storage + 'object/' + bucket + '/' + urllib.parse.quote(path, safe='/')
        headers = {'apikey': self._key, 'Authorization': f'Bearer {self._key}', 'Content-Type': content_type,
                   'x-upsert': 'false', 'cache-control': 'max-age=3600'}
        req = urllib.request.Request(url, data=data, method='POST', headers=headers)
        try:
            with self._opener.open(req, timeout=STORAGE_TIMEOUT) as r:
                r.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf8', 'replace')[:300]
            raise DbError(f'upload {bucket}/{path} -> {e.code}: {detail}') from None
        return path

    def storage_remove(self, bucket, paths):
        """Removes objects this run uploaded and could not use (a save that failed). Nothing else calls it."""
        if not paths or self.dry_run or self.offline:
            return
        url = self._storage + 'object/' + bucket
        headers = {'apikey': self._key, 'Authorization': f'Bearer {self._key}', 'Content-Type': 'application/json'}
        req = urllib.request.Request(url, data=json.dumps({'prefixes': list(paths)}).encode(), method='DELETE', headers=headers)
        try:
            with self._opener.open(req, timeout=TIMEOUT) as r:
                r.read()
        except urllib.error.HTTPError as e:
            log('  could not remove %s from %s: %s', paths, bucket, e.code)

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
