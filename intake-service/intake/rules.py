"""The rules a message passes before any model sees it.

Ported from the Email Bot (src/emailbot/classify/rules.py) and widened for a
whole firm's mail. The lists live in config/mail_rules.yaml. In order:

  1. never share   withheld. First and final: no later rule, no work signal and
                   no folder (sent mail included) brings the message back.
  2. work signal   a legal term, or a court / regulator sender: read.
  3. automated     bulk headers or a no-reply sender: dropped.
  4. personal      consumer-domain mail with no work signal: dropped.
  5. anything else is read.

A message is the neutral dict intake/mailbox.py builds (sender_address, to,
cc, subject, newest_text, thread_text, headers, attachments, folder). Nothing
here logs or returns the text of a message: a verdict carries the rule's name
and the sender's class, and for a withheld message only the name of the list
that matched ("never_share:pay"), never the word that was found.
"""
import os
import re
from dataclasses import dataclass, field

import yaml

from . import config

RULES_FILE = 'mail_rules.yaml'

WITHHELD, DROPPED, READ = 'withheld', 'dropped', 'read'

# Characters that change how a word looks without changing what it says.
_APOSTROPHES = str.maketrans({'’': "'", '‘': "'", 'ʼ': "'", '′': "'", '`': "'",
                              '–': '-', '—': '-', '‑': '-', '\xa0': ' '})
_INVISIBLE = re.compile('[​‌‍⁠﻿­]')


def plain(text):
    """Lower case, straight quotes and dashes, no apostrophes, no invisible characters."""
    text = _INVISIBLE.sub('', (text or '').translate(_APOSTROPHES))
    return text.replace("'", '').lower()


def compile_keywords(keywords):
    """[(keyword, pattern)]: whole words, flexible spacing inside a phrase, an optional final s."""
    out = []
    for keyword in keywords or []:
        words = [re.escape(w) for w in plain(str(keyword)).replace('-', ' ').split()]
        if words:
            pattern = r'(?<![a-z0-9])' + r'[\s\-_]+'.join(words) + r'(?:e?s)?(?![a-z0-9])'
            out.append((str(keyword), re.compile(pattern)))
    return out


def find(patterns, text):
    return [keyword for keyword, pattern in patterns if pattern.search(text)]


@dataclass
class Hints:
    """Cheap signals handed to Claude so it does not have to work them out."""
    sender_class: str = 'unknown'          # institutional | internal | personal | external | unknown
    deadline: list = field(default_factory=list)
    meeting: list = field(default_factory=list)
    legal: list = field(default_factory=list)
    looks_automated: bool = False

    def as_prompt_block(self):
        lines = [f'- Sender category: {self.sender_class}']
        if self.looks_automated:
            lines.append('- Message carries bulk/list mail headers')
        for label, values in (('Deadline-ish phrases found', self.deadline),
                              ('Meeting-ish phrases found', self.meeting),
                              ('Legal terms found', self.legal)):
            if values:
                lines.append(f"- {label}: {', '.join(sorted(values)[:12])}")
        return '\n'.join(lines)


@dataclass
class Verdict:
    outcome: str                           # 'withheld' | 'dropped' | 'read'
    rule: str                              # the rule that decided
    sender_class: str
    hints: Hints


def domain_of(address):
    return (address or '').rpartition('@')[2].strip().lower() if '@' in (address or '') else ''


