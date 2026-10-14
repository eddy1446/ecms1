import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient, type Session } from '@supabase/supabase-js'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/* ------------------------------------------------------------------ */
/* Local store + outbox (works offline). Persisted in localStorage.    */
/* ------------------------------------------------------------------ */
type Row = Record<string, any>
type Op = { table: string; row: Row; onConflict?: string }
type Store = {
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
  lastSync?: string
}

const KEY = 'ecms_store_v1'
const empty: Store = {
  members: [],
  events: [],
  attendance: [],
  departments: [],
  cells: [],
  deptTypes: [],
  deptMembers: [],
  cellMembers: [],
  outbox: [],
}
const today = () => new Date().toISOString().slice(0, 10)
const byName = (a: Row, b: Row) => (a.name || '').localeCompare(b.name || '')

function load(): Store {
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...empty }
  }
}

let store: Store = load()
const listeners = new Set<() => void>()

function commit(patch: Partial<Store>) {
  store = { ...store, ...patch }
  localStorage.setItem(KEY, JSON.stringify(store))
  listeners.forEach((f) => f())
}

function useStore(): Store {
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
function addMember(full_name: string, phone: string) {
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

function addDepartment(name: string, type_id: string) {
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

function addCell(name: string) {
  if (!store.churchId) return
  const c = { id: crypto.randomUUID(), name }
  commit({
    cells: [...store.cells, c].sort(byName),
    outbox: [...store.outbox, { table: 'cell_groups', row: { ...c, church_id: store.churchId } }],
  })
}

function setDeptMember(department_id: string, church_membership_id: string, on: boolean) {
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
function setCellMember(cell_group_id: string, church_membership_id: string, on: boolean) {
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

function addEvent(title: string, date: string, group: string): string | undefined {
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

function markAttendance(event_id: string, person_id: string, status: string) {
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

  const [m, e, a, d, g, dm, cm, dt] = await Promise.all([
    supabase
      .from('church_memberships')
      .select('id,person_id,status,people(full_name,phone)')
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
  ])
  for (const r of [m, e, a, d, g, dm, cm, dt]) if (r.error) throw new Error(r.error.message)

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
    })),
    events: e.data as Row[],
    attendance: a.data as Row[],
    departments: d.data as Row[],
    cells: g.data as Row[],
    deptMembers: dm.data as Row[],
    cellMembers: cm.data as Row[],
    deptTypes: dt.data as Row[],
  })
}

async function sync(userId: string): Promise<string | null> {
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

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */
function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function go(kind: 'in' | 'up') {
    setBusy(true)
    setMsg('')
    const res =
      kind === 'in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
    if (res.error) setMsg(res.error.message)
    else if (kind === 'up' && !res.data.session) setMsg('Account created. Confirm your email, then sign in.')
    setBusy(false)
  }

  return (
    <div className="card login">
      <h1>ECMS</h1>
      <p className="muted">Evangelical Christian Ministry</p>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        type="password"
        placeholder="Password (6+ characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {msg && <div className="banner">{msg}</div>}
      <button className="primary" disabled={busy || !email || !password} onClick={() => go('in')}>
        Sign in
      </button>
      <button disabled={busy || !email || !password} onClick={() => go('up')}>
        Create account
      </button>
    </div>
  )
}

function groupsOf(s: Store, membershipId: string): string {
  const depts = s.deptMembers
    .filter((l) => l.church_membership_id === membershipId)
    .map((l) => s.departments.find((d) => d.id === l.department_id)?.name)
  const cells = s.cellMembers
    .filter((l) => l.church_membership_id === membershipId)
    .map((l) => {
      const n = s.cells.find((c) => c.id === l.cell_group_id)?.name
      return n ? `Cell: ${n}` : undefined
    })
  return [...depts, ...cells].filter(Boolean).join(', ')
}

function Members({ s }: { s: Store }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [q, setQ] = useState('')
  const list = s.members
    .filter((m) => (m.full_name || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))

  return (
    <>
      <div className="card">
        <h2>Register member</h2>
        <input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button
          className="primary"
          disabled={!name.trim() || !s.churchId}
          onClick={() => {
            addMember(name.trim(), phone.trim())
            setName('')
            setPhone('')
          }}
        >
          Save member
        </button>
        {!s.churchId && <p className="muted">Connect to the internet once to load your church.</p>}
      </div>
      <div className="card">
        <h2>Members ({s.members.length})</h2>
        <input placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.length === 0 && <p className="muted">No members yet.</p>}
        {list.map((m) => (
          <div className="item" key={m.membership_id}>
            <strong>{m.full_name}</strong>
            <div className="muted">{m.phone || 'No phone'}</div>
            {groupsOf(s, m.membership_id) && <div className="muted">{groupsOf(s, m.membership_id)}</div>}
          </div>
        ))}
      </div>
    </>
  )
}

