-- ECMS 0003: events and attendance

create table events (
  id uuid primary key default gen_random_uuid(),
  church_id uuid not null references churches(id),
  title text not null,
  event_type text not null default 'service'
    check (event_type in ('service','meeting','conference','seminar','evangelism','sports','prayer','other')),
  starts_at timestamptz not null,
  location text,
  status text not null default 'scheduled' check (status in ('scheduled','held','cancelled')),
  created_by uuid references people(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  deleted_at timestamptz,
  origin_device_id text,
  unique (id, church_id)
);
create index events_church_date on events (church_id, starts_at desc);

create table attendance (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  church_id uuid not null,
  person_id uuid not null references people(id),
  status text not null check (status in ('present','absent','excused','late')),
  recorded_by uuid references people(id),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  deleted_at timestamptz,
  origin_device_id text,
  foreign key (event_id, church_id) references events (id, church_id),
  unique (event_id, person_id)          -- no duplicate attendance
);
create index attendance_church on attendance (church_id, event_id);

-- the person must be a member of the same church as the event
create or replace function check_attendance_member() returns trigger as $$
begin
  if not exists (select 1 from church_memberships m
                 where m.person_id = new.person_id and m.church_id = new.church_id
                   and m.deleted_at is null) then
    raise exception 'Person is not a member of this church';
  end if;
  return new;
end $$ language plpgsql;

create trigger attendance_member_check before insert or update on attendance
  for each row execute function check_attendance_member();

create trigger events_meta before insert or update on events
  for each row execute function set_row_meta();
create trigger attendance_meta before insert or update on attendance
  for each row execute function set_row_meta();

alter table events enable row level security;
alter table attendance enable row level security;

create policy events_read on events for select to authenticated
  using (can_scope('events.read','church',church_id));
create policy events_write on events for all to authenticated
  using (can_scope('events.write','church',church_id))
  with check (can_scope('events.write','church',church_id));

create policy attendance_read on attendance for select to authenticated
  using (can_scope('attendance.read','church',church_id));
create policy attendance_write on attendance for all to authenticated
  using (can_scope('attendance.write','church',church_id))
  with check (can_scope('attendance.write','church',church_id));
