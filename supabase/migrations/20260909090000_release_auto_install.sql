-- Let a release install itself outside working hours.
--
-- The desktop app will only act on this when nobody is at the machine: it
-- requires a long idle period, a time of day outside firm hours, and no open
-- window. An update that restarts the app while someone is drafting is worse
-- than one that waits, so the flag grants permission rather than compelling
-- anything.
alter table public.app_releases
  add column if not exists auto_install boolean not null default false;

comment on column public.app_releases.auto_install is
  'Install unattended after hours when the machine is idle. The client still '
  'refuses if anyone is using it; this only removes the prompt.';
