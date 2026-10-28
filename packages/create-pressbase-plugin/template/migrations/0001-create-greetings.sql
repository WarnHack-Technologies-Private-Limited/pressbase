-- Runs once, when the plugin is first activated (files run in name order;
-- add 0002-….sql for later changes, never edit one that has shipped).
create table if not exists __PLUGIN_PREFIX__greetings (
  id serial primary key,
  name text not null,
  created_at timestamptz not null default now()
);
