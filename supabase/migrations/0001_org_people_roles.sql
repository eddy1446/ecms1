-- ECMS 0001: organization hierarchy, people, memberships, roles
-- Every synced table carries: created_at, updated_at, version, deleted_at, origin_device_id

create extension if not exists pgcrypto;

-- ---------- shared trigger: bump version + updated_at ----------
create or replace function set_row_meta() returns trigger as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  return new;
end $$ language plpgsql;

-- ---------- organization ----------
create table ministries (
  id uuid primary key default gen_random_uuid(),
