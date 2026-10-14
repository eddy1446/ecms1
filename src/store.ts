import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/* ------------------------------------------------------------------ */
/* Local store + outbox (works offline). Persisted in localStorage.    */
/* ------------------------------------------------------------------ */
export type Row = Record<string, any>
export type Op = { table: string; row: Row; onConflict?: string }
export type Store = {
  userId?: string
  churchId?: string
  churchName?: string
  ministryId?: string
  personId?: string
  members: Row[]
  events: Row[]
  attendance: Row[]
  departments: Row[]
  cells: Row[]
  deptTypes: Row[]
  deptMembers: Row[]
  cellMembers: Row[]
  outbox: Op[]
  roles: Row[]
  assignments: Row[]
  perms: string[]
  lastSync?: string
  lastError?: string
}

const KEY = 'ecms_store_v1'
export const empty: Store = {
  members: [],
  events: [],
  attendance: [],
  departments: [],
  cells: [],
  deptTypes: [],
  deptMembers: [],
  cellMembers: [],
  outbox: [],
  roles: [],
  assignments: [],
  perms: [],
}
export const today = () => new Date().toISOString().slice(0, 10)
export const byName = (a: Row, b: Row) => (a.name || '').localeCompare(b.name || '')

export function load(): Store {
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...empty }
  }
}

export let store: Store = load()
const listeners = new Set<() => void>()

export function commit(patch: Partial<Store>) {
  store = { ...store, ...patch }
  localStorage.setItem(KEY, JSON.stringify(store))
  listeners.forEach((f) => f())
}

export function useStore(): Store {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    listeners.add(f)
    return () => {
      listeners.delete(f)
    }
  }, [])
  return store
}

/* ------------------------------------------------------------------ */
/* Actions: always write locally first, then queue for the server.     */
/* ------------------------------------------------------------------ */
export function addMember(full_name: string, phone: string) {
  if (!store.churchId) return
  const person_id = crypto.randomUUID()
  const membership_id = crypto.randomUUID()
  commit({
    members: [...store.members, { membership_id, person_id, status: 'active', full_name, phone }],
    outbox: [
      ...store.outbox,
      { table: 'people', row: { id: person_id, full_name, phone: phone || null } },
      {
        table: 'church_memberships',
        row: { id: membership_id, person_id, church_id: store.churchId, status: 'active', joined_on: today() },
      },
    ],
  })
}

export function addDepartment(name: string, type_id: string) {
  if (!store.churchId || !store.ministryId) return
  const d = { id: crypto.randomUUID(), name, type_id: type_id || null }
  commit({
    departments: [...store.departments, d].sort(byName),
    outbox: [
      ...store.outbox,
      { table: 'departments', row: { ...d, ministry_id: store.ministryId, church_id: store.churchId } },
    ],
  })
}

export function addCell(name: string) {
  if (!store.churchId) return
  const c = { id: crypto.randomUUID(), name }
  commit({
    cells: [...store.cells, c].sort(byName),
    outbox: [...store.outbox, { table: 'cell_groups', row: { ...c, church_id: store.churchId } }],
  })
}

export function setDeptMember(department_id: string, church_membership_id: string, on: boolean) {
  if (!store.churchId) return
  const same = (l: Row) => l.church_membership_id === church_membership_id && l.department_id === department_id
  const existing = store.deptMembers.find(same)
  if (on && existing) return
  const id = existing?.id ?? crypto.randomUUID()
  commit({
    deptMembers: on
      ? [...store.deptMembers, { id, church_membership_id, department_id }]
      : store.deptMembers.filter((l) => !same(l)),
    outbox: [
      ...store.outbox.filter(
        (o) =>
          !(
            o.table === 'department_memberships' &&
            o.row.church_membership_id === church_membership_id &&
            o.row.department_id === department_id
          ),
      ),
      {
        table: 'department_memberships',
        onConflict: 'church_membership_id,department_id',
        row: {
          id,
          church_membership_id,
          church_id: store.churchId,
          department_id,
          joined_on: today(),
          deleted_at: on ? null : new Date().toISOString(),
        },
      },
    ],
  })
}

// A member is in at most one cell group: joining a new one leaves the old one.
export function setCellMember(cell_group_id: string, church_membership_id: string, on: boolean) {
  if (!store.churchId) return
  const now = new Date().toISOString()
  const ops: Op[] = []
  let next = [...store.cellMembers]

  const old = next.find((l) => l.church_membership_id === church_membership_id)
  if (old && (!on || old.cell_group_id !== cell_group_id)) {
    ops.push({
      table: 'cell_memberships',
      row: {
        id: old.id,
        church_membership_id,
        church_id: store.churchId,
        cell_group_id: old.cell_group_id,
        deleted_at: now,
      },
    })
    next = next.filter((l) => l !== old)
  }
  if (on && !(old && old.cell_group_id === cell_group_id)) {
    const id = crypto.randomUUID()
    ops.push({
      table: 'cell_memberships',
      row: {
        id,
        church_membership_id,
        church_id: store.churchId,
        cell_group_id,
        joined_on: today(),
        deleted_at: null,
      },
    })
    next.push({ id, church_membership_id, cell_group_id })
  }
  commit({ cellMembers: next, outbox: [...store.outbox, ...ops] })
}

