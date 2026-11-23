"""What the intake spends on Claude, counted by day in intake_usage, and the two caps.

    intake_settings.claude_daily_calls   the most Claude reads in one day (300)
    intake_settings.claude_monthly_usd   the most to spend in one calendar month (25)

Days and months are Pakistan time. `allowed(db)` is asked before every call; over
either cap the caller makes the message wait. `add(db, usd)` is called after every
call that reached Claude. An empty table reads as nothing spent.
"""
from datetime import datetime

from . import config

DEFAULT_DAILY_CALLS = 300
DEFAULT_MONTHLY_USD = 25

# USD per million tokens (Anthropic's first-party list prices, November 2026).
# cache_read / cache_write are multiples of the input price (a 5-minute cache write).
# Haiku 5.5 charges its higher rate card when the whole prompt is over 100,000 tokens.
PRICES = {
    'claude-haiku-5-5': {'input': 0.10, 'output': 0.50, 'cache_read': 0.1, 'cache_write': 1.25,
                         'long_over': 100_000, 'long_input': 0.50, 'long_output': 2.50},
    'claude-sonnet-5-5': {'input': 2.00, 'output': 10.00, 'cache_read': 0.05, 'cache_write': 1.25},
    'claude-opus-5-5': {'input': 4.00, 'output': 20.00, 'cache_read': 0.05, 'cache_write': 1.25},
}
# A model missing from the table is priced at the dearest row, so the cap bites early rather than late.
_UNKNOWN = 'claude-opus-5-5'


def cost_usd(model, usage):
    """The cost of one response from its `usage` (an SDK object or a dict)."""
    def n(name):
        value = usage.get(name) if isinstance(usage, dict) else getattr(usage, name, 0)
        return int(value or 0)
    if usage is None:
        return 0.0
    price = PRICES.get(model) or PRICES[_UNKNOWN]
    fresh, written, read, out = n('input_tokens'), n('cache_creation_input_tokens'), n('cache_read_input_tokens'), n('output_tokens')
    in_rate, out_rate = price['input'], price['output']
    if price.get('long_over') and fresh + written + read > price['long_over']:
        in_rate, out_rate = price['long_input'], price['long_output']
    usd = (fresh * in_rate + written * in_rate * price['cache_write'] + read * in_rate * price['cache_read']
           + out * out_rate) / 1_000_000
    return round(usd, 6)


def _today(now=None):
    return (now or datetime.now(config.tz())).astimezone(config.tz()).date()


def _number(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def spent(db, now=None):
    """{calls_today, usd_today, usd_month, daily_calls, monthly_usd}: the counts and the caps."""
    day = _today(now)
    rows = db.select('intake_usage', {'day': f'gte.{day.replace(day=1).isoformat()}'}, 'day,calls,usd') or []
    today = [r for r in rows if str(r.get('day'))[:10] == day.isoformat()]
    return {
        'calls_today': sum(int(r.get('calls') or 0) for r in today),
        'usd_today': round(sum(float(r.get('usd') or 0) for r in today), 5),
        'usd_month': round(sum(float(r.get('usd') or 0) for r in rows if str(r.get('day'))[:7] == day.isoformat()[:7]), 5),
        'daily_calls': _number(db.setting('claude_daily_calls', DEFAULT_DAILY_CALLS), DEFAULT_DAILY_CALLS),
        'monthly_usd': _number(db.setting('claude_monthly_usd', DEFAULT_MONTHLY_USD), DEFAULT_MONTHLY_USD),
    }


def allowed(db, now=None):
    """True while both caps have room for one more call. A cap of 0 switches Claude off."""
    s = spent(db, now)
    return s['calls_today'] < s['daily_calls'] and s['usd_month'] < s['monthly_usd']


def add(db, usd, calls=1, now=None):
    """Counts one call (and what it cost) against today."""
    day = _today(now).isoformat()
    row = db.one('intake_usage', {'day': f'eq.{day}'}, 'day,calls,usd') or {}
    db.upsert('intake_usage', {'day': day, 'calls': int(row.get('calls') or 0) + calls,
                               'usd': round(float(row.get('usd') or 0) + float(usd or 0), 5)}, on_conflict='day')
