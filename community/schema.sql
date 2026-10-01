create table if not exists worlds (
  id text primary key,
  title text not null,
  description text not null default '',
  author text not null,
  visibility text not null check (visibility in ('link', 'public')),
  owner_token_hash text not null,
  remix_of text,
  engine_version text not null default '',
  mods integer not null default 0,
  size integer not null default 0,
  zip_key text,
  cover_key text not null,
  clip_key text,
  created_at integer not null,
  updated_at integer not null,
  reports integer not null default 0
);
create index if not exists worlds_public on worlds (visibility, created_at desc);
-- Who did what when, by a hash of their IP, for rate limits; older rows are swept as new ones come.
create table if not exists hits (ip text not null, action text not null, at integer not null);
create index if not exists hits_by on hits (ip, action, at);