class RuleEngine:
    def __init__(self, rules):
        rules = rules or {}
        self.firm = _domains(rules.get('firm_domains'))
        self.institutional = _domains(rules.get('institutional_domains'))
        self.personal = _domains(rules.get('personal_domains'))
        self.automated_senders = [str(s).lower() for s in rules.get('automated_senders') or []]
        self.automated_headers = {str(h).lower() for h in rules.get('automated_headers') or []}
        self.bulk_values = {str(v).lower() for v in rules.get('bulk_precedence_values') or []}
        self.work = compile_keywords(rules.get('work_signal_keywords'))
        self.deadline = compile_keywords(rules.get('deadline_hint_keywords'))
        self.meeting = compile_keywords(rules.get('meeting_hint_keywords'))
        # Each never-share list keeps its name, which is all a withheld row records.
        self.never_share = [(name, compile_keywords(words)) for name, words in (rules.get('never_share') or {}).items()]
        self.never_share_subject = [(name, compile_keywords(words))
                                    for name, words in (rules.get('never_share_subject') or {}).items()]
        self.never_share_addresses = {str(a).strip().lower() for a in rules.get('never_share_addresses') or [] if a}

    @classmethod
    def from_file(cls, path=None):
        path = path or os.path.join(config.CONFIG_DIR, RULES_FILE)
        with open(path, encoding='utf8') as fh:
            return cls(yaml.safe_load(fh) or {})

    # ---- the sender
    def is_firm_address(self, address):
        return _in(domain_of(address), self.firm)

    def sender_class(self, message):
        domain = domain_of(message.get('sender_address'))
        if not domain:
            return 'unknown'
        if _in(domain, self.institutional):
            return 'institutional'
        if _in(domain, self.firm):
            return 'internal'
        if _in(domain, self.personal):
            return 'personal'
        return 'external'

    def is_automated(self, message):
        headers = message.get('headers') or {}
        if self.automated_headers & set(headers):
            return True
        if str(headers.get('precedence', '')).strip().lower() in self.bulk_values:
            return True
        if str(headers.get('auto-submitted', '')).strip().lower() not in ('', 'no'):
            return True
        local = (message.get('sender_address') or '').split('@')[0].lower()
        return any(marker in local for marker in self.automated_senders)

    # ---- never share
    def never_share_rule(self, message):
        """The name of the never-share rule the message hits, or None. Looks at everything a
        model would be shown: the subject, the newest message, the quoted thread and the
        attachment names; and at who it is from and to."""
        addresses = [message.get('sender_address')] + list(message.get('to') or []) + list(message.get('cc') or [])
        for address in addresses:
            address = (address or '').strip().lower()
            if address and (address in self.never_share_addresses or _in(domain_of(address), self.never_share_addresses)):
                return 'never_share:address'
        subject = plain(message.get('subject'))
        for name, patterns in self.never_share_subject:
            if find(patterns, subject):
                return f'never_share:{name}'
        everything = '\n'.join([subject, plain(message.get('newest_text')), plain(message.get('thread_text')),
                                plain('\n'.join(message.get('attachments') or []))])
        for name, patterns in self.never_share:
            if find(patterns, everything):
                return f'never_share:{name}'
        return None

    # ---- the verdict
    def evaluate(self, message):
        sender_class = self.sender_class(message)
        automated = self.is_automated(message)

        # Never share comes before anything else is even computed, and nothing below can undo it.
        withheld = self.never_share_rule(message)
        if withheld:
            return Verdict(WITHHELD, withheld, sender_class, Hints(sender_class=sender_class))

        text = '\n'.join([plain(message.get('subject')), plain(message.get('newest_text')),
                          plain(message.get('thread_text')), plain('\n'.join(message.get('attachments') or []))])
        legal = find(self.work, text)
        hints = Hints(sender_class=sender_class, deadline=find(self.deadline, text),
                      meeting=find(self.meeting, text), legal=legal, looks_automated=automated)

        # A work signal beats every cheap dismissal below.
        if legal or sender_class == 'institutional':
            return Verdict(READ, 'work_signal', sender_class, hints)
        if automated:
            return Verdict(DROPPED, 'automated_bulk', sender_class, hints)
        if sender_class == 'personal':
            return Verdict(DROPPED, 'personal_domain_no_work_signal', sender_class, hints)
        # The same rule from the other side: a member of the firm writing only to
        # consumer addresses, with no work signal, is private mail.
        recipients = [a for a in list(message.get('to') or []) + list(message.get('cc') or []) if a]
        if sender_class == 'internal' and recipients and all(_in(domain_of(a), self.personal) for a in recipients):
            return Verdict(DROPPED, 'personal_recipients_no_work_signal', sender_class, hints)
        return Verdict(READ, 'escalate', sender_class, hints)


def _domains(values):
    return {str(v).strip().lower() for v in values or [] if v}


def _in(domain, domains):
    """True when the domain is one of the listed ones or a subdomain of one."""
    return bool(domain) and any(domain == d or domain.endswith('.' + d) for d in domains)


_default = None


def default_engine():
    """The engine built from config/mail_rules.yaml, read once."""
    global _default
    if _default is None:
        _default = RuleEngine.from_file()
    return _default
