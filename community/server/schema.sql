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

-- Upvotes: one per account and world.
create table if not exists votes (world text not null references worlds (id) on delete cascade, account uuid not null references accounts (id) on delete cascade, at timestamptz not null default now(), primary key (world, account));
create index if not exists votes_account on votes (account);

-- A play is a server-issued session of one install in one Community world. Its seconds only grow, never past the time since it started, and only an install's newest play takes more, so one install is credited for one world at a time.
create table if not exists plays (
  id uuid primary key default gen_random_uuid(),
  world text not null references worlds (id) on delete cascade,
  install text not null references installs (id) on delete cascade,
  account uuid references accounts (id) on delete set null,
  started_at timestamptz not null default now(),
  seconds integer not null default 0
);
create index if not exists plays_world on plays (world, install) where seconds >= 60;
create index if not exists plays_install on plays (install, started_at desc);
-- Plays of at least a minute and the installs behind them, kept on the world for the list's order.
alter table worlds add column if not exists plays integer not null default 0;
alter table worlds add column if not exists players integer not null default 0;
create index if not exists worlds_forks on worlds (remix_of, created_at desc, id desc) where removed_at is null and zip_key is not null and visibility = 'public';
create index if not exists worlds_top on worlds (players desc, created_at desc, id desc) where removed_at is null and zip_key is not null and visibility = 'public';

-- Time in any game per install, world and UTC day. world_key is a Community world's id or the random id a world keeps on its computer, never its name.
alter table installs add column if not exists playtime_at timestamptz;
create table if not exists playtime (
  install text not null references installs (id) on delete cascade,
  account uuid references accounts (id) on delete set null,
  world_key text not null,
  day date not null,
  seconds integer not null default 0,
  primary key (install, world_key, day)
);
create index if not exists playtime_account on playtime (account) where account is not null;
-- Adds a heartbeat's seconds to today's playtime, but never more than the time since this install's last heartbeat (a minute for its first, two at most), so replays, a fast clock or two worlds at once credit nothing extra. Locks the install's row, so beats at the same moment take turns.
create or replace function credit_playtime(inst text, acct uuid, key text, asked integer) returns integer language plpgsql as $$
declare was timestamptz; credit integer;
begin
  select playtime_at into was from installs where id = inst for update;
  update installs set playtime_at = clock_timestamp() where id = inst;
  credit := greatest(0, least(asked, 120, coalesce(extract(epoch from clock_timestamp() - was)::integer, 60)));
  insert into playtime (install, account, world_key, day, seconds) values (inst, acct, key, (now() at time zone 'utc')::date, credit)
    on conflict (install, world_key, day) do update set seconds = playtime.seconds + excluded.seconds, account = coalesce(excluded.account, playtime.account);
  return credit;
end $$;

-- What agents used, per install, world, UTC day, provider and model, the same fields as OMP's stats. Outside agents are invisible here; nothing estimates them.
create table if not exists agent_usage (
  install text not null references installs (id) on delete cascade,
  account uuid references accounts (id) on delete set null,
  world_key text not null,
  day date not null default (now() at time zone 'utc')::date,
  provider text not null,
  model text not null,
  subscription boolean not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read bigint not null default 0,
  cache_write bigint not null default 0,
  cost_usd numeric(14, 6) not null default 0,
  requests integer not null default 0,
  primary key (install, world_key, day, provider, model, subscription)
);
create index if not exists agent_usage_world on agent_usage (world_key, day);

-- Comments are plain text. Their author or the world's owner removes one; it stays as a row without its words.
create table if not exists comments (
  id bigserial primary key,
  world text not null references worlds (id) on delete cascade,
  account uuid not null references accounts (id) on delete cascade,
  body text not null,
  at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by text check (removed_by in ('author', 'owner', 'moderator'))
);
create index if not exists comments_world on comments (world, id);
-- Reports of anything people post besides worlds, one per reporter and thing.
create table if not exists reports (kind text not null, target text not null, reporter text not null, at timestamptz not null default now(), primary key (kind, target, reporter));

