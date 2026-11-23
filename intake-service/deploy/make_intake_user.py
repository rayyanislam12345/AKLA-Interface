#!/usr/bin/env python3
"""Creates the Hub's own account for automatic filings: a profile named "Hub Intake".

The Hub's save path records who filed each version, so what the intake files needs
an account to be filed under (the Precedent Backlog Bot is the same idea). This one
has no password and an address nothing is delivered to, so nobody can sign in as it;
it is an approved profile with no role. Run once, from the owner's Mac:

    python3 intake-service/deploy/make_intake_user.py

It reads the Supabase access token from the Mac's keychain (the Supabase CLI's own
entry), prints no secrets, and does nothing if the account already exists. To remove
the account later, delete the user "hub-intake@akla.internal" in the Supabase
dashboard (Authentication > Users); what it filed stays.
"""
import base64
import json
import subprocess
import sys

REF = 'mhdufgphzalrzhzplbzf'
URL = f'https://{REF}.supabase.co'
NAME = 'Hub Intake'
EMAIL = 'hub-intake@akla.internal'


def curl(args, body=None):
    cmd = ['curl', '-s'] + args
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '--data-binary', '@-']
    out = subprocess.run(cmd, input=json.dumps(body).encode() if body is not None else None,
                         capture_output=True, check=True).stdout
    return json.loads(out) if out.strip() else None


def main():
    raw = subprocess.run(['security', 'find-generic-password', '-s', 'Supabase CLI', '-w'],
                         capture_output=True, text=True, check=True).stdout.strip()
    token = base64.b64decode(raw.replace('go-keyring-base64:', '')).decode()
    manage = ['-H', f'Authorization: Bearer {token}']

    def sql(query):
        return curl(['-X', 'POST'] + manage + [f'https://api.supabase.com/v1/projects/{REF}/database/query'],
                    {'query': query})

    existing = sql(f"select id from public.profiles where full_name = '{NAME}'")
    if existing:
        print(f'The {NAME} account already exists. Nothing to do.')
        return 0

    keys = curl(manage + [f'https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true'])
    service = next(k['api_key'] for k in keys if k.get('name') == 'service_role')
    made = curl(['-X', 'POST', '-H', f'apikey: {service}', '-H', f'Authorization: Bearer {service}',
                 f'{URL}/auth/v1/admin/users'],
                {'email': EMAIL, 'email_confirm': True, 'user_metadata': {'full_name': NAME}})
    uid = (made or {}).get('id')
    if not uid:
        shown = {k: v for k, v in (made or {}).items() if k in ('msg', 'message', 'error', 'code', 'error_code')}
        print('The account could not be created:', shown)
        return 1
    sql(f"update public.profiles set status = 'approved', full_name = '{NAME}' where id = '{uid}'")
    check = sql(f"select full_name, status, public.is_firm_member(id) as member from public.profiles where id = '{uid}'")
    print(f'Created the {NAME} account:', check[0] if check else uid)
    return 0


if __name__ == '__main__':
    sys.exit(main())
