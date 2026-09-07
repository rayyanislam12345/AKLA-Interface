-- Founder is a real role, rather than a display-only alias for admin.
-- This is deliberately separate from the function update: PostgreSQL requires
-- a newly added enum value to be committed before it can be used in SQL.
alter type public.app_role add value if not exists 'founder';
