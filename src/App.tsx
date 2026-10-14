import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Session } from '@supabase/supabase-js'
import {
  supabase,
  store,
  commit,
  useStore,
  empty,
  today,
  sync,
  addMember,
  addDepartment,
  addCell,
  setDeptMember,
  setCellMember,
  addEvent,
  markAttendance,
} from './store'
import type { Row, Store } from './store'
import { Roles, Audit, SyncCenter } from './admin'

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

function More({ s, onOpen }: { s: Store; onOpen: (k: 'roles' | 'audit' | 'sync') => void }) {
  const can = (p: string) => s.perms.includes(p)
  return (
    <div className="card">
      <h2>More</h2>
      <div className="item between" onClick={() => onOpen('sync')}>
        <strong>Sync center</strong>
        <span className="muted">{s.outbox.length} pending &rsaquo;</span>
      </div>
      {can('roles.assign') && (
        <div className="item between" onClick={() => onOpen('roles')}>
          <strong>Roles and access</strong>
          <span className="muted">&rsaquo;</span>
        </div>
      )}
      {can('audit.read') && (
        <div className="item between" onClick={() => onOpen('audit')}>
          <strong>Audit log</strong>
          <span className="muted">&rsaquo;</span>
        </div>
      )}
    </div>
  )
}

function App() {
  const s = useStore()
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [tab, setTab] = useState<'members' | 'groups' | 'attendance' | 'more'>('members')
  const [sub, setSub] = useState<null | 'roles' | 'audit' | 'sync'>(null)
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
    const err = await sync(uid)
    setMsg(err)
    commit({ lastError: err || undefined })
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
      {tab === 'more' &&
        (sub === null ? (
          <More s={s} onOpen={setSub} />
        ) : (
          <>
            <button className="small" onClick={() => setSub(null)}>
              &lsaquo; Back
            </button>
            {sub === 'roles' && <Roles s={s} online={online} onChanged={doSync} />}
            {sub === 'audit' && <Audit s={s} online={online} />}
            {sub === 'sync' && <SyncCenter s={s} online={online} busy={busy} onSync={doSync} />}
          </>
        ))}

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
        <button
          className={tab === 'more' ? 'active' : ''}
          onClick={() => {
            setTab('more')
            setSub(null)
          }}
        >
          More
        </button>
      </nav>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
