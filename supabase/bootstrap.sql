-- ECMS bootstrap: run ONCE in the Supabase SQL Editor.
-- 1) Sign up in the app first with your email.
-- 2) Replace BOTH 'YOUR_EMAIL' values (and the names if you like), then run.

do $$
declare
  v_email text := 'YOUR_EMAIL';
  v_user uuid; v_min uuid; v_church uuid; v_person uuid;
begin
  select id into v_user from auth.users where email = v_email;
  if v_user is null then
    raise exception 'No account for %. Sign up in the app first.', v_email;
  end if;

  insert into ministries (name) values ('Evangelical Christian Ministry') returning id into v_min;
  insert into churches (ministry_id, name) values (v_min, 'Ebenezer Praise Center') returning id into v_church;
  insert into people (auth_user_id, full_name, email) values (v_user, 'Eddy', v_email) returning id into v_person;

  insert into role_assignments (person_id, role_id, scope_type, scope_id)
  select v_person, id, 'ministry', v_min from roles where code in ('bishop','ministry_admin');

  insert into role_assignments (person_id, role_id, scope_type, scope_id)
  select v_person, id, 'church', v_church from roles
  where code in ('church_admin','church_secretary','church_treasurer');
end $$;
