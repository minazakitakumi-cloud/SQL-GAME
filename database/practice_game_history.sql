alter table public.game_sessions
    drop constraint if exists game_sessions_difficulty_check;

alter table public.game_sessions
    add constraint game_sessions_difficulty_check
    check (difficulty in ('easy', 'normal', 'hard', 'practice'));

grant update on public.game_sessions to authenticated;
grant update on public.game_sessions to service_role;

drop policy if exists "Players can update their own game sessions" on public.game_sessions;
create policy "Players can update their own game sessions"
    on public.game_sessions for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