function GroupDetail({
  s,
  kind,
  id,
  onBack,
}: {
  s: Store
  kind: 'dept' | 'cell'
  id: string
  onBack: () => void
}) {
  const [q, setQ] = useState('')
  const group = (kind === 'dept' ? s.departments : s.cells).find((x) => x.id === id)
  const links = kind === 'dept' ? s.deptMembers : s.cellMembers
  const key = kind === 'dept' ? 'department_id' : 'cell_group_id'
  const inGroup = (mid: string) => links.some((l) => l.church_membership_id === mid && l[key] === id)
  const count = links.filter((l) => l[key] === id).length
  const list = s.members
    .filter((m) => (m.full_name || '').toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))

  return (
    <div className="card">
      <div className="between">
        <h2>{group?.name || 'Group'}</h2>
        <button className="small" onClick={onBack}>
          Back
        </button>
      </div>
      <p className="muted">
        {kind === 'dept' ? 'Department' : 'Cell group'} - {count} member{count === 1 ? '' : 's'}
      </p>
      <input placeholder="Search church members" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.map((m) => {
        const on = inGroup(m.membership_id)
        return (
          <div className="item between" key={m.membership_id}>
            <span>{m.full_name}</span>
            <button
              className={`small ${on ? '' : 'primary'}`}
              onClick={() =>
                kind === 'dept'
                  ? setDeptMember(id, m.membership_id, !on)
                  : setCellMember(id, m.membership_id, !on)
              }
            >
              {on ? 'Remove' : 'Add'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function Groups({ s }: { s: Store }) {
  const [open, setOpen] = useState<{ kind: 'dept' | 'cell'; id: string } | null>(null)
  const [typeId, setTypeId] = useState('')
  const [dname, setDname] = useState('')
  const [cname, setCname] = useState('')

  if (open) return <GroupDetail s={s} kind={open.kind} id={open.id} onBack={() => setOpen(null)} />

  const deptName = dname.trim() || s.deptTypes.find((t) => t.id === typeId)?.name || ''

  return (
    <>
      <div className="card">
        <h2>Departments ({s.departments.length})</h2>
        {s.departments.length === 0 && <p className="muted">No departments yet.</p>}
        {s.departments.map((d) => (
          <div className="item between" key={d.id} onClick={() => setOpen({ kind: 'dept', id: d.id })}>
            <strong>{d.name}</strong>
            <span className="muted">
              {s.deptMembers.filter((l) => l.department_id === d.id).length} members &rsaquo;
            </span>
          </div>
        ))}
        <h2 style={{ marginTop: 14 }}>New department</h2>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">Choose type (Youth, Men...)</option>
          {s.deptTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input placeholder="Custom name (optional)" value={dname} onChange={(e) => setDname(e.target.value)} />
        <button
          className="primary"
          disabled={!deptName || !s.churchId}
          onClick={() => {
            addDepartment(deptName, typeId)
            setDname('')
            setTypeId('')
          }}
        >
          Create department
        </button>
      </div>

      <div className="card">
        <h2>Cell groups ({s.cells.length})</h2>
        {s.cells.length === 0 && <p className="muted">No cell groups yet.</p>}
        {s.cells.map((c) => (
          <div className="item between" key={c.id} onClick={() => setOpen({ kind: 'cell', id: c.id })}>
            <strong>{c.name}</strong>
            <span className="muted">
              {s.cellMembers.filter((l) => l.cell_group_id === c.id).length} members &rsaquo;
            </span>
          </div>
        ))}
        <h2 style={{ marginTop: 14 }}>New cell group</h2>
        <input placeholder="Cell name" value={cname} onChange={(e) => setCname(e.target.value)} />
        <button
          className="primary"
          disabled={!cname.trim() || !s.churchId}
          onClick={() => {
            addCell(cname.trim())
            setCname('')
          }}
        >
          Create cell group
        </button>
      </div>
    </>
  )
}

const STATUSES: [string, string][] = [
  ['present', 'Present'],
  ['late', 'Late'],
  ['excused', 'Excused'],
  ['absent', 'Absent'],
]

function Attendance({ s }: { s: Store }) {
  const [eventId, setEventId] = useState('')
  const [title, setTitle] = useState('Sunday Service')
  const [date, setDate] = useState(today())
  const [group, setGroup] = useState('')
  const ev = s.events.find((e) => e.id === eventId) || s.events[0]

  const groupLabel = (e: Row) =>
    e.department_id
      ? s.departments.find((d) => d.id === e.department_id)?.name
      : e.cell_group_id
        ? s.cells.find((c) => c.id === e.cell_group_id)?.name
        : ''

  const roster = !ev
    ? []
    : ev.department_id
      ? s.members.filter((m) =>
          s.deptMembers.some((l) => l.department_id === ev.department_id && l.church_membership_id === m.membership_id),
        )
      : ev.cell_group_id
        ? s.members.filter((m) =>
            s.cellMembers.some((l) => l.cell_group_id === ev.cell_group_id && l.church_membership_id === m.membership_id),
          )
        : s.members

  const statusOf = (pid: string) => s.attendance.find((a) => a.event_id === ev?.id && a.person_id === pid)?.status
  const present = roster.filter((m) => statusOf(m.person_id) === 'present').length

  return (
    <>
      <div className="card">
        <h2>New service / meeting</h2>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Whole church</option>
          {s.departments.map((d) => (
            <option key={d.id} value={`d:${d.id}`}>
              Department: {d.name}
            </option>
          ))}
          {s.cells.map((c) => (
            <option key={c.id} value={`c:${c.id}`}>
              Cell: {c.name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          disabled={!title.trim() || !s.churchId}
          onClick={() => {
            const id = addEvent(title.trim(), date, group)
            if (id) setEventId(id)
          }}
        >
          Create
        </button>
      </div>

      {ev ? (
        <div className="card">
          <h2>Record attendance</h2>
          <select value={ev.id} onChange={(e) => setEventId(e.target.value)}>
            {s.events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
                {groupLabel(e) ? ` (${groupLabel(e)})` : ''} - {e.starts_at.slice(0, 10)}
              </option>
            ))}
          </select>
          <p className="muted">
            {present} present of {roster.length} {groupLabel(ev) ? `in ${groupLabel(ev)}` : 'members'}
          </p>
          {roster.length === 0 && (
            <p className="muted">No members in this group yet. Add them from the Groups tab.</p>
          )}
          {roster.map((m) => (
            <div className="item" key={m.person_id}>
              <strong>{m.full_name}</strong>
              <div className="btns">
                {STATUSES.map(([val, label]) => (
                  <button
                    key={val}
                    className={`${val} ${statusOf(m.person_id) === val ? 'active' : ''}`}
                    onClick={() => markAttendance(ev.id, m.person_id, val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">Create a service above to start recording attendance.</p>
      )}
    </>
  )
}

function App() {
  const s = useStore()
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<'members' | 'groups' | 'attendance'>('members')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess))
    return () => sub.subscription.unsubscribe()
  }, [])

  const uid = session?.user.id

  const doSync = useCallback(async () => {
    if (!uid) return
    if (!navigator.onLine) {
      setMsg('You are offline. Changes are saved on this phone and will sync later.')
      return
    }
    setBusy(true)
    setMsg(await sync(uid))
    setBusy(false)
  }, [uid])

  useEffect(() => {
    if (!uid) return
    if (store.userId !== uid) commit({ ...empty, userId: uid })
    doSync()
    const on = () => {
      setOnline(true)
      doSync()
    }
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [uid, doSync])

  if (!ready) return <p className="muted">Loading...</p>
  if (!session) return <Login />

  return (
    <>
      <div className="between">
        <div>
          <h1>{s.churchName || 'ECMS'}</h1>
          <div className="muted">
            {s.lastSync ? `Last sync ${new Date(s.lastSync).toLocaleString()}` : 'Not synced yet'}
          </div>
        </div>
        <span className={`pill ${online ? 'on' : 'off'}`}>{online ? 'Online' : 'Offline'}</span>
      </div>

      <div className="row">
        <button className="small" disabled={busy} onClick={doSync}>
          {busy ? 'Syncing...' : `Sync (${s.outbox.length} pending)`}
        </button>
        <button
          className="small"
          onClick={() => {
            if (s.outbox.length && !confirm('You have unsynced changes. Sign out anyway?')) return
            supabase.auth.signOut()
          }}
        >
          Sign out
        </button>
      </div>

      {msg && (
        <div className="banner">
          {msg}
          {msg.startsWith('Could not sync') && s.outbox.length > 0 && (
            <button
              className="small"
              style={{ marginTop: 8 }}
              onClick={() => {
                if (!confirm('Discard the change that cannot sync? This cannot be undone.')) return
                commit({ outbox: store.outbox.slice(1) })
                doSync()
              }}
            >
              Discard blocked change
            </button>
          )}
        </div>
      )}

      {tab === 'members' && <Members s={s} />}
      {tab === 'groups' && <Groups s={s} />}
      {tab === 'attendance' && <Attendance s={s} />}

      <nav>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          Members
        </button>
        <button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}>
          Groups
        </button>
        <button className={tab === 'attendance' ? 'active' : ''} onClick={() => setTab('attendance')}>
          Attendance
        </button>
      </nav>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
