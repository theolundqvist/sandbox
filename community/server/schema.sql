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

-- One row per install of the app, known by its token's hash, and what its free voice has cost so far, in millionths of a dollar.
create table if not exists installs (id text primary key, token_hash text unique not null, spent bigint not null default 0, created_at timestamptz not null default now());
-- What free voice cost everyone each UTC day.
create table if not exists voice_days (day date primary key, spent bigint not null default 0);
-- Takes a free-voice call's cost from the install's allowance and from today's cap in one statement, so calls at the same moment can't go over either. Returns the day it was counted on.
create or replace function reserve_voice(install text, cost bigint, allowance bigint, cap bigint) returns text language plpgsql as $$
declare today date := (now() at time zone 'utc')::date;
begin
  update installs set spent = spent + cost where id = install and spent + cost <= allowance;
  if not found then raise exception 'allowance' using errcode = 'SV001'; end if;
  insert into voice_days (day, spent) values (today, cost) on conflict (day) do update set spent = voice_days.spent + excluded.spent where voice_days.spent + excluded.spent <= cap;
  if not found then raise exception 'daily cap' using errcode = 'SV002'; end if;
  return today::text;
end $$;
