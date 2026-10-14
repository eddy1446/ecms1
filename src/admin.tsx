import { useEffect, useState } from 'react'
import { supabase, commit, store } from './store'
import type { Row, Store } from './store'

const SCOPE_ORDER: Record<string, number> = { ministry: 0, church: 1, department: 2, cell: 3 }

function scopeLabel(s: Store, scopeType: string, scopeId: string): string {
  if (scopeType === 'ministry') return 'Whole ministry'
  if (scopeType === 'church') return s.churchName || 'Church'
  if (scopeType === 'department') return `Department: ${s.departments.find((d) => d.id === scopeId)?.name ?? '?'}`
  return `Cell: ${s.cells.find((c) => c.id === scopeId)?.name ?? '?'}`
}

/* ------------------------------------------------------------------ */
/* Roles & access                                                      */
/* ------------------------------------------------------------------ */
export function Roles({ s, online, onChanged }: { s: Store; online: boolean; onChanged: () => void }) {
  const [personId, setPersonId] = useState('')
  const [roleCode, setRoleCode] = useState('')
  const [scopeId, setScopeId] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const person = s.members.find((m) => m.person_id === personId)
  const role = s.roles.find((r) => r.code === roleCode)
  const roles = [...s.roles].sort(
    (a, b) => SCOPE_ORDER[a.scope_type] - SCOPE_ORDER[b.scope_type] || a.name.localeCompare(b.name),
  )

  const scopeOptions: { id: string; label: string }[] = !role
    ? []
    : role.scope_type === 'ministry'
      ? s.ministryId
        ? [{ id: s.ministryId, label: 'Whole ministry' }]
        : []
      : role.scope_type === 'church'
        ? s.churchId
          ? [{ id: s.churchId, label: s.churchName || 'This church' }]
          : []
        : role.scope_type === 'department'
          ? s.departments.map((d) => ({ id: d.id, label: d.name }))
          : s.cells.map((c) => ({ id: c.id, label: c.name }))

  const effectiveScope = scopeOptions.some((o) => o.id === scopeId)
    ? scopeId
    : scopeOptions.length === 1
      ? scopeOptions[0].id
      : ''
  const scopeText = scopeOptions.find((o) => o.id === effectiveScope)?.label

  async function run(fn: () => PromiseLike<any>, okText: string) {
    if (!online) {
      setMsg('Role changes need an internet connection.')
      return
    }
    setBusy(true)
    setMsg(null)
    const { error } = await fn()
    setBusy(false)
    if (error) setMsg(error.message)
    else {
      setMsg(okText)
      onChanged()
    }
  }

  const active = s.assignments.filter((a) => !a.ends_at || new Date(a.ends_at) > new Date())
  const byPerson = new Map<string, Row[]>()
  active.forEach((a) => byPerson.set(a.person_id, [...(byPerson.get(a.person_id) || []), a]))
  const nameOf = (pid: string) => s.members.find((m) => m.person_id === pid)?.full_name || 'Person (other church)'

  return (
    <>
      <div className="card">
        <h2>Give a role</h2>
        <p className="muted">Roles always apply to one place, such as the Youth department only.</p>

        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Choose a member</option>
          {[...s.members]
            .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))
            .map((m) => (
              <option key={m.person_id} value={m.person_id}>
                {m.full_name}
                {m.has_login ? '' : ' (no login yet)'}
              </option>
            ))}
        </select>

        {person && !person.has_login && (
          <div className="banner">
            {person.full_name} has no login. Ask them to open the app and tap Create account, then enter the same
            email here.
            <input
              type="email"
              placeholder="Their email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              className="small"
              disabled={busy || !email.trim()}
              onClick={() =>
                run(
                  () => supabase.rpc('link_member_login', { p_person: personId, p_email: email.trim() }),
                  'Login linked. They can now sign in and sync.',
                )
              }
            >
              Link login
            </button>
          </div>
        )}

        <select
          value={roleCode}
          onChange={(e) => {
            setRoleCode(e.target.value)
            setScopeId('')
          }}
        >
          <option value="">Choose a role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.code}>
              {r.name} ({r.scope_type})
            </option>
          ))}
        </select>

        {role && scopeOptions.length > 1 && (
          <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            <option value="">Choose the {role.scope_type}</option>
            {scopeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {role && scopeOptions.length === 0 && (
          <p className="muted">No {role.scope_type}s exist yet. Create one in the Groups tab first.</p>
        )}

        <label className="muted">Ends on (optional, for acting roles)</label>
        <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />

        {person && role && scopeText && (
          <p>
            <strong>{person.full_name}</strong> will be <strong>{role.name}</strong> for <strong>{scopeText}</strong>
            {endsOn ? ` until ${endsOn}` : ''}.
          </p>
        )}

        <button
          className="primary"
          disabled={busy || !personId || !role || !effectiveScope}
          onClick={() =>
            run(
              () =>
                supabase.rpc('assign_role', {
                  p_person: personId,
                  p_role_code: roleCode,
                  p_scope_type: role!.scope_type,
                  p_scope_id: effectiveScope,
                  p_ends_at: endsOn ? new Date(endsOn + 'T23:59:59').toISOString() : null,
                }),
              'Role assigned.',
            )
          }
        >
          {busy ? 'Working...' : 'Assign role'}
        </button>
        {msg && <div className="banner">{msg}</div>}
      </div>

      <div className="card">
        <h2>Current roles</h2>
        {byPerson.size === 0 && <p className="muted">No roles to show yet.</p>}
        {[...byPerson.entries()].map(([pid, list]) => (
          <div className="item" key={pid}>
            <strong>{nameOf(pid)}</strong>
            {list.map((a) => (
              <div className="between" key={a.id} style={{ marginTop: 6 }}>
                <span className="muted">
                  {s.roles.find((r) => r.id === a.role_id)?.name} - {scopeLabel(s, a.scope_type, a.scope_id)}
                  {a.ends_at ? ` (until ${a.ends_at.slice(0, 10)})` : ''}
                </span>
                <button
                  className="small"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('Revoke this role?')) run(() => supabase.rpc('revoke_role', { p_assignment: a.id }), 'Role revoked.')
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */
const ENTITY: Record<string, string> = {
  people: 'person',
  church_memberships: 'church membership',
  department_memberships: 'department membership',
  cell_memberships: 'cell membership',
  departments: 'department',
  cell_groups: 'cell group',
  churches: 'church',
  events: 'event',
  attendance: 'attendance',
  role_assignments: 'role',
}
const SKIP = new Set(['id', 'created_at', 'updated_at', 'version', 'deleted_at', 'origin_device_id', 'created_by'])
const show = (v: any) => (v === null || v === undefined ? 'none' : String(v).slice(0, 40))

function describe(r: Row, s: Store): string {
  const d = r.new_data || r.old_data || {}
  const personName = d.person_id ? s.members.find((m) => m.person_id === d.person_id)?.full_name : undefined
  if (r.entity === 'role_assignments') {
    return `${s.roles.find((x) => x.id === d.role_id)?.name ?? 'role'} for ${personName ?? 'a person'}`
  }
  return d.full_name || d.name || d.title || (personName ? `${personName}` : '') || ''
}

function changes(r: Row): string {
  if (r.action !== 'update' || !r.old_data || !r.new_data) return ''
  return Object.keys(r.new_data)
    .filter((k) => !SKIP.has(k) && JSON.stringify(r.new_data[k]) !== JSON.stringify(r.old_data[k]))
    .map((k) => `${k.replace(/_/g, ' ')}: ${show(r.old_data[k])} -> ${show(r.new_data[k])}`)
    .join('; ')
}

export function Audit({ s, online }: { s: Store; online: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  async function load() {
    if (!online) {
      setErr('The audit log needs an internet connection.')
      return
    }
    setErr('')
    const { data, error } = await supabase
      .from('audit_log')
      .select('id,at,actor_name,action,entity,old_data,new_data')
      .order('at', { ascending: false })
      .limit(150)
    if (error) setErr(error.message)
    else setRows(data)
  }

  useEffect(() => {
    load()
  }, [online])

  const lines = (rows || []).map((r) => ({
    r,
    text: `${r.actor_name || 'System'} ${r.action} ${ENTITY[r.entity] || r.entity} ${describe(r, s)}`.trim(),
    diff: changes(r),
  }))
  const shown = lines.filter((l) => (l.text + ' ' + l.diff).toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="card">
      <div className="between">
        <h2>Audit log</h2>
        <button className="small" onClick={load}>
          Refresh
        </button>
      </div>
      <input placeholder="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <div className="banner">{err}</div>}
      {rows && shown.length === 0 && <p className="muted">Nothing to show.</p>}
      {shown.map(({ r, text, diff }) => (
        <div className="item" key={r.id}>
          <div>{text}</div>
          {diff && <div className="muted">{diff}</div>}
          <div className="muted">{new Date(r.at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sync center                                                         */
/* ------------------------------------------------------------------ */
export function SyncCenter({
  s,
  online,
  busy,
  onSync,
}: {
  s: Store
  online: boolean
  busy: boolean
  onSync: () => void
}) {
  const summary = (op: Row) =>
    op.row.full_name || op.row.title || op.row.name || op.row.status || (op.row.deleted_at ? 'removal' : '')

  return (
    <>
      <div className="card">
        <h2>Sync status</h2>
        <p className={online ? 'on' : 'off'}>{online ? 'Online' : 'Offline'}</p>
        <p className="muted">
          Last sync: {s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'}
          <br />
          Pending changes: {s.outbox.length}
        </p>
        {s.lastError && <div className="banner">{s.lastError}</div>}
        <button className="primary" disabled={busy || !online} onClick={onSync}>
          {busy ? 'Syncing...' : 'Sync now'}
        </button>
      </div>

      <div className="card">
        <h2>Waiting to upload ({s.outbox.length})</h2>
        {s.outbox.length === 0 && <p className="muted">Everything is synced.</p>}
        {s.outbox.map((op, i) => (
          <div className="item between" key={i}>
            <div>
              <strong>{op.table.replace(/_/g, ' ')}</strong>
              <div className="muted">{summary(op)}</div>
            </div>
            <button
              className="small"
              onClick={() => {
                if (confirm('Discard this change? It will not be uploaded.')) {
                  commit({ outbox: store.outbox.filter((_, j) => j !== i) })
                }
              }}
            >
              Discard
            </button>
          </div>
        ))}
      </div>
    </>
  )
                                             }
