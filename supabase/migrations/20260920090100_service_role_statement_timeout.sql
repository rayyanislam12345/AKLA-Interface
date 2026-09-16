-- The chat service reads the library through PostgREST as service_role,
-- which inherited the authenticator's 8-second statement timeout: a vector
-- search that took 8.1 seconds failed the lawyer's whole turn with
-- "canceling statement due to statement timeout". Backends that hold the
-- service key are the firm's own servers; give them room.
alter role service_role set statement_timeout = '30s';
notify pgrst, 'reload config';