-- Builders credited on a world by their in-world name. A credit waits until someone signed in shows a token whose sha256 is one of its checks (see inviteBuilders in server.ts), then belongs to that account.
create table if not exists credits (
  world text not null references worlds (id) on delete cascade,
  name text not null,
  checks text[] not null,
  account uuid references accounts (id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'accepted')),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (world, name)
);
create unique index if not exists credits_account on credits (account, world) where account is not null;
create index if not exists credits_checks on credits using gin (checks) where state = 'pending';

-- Personal messages, plain text, read only by their two parties; an account's deletion takes every message it sent or got.
create table if not exists messages (
  id bigserial primary key,
  sender uuid not null references accounts (id) on delete cascade,
  recipient uuid not null references accounts (id) on delete cascade,
  body text not null,
  at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_sender on messages (sender, recipient, id);
create index if not exists messages_recipient on messages (recipient, sender, id);
create index if not exists messages_unread on messages (recipient) where read_at is null;
create table if not exists blocks (account uuid not null references accounts (id) on delete cascade, blocked uuid not null references accounts (id) on delete cascade, at timestamptz not null default now(), primary key (account, blocked));

-- A friend request, from requester to addressee; accepted once the addressee says yes. Either can end it, and a block ends it.
create table if not exists friends (
  requester uuid not null references accounts (id) on delete cascade,
  addressee uuid not null references accounts (id) on delete cascade,
  at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
create index if not exists friends_addressee on friends (addressee);

-- Worlds hosted right now, one per relay room, kept fresh by their host's app every 30 s; listed while seen in the last 90 s.
create table if not exists live (
  room text primary key,
  install text not null references installs (id) on delete cascade,
  account uuid not null references accounts (id) on delete cascade,
  title text not null,
  world text references worlds (id) on delete set null,
  invite text not null,
  access text not null check (access in ('anyone', 'friends', 'password')),
  players integer not null default 0,
  started_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);
create index if not exists live_seen on live (seen_at);

-- The admin panel: who may use it (set by hand in psql, never through the API), and its own sessions, apart from the site's and the app's.
alter table accounts add column if not exists admin boolean not null default false;
create table if not exists admin_sessions (token_hash text primary key, account uuid not null references accounts (id) on delete cascade, created_at timestamptz not null default now(), last_seen timestamptz not null default now());

-- What happened that concerns an account: a fork or a comment on its world, a message, a credit waiting, a friend request, or a request accepted. One unread notice per kind, person and world; a repeat only moves it up.
create table if not exists notifications (
  id bigserial primary key,
  account uuid not null references accounts (id) on delete cascade,
  kind text not null check (kind in ('fork', 'comment', 'message', 'credit', 'friend-request', 'friend-accepted')),
  actor uuid references accounts (id) on delete cascade,
  world text references worlds (id) on delete cascade,
  at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists notifications_unread on notifications (account, kind, actor, world) nulls not distinct where read_at is null;
create index if not exists notifications_account on notifications (account, at desc);

-- Community mods: a mod is a world row of kind 'mod', so comments, votes, reports, forks and takedown are the same. `mod` holds its folder name, README, exported API and npm packages; `uses` counts the worlds that added it, one each (mod_uses).
alter table worlds add column if not exists kind text not null default 'world' check (kind in ('world', 'mod'));
alter table worlds add column if not exists mod jsonb;
alter table worlds add column if not exists uses integer not null default 0;
create index if not exists worlds_mods on worlds (uses desc, created_at desc, id desc) where kind = 'mod' and removed_at is null and zip_key is not null;
create table if not exists mod_uses (mod text not null references worlds (id) on delete cascade, world_key text not null, install text references installs (id) on delete set null, at timestamptz not null default now(), primary key (mod, world_key));

-- Each time a world's files went live is a version, with what its publisher said changed. A fork keeps the version of its original it was first published from.
alter table worlds add column if not exists version integer not null default 0;
alter table worlds add column if not exists parent_version integer;
create table if not exists versions (
  world text not null references worlds (id) on delete cascade,
  version integer not null,
  changelog text not null default '',
  at timestamptz not null default now(),
  primary key (world, version)
);
insert into versions (world, version, at) select id, 1, updated_at from worlds where version = 0 and zip_key is not null on conflict do nothing;
update worlds set version = 1 where version = 0 and zip_key is not null;
