// Pick one or more roles for a user. Someone with several roles gets everything any of them allows.
export default function RolePicker({ roles = [], value = [], onChange, disabled }) {
  const flip = (key) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <div className="check-list">
      {roles.map((r) => (
        <label key={r.key} className="check-item">
          <input type="checkbox" disabled={disabled} checked={value.includes(r.key)} onChange={() => flip(r.key)} />
          <span><strong>{r.name}</strong>{r.description && <span className="muted small block">{r.description}</span>}</span>
        </label>
      ))}
    </div>
  );
}

/** A user's roles as small pills. */
export function RolePills({ keys = [], roles = [] }) {
  const name = (k) => roles.find((r) => r.key === k)?.name || k;
  return <div className="role-pills">{keys.map((k) => <span key={k} className="perm-chip">{name(k)}</span>)}</div>;
}
