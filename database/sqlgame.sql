create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    username text not null check (
        char_length(username) between 3 and 20
        and username ~ '^[A-Za-z0-9_]+$'
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.profiles
    add column if not exists updated_at timestamptz not null default now();

create unique index if not exists profiles_username_lower_unique
    on public.profiles (lower(username));

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username) on public.profiles to authenticated;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
    on public.profiles for select
    to authenticated
    using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
    on public.profiles for update
    to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

revoke all on function public.set_profile_updated_at() from public, anon, authenticated;

drop trigger if exists on_profiles_updated on public.profiles;
create trigger on_profiles_updated
    before update on public.profiles
    for each row execute procedure public.set_profile_updated_at();

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_username text;
    candidate_username text;
    suffix_length integer;
    inserted_rows integer;
    user_id_suffix text;
begin
    requested_username := coalesce(
        new.raw_user_meta_data ->> 'username',
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name',
        split_part(coalesce(new.email, 'player'), '@', 1)
    );
    requested_username := regexp_replace(requested_username, '[^A-Za-z0-9_]', '', 'g');

    if char_length(requested_username) < 3 then
        requested_username := 'player';
    end if;
    requested_username := left(requested_username, 20);

    insert into public.profiles (id, username)
    values (new.id, requested_username)
    on conflict do nothing;
    get diagnostics inserted_rows = row_count;

    if inserted_rows = 0 then
        user_id_suffix := replace(new.id::text, '-', '');
        for suffix_length in 8..18 loop
            candidate_username :=
                left(requested_username, 19 - suffix_length)
                || '_'
                || left(user_id_suffix, suffix_length);
            insert into public.profiles (id, username)
            values (new.id, candidate_username)
            on conflict do nothing;
            get diagnostics inserted_rows = row_count;
            exit when inserted_rows = 1;
        end loop;

        if inserted_rows = 0 then
            raise exception 'Could not create a unique username for the new account.';
        end if;
    end if;

    return new;
end;
$$;

revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.create_profile_for_new_user();

create table if not exists public.player_points (
    user_id uuid primary key references auth.users (id) on delete cascade,
    total_points bigint not null default 0 check (total_points >= 0),
    updated_at timestamptz not null default now()
);

create table if not exists public.game_sessions (
    id uuid primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    difficulty text not null check (difficulty in ('easy', 'normal', 'hard', 'practice')),
    final_score integer not null check (final_score >= 0),
    history jsonb not null default '[]'::jsonb,
    finished_at timestamptz not null default now()
);

create index if not exists game_sessions_user_finished_idx
    on public.game_sessions (user_id, finished_at desc);

alter table public.game_sessions enable row level security;
revoke all on public.game_sessions from anon, authenticated;
grant select, insert, update on public.game_sessions to authenticated;
grant select, insert, update on public.game_sessions to service_role;

drop policy if exists "Players can read their own game sessions" on public.game_sessions;
create policy "Players can read their own game sessions"
    on public.game_sessions for select
    to authenticated
    using (auth.uid() = user_id);

drop policy if exists "Players can insert their own game sessions" on public.game_sessions;
create policy "Players can insert their own game sessions"
    on public.game_sessions for insert
    to authenticated
    with check (auth.uid() = user_id);

drop policy if exists "Players can update their own game sessions" on public.game_sessions;
create policy "Players can update their own game sessions"
    on public.game_sessions for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create table if not exists public.player_point_transactions (
    user_id uuid not null references auth.users (id) on delete cascade,
    event_key text not null check (char_length(event_key) between 1 and 80),
    points_delta integer not null check (points_delta <> 0),
    created_at timestamptz not null default now(),
    primary key (user_id, event_key)
);

create index if not exists player_point_transactions_user_created_idx
    on public.player_point_transactions (user_id, created_at desc);

alter table public.player_points enable row level security;
alter table public.player_point_transactions enable row level security;

revoke all on public.player_points from anon, authenticated;
revoke all on public.player_point_transactions from anon, authenticated;
grant select on public.player_points to authenticated;
grant select on public.player_point_transactions to authenticated;
grant select, insert, update on public.player_points to service_role;
grant select, insert on public.player_point_transactions to service_role;

drop policy if exists "Players can read their own points" on public.player_points;
create policy "Players can read their own points"
    on public.player_points for select
    to authenticated
    using (auth.uid() = user_id);

drop policy if exists "Players can read their own point transactions" on public.player_point_transactions;
create policy "Players can read their own point transactions"
    on public.player_point_transactions for select
    to authenticated
    using (auth.uid() = user_id);

insert into public.player_points (user_id)
select id from auth.users
on conflict (user_id) do nothing;

create or replace function public.initialize_player_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.player_points (user_id)
    values (new.id)
    on conflict (user_id) do nothing;
    return new;
end;
$$;

revoke all on function public.initialize_player_points() from public, anon, authenticated;

drop trigger if exists on_auth_user_points_created on auth.users;
create trigger on_auth_user_points_created
    after insert on auth.users
    for each row execute procedure public.initialize_player_points();

create or replace function public.get_or_create_player_points(p_user_id uuid)
returns table (total_points bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_user_id is null then
        raise exception 'A player ID is required.';
    end if;

    insert into public.player_points (user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;

    return query
        select points.total_points
        from public.player_points as points
        where points.user_id = p_user_id;
end;
$$;

revoke all on function public.get_or_create_player_points(uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_player_points(uuid) to service_role;

create or replace function public.apply_player_points_change(
    p_user_id uuid,
    p_event_key text,
    p_points_delta integer
)
returns table (total_points bigint, applied boolean, insufficient boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_total bigint;
    new_total bigint;
    inserted_rows integer;
    is_answer boolean;
    hint_index integer;
begin
    if p_user_id is null or p_event_key is null or
        p_event_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(answer|hint:[0-2])$' then
        raise exception 'A valid player and points event are required.';
    end if;

    is_answer := p_event_key ~* ':answer$';
    if is_answer then
        if p_points_delta not in (10, 25, 50) then
            raise exception 'Invalid answer reward.';
        end if;
    else
        hint_index := right(p_event_key, 1)::integer;
        if p_points_delta <> (case hint_index when 0 then -3 when 1 then -5 else -7 end) then
            raise exception 'Invalid hint charge.';
        end if;
    end if;

    insert into public.player_points (user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;

    select points.total_points
    into current_total
    from public.player_points as points
    where points.user_id = p_user_id
    for update;

    if exists (
        select 1
        from public.player_point_transactions as transactions
        where transactions.user_id = p_user_id
            and transactions.event_key = p_event_key
    ) then
        return query select current_total, false, false;
        return;
    end if;

    if current_total + p_points_delta < 0 then
        return query select current_total, false, true;
        return;
    end if;

    insert into public.player_point_transactions (user_id, event_key, points_delta)
    values (p_user_id, p_event_key, p_points_delta)
    on conflict (user_id, event_key) do nothing;
    get diagnostics inserted_rows = row_count;

    if inserted_rows = 0 then
        select points.total_points
        into current_total
        from public.player_points as points
        where points.user_id = p_user_id;
        return query select current_total, false, false;
        return;
    end if;

    new_total := current_total + p_points_delta;
    update public.player_points as points
    set total_points = new_total,
        updated_at = now()
    where points.user_id = p_user_id;

    return query select new_total, true, false;
end;
$$;

revoke all on function public.apply_player_points_change(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.apply_player_points_change(uuid, text, integer) to service_role;
