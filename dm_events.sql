-- AutoDM funnel events: one row per step, tagged with the reel (media id) that started it.
-- Run once in Supabase → SQL Editor (project "autodm"). Reel Lab's Funnel tab reads it.

create table if not exists dm_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  type       text not null check (type in ('comment', 'cooldown', 'dm', 'link', 'not_following')),
  media_id   text,          -- Instagram media id of the reel/post commented on
  rule_id    text,
  rule_name  text,
  user_id    text,          -- Instagram-scoped id of the commenter
  variant    text           -- which DM wording was sent (1, 2… or 'ai')
);

create index if not exists dm_events_created_idx on dm_events (created_at desc);
create index if not exists dm_events_media_idx on dm_events (media_id) where media_id is not null;

alter table dm_events enable row level security;
