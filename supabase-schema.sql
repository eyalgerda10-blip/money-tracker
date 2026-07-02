-- Money tracker — Supabase schema
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query -> paste -> Run.

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('expense', 'income')),
  description text not null,
  amount numeric not null check (amount > 0),
  date date not null,
  category text not null default 'שונות',
  note text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric not null check (amount > 0),
  date date not null,
  direction text not null check (direction in ('owedToMe', 'iOwe')),
  note text default '',
  paid boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('expense', 'income')),
  name text not null,
  unique (user_id, type, name)
);

create table if not exists public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  budget numeric not null default 0,
  currency text not null default '₪'
);

alter table public.transactions enable row level security;
alter table public.debts enable row level security;
alter table public.categories enable row level security;
alter table public.settings enable row level security;

create policy "own transactions" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own debts" on public.debts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own categories" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own settings" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
