"""Settings: the YAML files under config/ and the .env files that hold the keys.

Keys are never written to the log. SUPABASE_URL falls back to VITE_SUPABASE_URL
so the repo's own .env is enough for the URL on a Mac.
"""
import os
from functools import lru_cache
from zoneinfo import ZoneInfo

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_DIR = os.path.join(ROOT, 'config')
REPO = os.path.dirname(ROOT)

# Read in this order; a later file never overrides an earlier value, and the
# process environment wins over all of them. INTAKE_ENV (colon separated) replaces the list.
DEFAULT_ENV_FILES = [
    os.path.join(ROOT, '.env'),
    os.path.join(REPO, '.env'),
    '/opt/chat-service/.env',                                    # Supabase on the VM
    '/opt/whatsapp-filer/.env',                                  # Graph on the VM
    os.path.expanduser('~/AKLA - Agenda Extractor/.env'),        # Graph on the Mac
]


def read_env_file(path):
    env = {}
    with open(path, encoding='utf8') as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


@lru_cache(maxsize=None)
def env():
    merged = {}
    paths = os.environ.get('INTAKE_ENV', '').split(':') if os.environ.get('INTAKE_ENV') else DEFAULT_ENV_FILES
    for path in paths:
        if path and os.path.exists(path):
            for key, value in read_env_file(path).items():
                merged.setdefault(key, value)
    merged.update({k: v for k, v in os.environ.items()})
    if not merged.get('SUPABASE_URL') and merged.get('VITE_SUPABASE_URL'):
        merged['SUPABASE_URL'] = merged['VITE_SUPABASE_URL']
    return merged


def has_supabase():
    e = env()
    return bool(e.get('SUPABASE_URL') and e.get('SUPABASE_SERVICE_ROLE_KEY'))


def has_graph():
    e = env()
    return all(e.get(k) for k in ('AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'))


def _load_yaml(name):
    with open(os.path.join(CONFIG_DIR, name), encoding='utf8') as fh:
        return yaml.safe_load(fh) or {}


@lru_cache(maxsize=None)
def settings():
    return _load_yaml('settings.yaml')


@lru_cache(maxsize=None)
def transactions():
    return _load_yaml('transactions.yaml')


@lru_cache(maxsize=None)
def people():
    return _load_yaml('people.yaml')


def tz():
    return ZoneInfo(settings().get('timezone', 'Asia/Karachi'))


def thresholds():
    return settings()['matching']
