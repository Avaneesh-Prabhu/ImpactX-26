-- Event Meal Tracker: Supabase (Postgres) schema
-- Run this once in Supabase > SQL Editor > New query.
-- Safe to re-run: everything uses IF NOT EXISTS.

create table if not exists participants (
  uid      integer primary key,
  name     text not null,
  team     text not null,
  dietary  text,
  notes    text
);

create table if not exists meals (
  id          text primary key,
  name        text not null,
  start_time  text not null,          -- "HH:mm" 24h, compared as text
  end_time    text not null,
  description text,
  sort_order  integer not null default 0
);

create table if not exists users (
  id            text primary key,
  name          text not null,
  usn           text not null,
  password_hash text not null,
  role          text not null default 'Volunteer',
  created_at    timestamptz not null default now()
);
create unique index if not exists users_usn_upper_idx on users (upper(usn));

-- Live logs for the meal currently being served.
-- The unique constraint is what guarantees a participant can never be
-- logged twice for the same meal, even if two volunteers scan at once.
create table if not exists logs (
  id              text primary key,
  participant_uid integer not null,
  participant_name text not null,
  team            text not null,
  meal_id         text not null,
  meal_name       text not null,
  scanned_at      timestamptz not null default now(),
  scanned_by_usn  text not null,
  unique (participant_uid, meal_id)
);
create index if not exists logs_scanned_at_idx on logs (scanned_at desc);

-- Finished meals get archived here by the rollover job.
create table if not exists meal_history (
  id           text primary key,
  meal_id      text not null,
  meal_name    text not null,
  archived_at  timestamptz not null default now(),
  total_served integer not null,
  logs         jsonb not null default '[]'::jsonb
);

-- Small key/value store: 'timeOverride' and 'lastActiveMealId'.
create table if not exists app_state (
  key   text primary key,
  value jsonb
);

-- The Express server connects with the direct Postgres role (bypasses RLS).
-- Enabling RLS with no policies blocks the public anon/authenticated API keys
-- from reading these tables (users.password_hash is in here).
alter table participants  enable row level security;
alter table meals         enable row level security;
alter table users         enable row level security;
alter table logs          enable row level security;
alter table meal_history  enable row level security;
alter table app_state     enable row level security;
