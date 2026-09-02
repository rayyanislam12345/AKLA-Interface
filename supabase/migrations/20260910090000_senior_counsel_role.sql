-- Senior Counsel is a distinct employee title with the same permissions as
-- Partner everywhere the app checks for one — not a new tier, just another
-- name that carries the same access.
alter type app_role add value if not exists 'senior_counsel';
