import { useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input, Select } from '../components/ui.jsx';
import { Brand, PRODUCT } from '../components/Brand.jsx';

export default function Login({ onDone }) {
  const [mode, setMode] = useState(new URLSearchParams(location.search).has('signup') ? 'signup' : 'signin');
  const [f, setF] = useState({ company: '', name: '', email: '', password: '', country: 'IN' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post(signup ? '/signup' : '/login', f);
      onDone();
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
        <Brand big />
        <p className="tagline">{PRODUCT.tagline}</p>
        <p className="muted">{signup ? 'Create your company account. Free 14-day trial, no card needed.' : 'Sign in to continue.'}</p>
        {signup && <>
          <Field label="Company name"><Input value={f.company} onChange={set('company')} required /></Field>
          <Field label="Country"><Select options={[{ value: 'IN', label: 'India' }, { value: 'HK', label: 'Hong Kong' }]} value={f.country} onChange={set('country')} /></Field>
          <Field label="Your name"><Input value={f.name} onChange={set('name')} required /></Field>
        </>}
        <Field label="Work email"><Input type="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label="Password" hint={signup ? 'At least 8 characters' : null}><Input type="password" value={f.password} onChange={set('password')} required /></Field>
        {err && <div className="alert alert-red">{err}</div>}
        <Button busy={busy} type="submit">{signup ? 'Start free trial' : 'Sign in'}</Button>
        <div className="small muted center">
          {signup ? <>Already have an account? <button type="button" className="link" onClick={() => setMode('signin')}>Sign in</button></>
            : <>New company? <button type="button" className="link" onClick={() => setMode('signup')}>Start a free trial</button></>}
        </div>
      </form>
    </div>
  );
}
