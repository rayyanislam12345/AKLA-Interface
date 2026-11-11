"""One-line log messages with a timestamp, to stdout (journald on the VM)."""
import sys
from datetime import datetime


def log(message, *args):
    text = message % args if args else message
    print(f'{datetime.now():%Y-%m-%d %H:%M:%S} {text}', flush=True)


def warn(message, *args):
    log('WARNING ' + message, *args)


def fail(message, *args):
    log('ERROR ' + message, *args)
    sys.exit(1)
