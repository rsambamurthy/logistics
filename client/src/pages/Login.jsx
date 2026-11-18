import { useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input } from '../components/ui.jsx';

export default function Login({ setup, onDone }) {
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post(setup ? '/setup' : '/login', f);
      onDone(r.user);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login-bg">
      <form className="login card" onSubmit={submit}>
        <div className="brand big"><span className="logo">AQ</span> AgentQuote</div>
        <p className="muted">{setup ? 'First-time setup: create the admin account.' : 'Sign in to continue.'}</p>
        {setup && <Field label="Your name"><Input value={f.name} onChange={set('name')} required /></Field>}
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label="Password" hint={setup ? 'At least 8 characters' : null}><Input type="password" value={f.password} onChange={set('password')} required /></Field>
        {err && <div className="alert alert-red">{err}</div>}
        <Button busy={busy} type="submit">{setup ? 'Create admin & sign in' : 'Sign in'}</Button>
      </form>
    </div>
  );
}
