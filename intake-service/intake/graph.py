"""Microsoft Graph for the sheet and the agendas on SharePoint.

The Graph class is copied from the WhatsApp Filer (AKLA - Agenda Extractor,
filer/graph.py: app-only, Sites.Selected on akla-internal), with three additions
for this service: list a folder's children, download a file, and replace a file
in place. Nothing here deletes.
"""
import json
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from . import config

GRAPH = 'https://graph.microsoft.com/v1.0'
TIMEOUT = 60
DOWNLOAD_TIMEOUT = 600     # a draft agreement with its scans can be tens of MB
SIMPLE_LIMIT = 4 * 1024 * 1024          # Graph's limit for a single PUT; the sheet is 45 KB


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _prefer_ipv4():
    # The VM's IPv6 route to Microsoft stalls; try IPv4 addresses first.
    original = socket.getaddrinfo
    if getattr(original, '_ipv4_first', False):
        return

    def getaddrinfo(*args, **kwargs):
        return sorted(original(*args, **kwargs), key=lambda a: a[0] != socket.AF_INET)
    getaddrinfo._ipv4_first = True
    socket.getaddrinfo = getaddrinfo


_prefer_ipv4()
_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_ssl_context()))


class GraphError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(f'{status} {message}')
        self.status = status


def _q(path):
    return urllib.parse.quote(path)


class Graph:
    def __init__(self, env=None):
        self.env = env or config.env()
        self._token, self._expires = None, 0
        self._drive, self._room = None, None

    def _access_token(self):
        if self._token and time.time() < self._expires - 300:
            return self._token
        data = urllib.parse.urlencode({
            'client_id': self.env['AZURE_CLIENT_ID'], 'client_secret': self.env['AZURE_CLIENT_SECRET'],
            'scope': 'https://graph.microsoft.com/.default', 'grant_type': 'client_credentials',
        }).encode()
        url = f'https://login.microsoftonline.com/{self.env["AZURE_TENANT_ID"]}/oauth2/v2.0/token'
        with _OPENER.open(urllib.request.Request(url, data=data), timeout=TIMEOUT) as r:
            body = json.load(r)
        self._token, self._expires = body['access_token'], time.time() + int(body.get('expires_in', 3600))
        return self._token

    def call(self, method, path, body=None, content_type=None, retries=4, raw=False, timeout=TIMEOUT):
        url = path if path.startswith('http') else GRAPH + path
        for attempt in range(retries + 1):
            headers = {'Authorization': f'Bearer {self._access_token()}'}
            if content_type:
                headers['Content-Type'] = content_type
            req = urllib.request.Request(url, data=body, method=method, headers=headers)
            try:
                with _OPENER.open(req, timeout=timeout) as r:
                    data = r.read()
                    if raw:
                        return data
                    return json.loads(data) if data else {}
            except urllib.error.HTTPError as e:
                if e.code in (429, 503, 504) and attempt < retries:
                    time.sleep(int(e.headers.get('Retry-After') or 2 ** attempt))
                    continue
                msg = json.loads(e.read() or b'{}').get('error', {}).get('message', '')
                raise GraphError(e.code, f'{method} {path} -> {msg}') from None
            except (urllib.error.URLError, TimeoutError, socket.timeout):
                if attempt < retries:
                    time.sleep(2 ** attempt)
                    continue
                raise

    def pages(self, path):
        while path:
            page = self.call('GET', path)
            yield from page.get('value', [])
            path = page.get('@odata.nextLink')

    def data_room(self):
        """(drive id, Data Room folder item) on the configured site."""
        if self._drive:
            return self._drive, self._room
        site = self.call('GET', f'/sites/{self.env.get("SHAREPOINT_SITE", "aklacopk.sharepoint.com:/sites/akla-internal")}')
        folder_path = urllib.parse.quote(self.env.get('DATA_ROOM_PATH', 'AKLA - Data Room'))
        for d in self.call('GET', f'/sites/{site["id"]}/drives')['value']:
            try:
                self._drive, self._room = d['id'], self.call('GET', f'/drives/{d["id"]}/root:/{folder_path}')
                return self._drive, self._room
            except GraphError:
                continue
        raise RuntimeError('Data Room folder not found on the site.')

    # ---- additions for the intake service: paths are relative to the Data Room
    def _item_path(self, rel):
        drive, _ = self.data_room()
        room = self.env.get('DATA_ROOM_PATH', 'AKLA - Data Room')
        return f'/drives/{drive}/root:/{_q(room + "/" + rel)}'

    def item(self, rel):
        """The item (id, name, eTag, size, lastModifiedDateTime) at a path, or None."""
        try:
            return self.call('GET', self._item_path(rel) + '?$select=id,name,eTag,size,lastModifiedDateTime,file,folder')
        except GraphError as e:
            if e.status == 404:
                return None
            raise

    def children(self, rel):
        """Files in a folder: [{name, id, eTag, size, lastModified}], folders left out."""
        folder = self.item(rel)
        if not folder:
            return []
        drive, _ = self.data_room()
        out = []
        for c in self.pages(f'/drives/{drive}/items/{folder["id"]}/children?$top=999'
                            '&$select=id,name,eTag,size,lastModifiedDateTime,file'):
            if c.get('file'):
                out.append({'name': c['name'], 'id': c['id'], 'eTag': c.get('eTag'),
                            'size': c.get('size'), 'lastModified': c.get('lastModifiedDateTime')})
        return out

    def download(self, rel):
        """The file's bytes and its eTag."""
        item = self.item(rel)
        if not item:
            raise GraphError(404, f'GET {rel} -> not found')
        return self.call('GET', self._item_path(rel) + ':/content', raw=True, timeout=DOWNLOAD_TIMEOUT), item.get('eTag')

    def upload(self, rel, data):
        """Replace the file at a path (or create it). Small files only; returns the new item."""
        if len(data) > SIMPLE_LIMIT:
            raise ValueError('upload() handles files up to 4 MB; the sheet is far smaller')
        return self.call('PUT', self._item_path(rel) + ':/content?@microsoft.graph.conflictBehavior=replace',
                         body=data, content_type='application/octet-stream')
