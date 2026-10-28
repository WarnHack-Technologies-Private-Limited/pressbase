-- Pressbase SEO: redirects and the 404 log.
create table pressbase_seo_redirects (
  id bigserial primary key,
  -- A path ("/old-post/", no host, no query) or, with regex, a pattern matched against the path.
  source text not null,
  -- Where to send visitors: a path or an http(s) URL; empty for 410.
  target text not null default '',
  status smallint not null default 301 check (status in (301, 302, 307, 410)),
  regex boolean not null default false,
  hits bigint not null default 0,
  last_hit timestamptz,
  created timestamptz not null default now()
);
create unique index pressbase_seo_redirects_source_idx on pressbase_seo_redirects (source);
create index pressbase_seo_redirects_regex_idx on pressbase_seo_redirects (regex) where regex;

-- Never IP addresses: the path, the last referrer, how often and when.
create table pressbase_seo_404s (
  id bigserial primary key,
  path text not null,
  referrer text not null default '',
  hits bigint not null default 1,
  last_seen timestamptz not null default now()
);
create unique index pressbase_seo_404s_path_idx on pressbase_seo_404s (path);
create index pressbase_seo_404s_last_seen_idx on pressbase_seo_404s (last_seen);
