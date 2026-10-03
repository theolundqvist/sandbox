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

-- One row per screen shown or button pressed outside the game: the app's start screen (surface app), the launcher's menu page (menu) and the site (site). Never anything typed. An install is known by its id, never its token; the site's visitors are an anonymous id in props.anon. account stays null until there are logins.
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  install text references installs (id) on delete cascade,
  account uuid,
  session uuid not null,
  surface text not null,
  screen text,
  action text not null,
  props jsonb not null default '{}'
);
create index if not exists events_by_install on events (install, at);
create index if not exists events_by_action on events (action, at);

-- Accounts: needed only to publish, take down, upvote and comment. The password is an argon2id hash; usernames are the public name, a-z 0-9 _.
create extension if not exists citext;
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  email citext unique not null,
  password_hash text not null,
  username citext unique not null,
  username_changed_at timestamptz,
  -- Set by a moderator: the account can't publish, comment or message, and its worlds leave discovery.
  banned_at timestamptz,
  created_at timestamptz not null default now()
);
-- Sessions by their token's hash; idle for 90 days, they stop working.
create table if not exists sessions (token_hash text primary key, account uuid not null references accounts(id) on delete cascade, created_at timestamptz not null default now(), last_seen timestamptz not null default now());
create index if not exists sessions_account on sessions (account);
-- Hashed IPs an account has signed in from: the per-email limit never locks those out, so nobody can keep an owner out of their own account.
create table if not exists known_ips (account uuid not null references accounts(id) on delete cascade, ip text not null, primary key (account, ip));

-- A world belongs to an account, or, shared before accounts, to its owner token until that is claimed. A removed world stays as a tombstone, so forks still know they had a parent.
alter table worlds add column if not exists account uuid references accounts(id) on delete set null;
alter table worlds alter column owner_token_hash drop not null;
alter table worlds alter column author set default '';
alter table worlds add column if not exists removed_at timestamptz;
alter table worlds add column if not exists removed_by text check (removed_by in ('owner', 'account', 'moderator'));
-- The publishing computer's random id for its local world: a world a moderator removed can't come back under a new id.
alter table worlds add column if not exists origin text;
create index if not exists worlds_account on worlds (account) where removed_at is null;
create index if not exists worlds_origin on worlds (origin) where removed_by = 'moderator';

-- Rate limits as one counter per caller and action over a fixed window, bumped in one statement so requests at the same moment can't slip past.
create table if not exists limits (who text not null, action text not null, since timestamptz not null default now(), n integer not null default 1, primary key (who, action));
-- Files of removed worlds still to delete from R2; the sweep retries until they're gone.
create table if not exists doomed (key text primary key, at timestamptz not null default now());
-- Usage stats outlive an account, without it.
do $$ begin
  alter table events add constraint events_account foreign key (account) references accounts (id) on delete set null;
exception when duplicate_object then null;
end $$;