export function addEvent(title: string, date: string, group: string): string | undefined {
  if (!store.churchId) return
  const id = crypto.randomUUID()
  const starts_at = new Date(date + 'T09:00:00').toISOString()
  const department_id = group.startsWith('d:') ? group.slice(2) : null
  const cell_group_id = group.startsWith('c:') ? group.slice(2) : null
  const ev = { id, title, event_type: 'service', starts_at, department_id, cell_group_id }
  commit({
    events: [ev, ...store.events].sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
    outbox: [
      ...store.outbox,
      { table: 'events', row: { ...ev, church_id: store.churchId, created_by: store.personId } },
    ],
  })
  return id
}

export function markAttendance(event_id: string, person_id: string, status: string) {
  if (!store.churchId) return
  const existing = store.attendance.find((a) => a.event_id === event_id && a.person_id === person_id)
  const id = existing?.id ?? crypto.randomUUID()
  commit({
    attendance: [...store.attendance.filter((a) => a !== existing), { id, event_id, person_id, status }],
    // replace any older queued change for the same person+event
    outbox: [
      ...store.outbox.filter(
        (o) => !(o.table === 'attendance' && o.row.event_id === event_id && o.row.person_id === person_id),
      ),
      {
        table: 'attendance',
        onConflict: 'event_id,person_id',
        row: {
          id,
          event_id,
          church_id: store.churchId,
          person_id,
          status,
          recorded_by: store.personId,
          recorded_at: new Date().toISOString(),
        },
      },
    ],
  })
}

/* ------------------------------------------------------------------ */
/* Sync: push the outbox in order, then pull fresh server data.        */
/* ------------------------------------------------------------------ */
let syncing = false

async function pull(userId: string) {
  const p = await supabase.from('people').select('id').eq('auth_user_id', userId).maybeSingle()
  if (p.error) throw new Error(p.error.message)

  const c = await supabase.from('churches').select('id,name,ministry_id').order('name').limit(1).maybeSingle()
  if (c.error) throw new Error(c.error.message)
  if (!c.data) throw new Error('No church access yet. Ask an administrator to assign you a role.')
  const churchId = c.data.id

  const [m, e, a, d, g, dm, cm, dt, ro, asg, pm] = await Promise.all([
    supabase
      .from('church_memberships')
      .select('id,person_id,status,people(full_name,phone,auth_user_id)')
      .eq('church_id', churchId)
      .is('deleted_at', null)
      .order('created_at'),
    supabase
      .from('events')
      .select('id,title,event_type,starts_at,department_id,cell_group_id')
      .eq('church_id', churchId)
      .is('deleted_at', null)
      .order('starts_at', { ascending: false })
      .limit(100),
    supabase.from('attendance').select('id,event_id,person_id,status').eq('church_id', churchId).limit(1000),
    supabase.from('departments').select('id,name,type_id').eq('church_id', churchId).is('deleted_at', null).order('name'),
    supabase.from('cell_groups').select('id,name').eq('church_id', churchId).is('deleted_at', null).order('name'),
    supabase
      .from('department_memberships')
      .select('id,church_membership_id,department_id')
      .eq('church_id', churchId)
      .is('deleted_at', null),
    supabase
      .from('cell_memberships')
      .select('id,church_membership_id,cell_group_id')
      .eq('church_id', churchId)
      .is('deleted_at', null),
    supabase.from('department_types').select('id,name').order('name'),
    supabase.from('roles').select('id,code,name,scope_type').order('name'),
    supabase
      .from('role_assignments')
      .select('id,person_id,role_id,scope_type,scope_id,ends_at')
      .is('revoked_at', null),
    supabase.rpc('my_permissions'),
  ])
  for (const r of [m, e, a, d, g, dm, cm, dt, ro, asg, pm]) if (r.error) throw new Error(r.error.message)

  commit({
    personId: p.data?.id,
    churchId,
    churchName: c.data.name,
    ministryId: c.data.ministry_id,
    members: (m.data as any[]).map((r) => ({
      membership_id: r.id,
      person_id: r.person_id,
      status: r.status,
      full_name: r.people?.full_name,
      phone: r.people?.phone,
      has_login: !!r.people?.auth_user_id,
    })),
    events: e.data as Row[],
    attendance: a.data as Row[],
    departments: d.data as Row[],
    cells: g.data as Row[],
    deptMembers: dm.data as Row[],
    cellMembers: cm.data as Row[],
    deptTypes: dt.data as Row[],
    roles: ro.data as Row[],
    assignments: asg.data as Row[],
    perms: (pm.data as string[]) || [],
  })
}

export async function sync(userId: string): Promise<string | null> {
  if (syncing) return null
  syncing = true
  try {
    while (store.outbox.length) {
      const op = store.outbox[0]
      const { error } = await supabase.from(op.table).upsert(op.row, { onConflict: op.onConflict })
      if (error) return `Could not sync ${op.table}: ${error.message}`
      commit({ outbox: store.outbox.slice(1) })
    }
    await pull(userId)
    commit({ lastSync: new Date().toISOString() })
    return null
  } catch (e: any) {
    return e?.message || 'Network error'
  } finally {
    syncing = false
  }
}
