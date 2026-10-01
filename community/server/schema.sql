-- One row per shared world. Its files live in R2 under worlds/<id>/<upload>/; an upload is live once the server has checked it landed.
create table if not exists worlds (
  id text primary key,
  title text not null,
  description text not null,
  author text not null,
  visibility text not null check (visibility in ('link', 'public')),
  owner_token_hash text not null,
  remix_of text,
  engine_version text not null,
  mods integer not null,
  size bigint not null default 0,
  zip_key text,
  cover_key text,
  clip_key text,
  pending jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reports integer not null default 0
);
create index if not exists worlds_public on worlds (created_at desc) where visibility = 'public' and zip_key is not null;

-- Requests per hashed IP, for rate limits.
create table if not exists hits (ip text not null, action text not null, at timestamptz not null default now());
create index if not exists hits_by on hits (ip, action, at);
