import { useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input, Select } from '../components/ui.jsx';
import { Brand, PRODUCT } from '../components/Brand.jsx';

/** Sign in, sign up, forgot password and "check your email" screens. */
export default function Login({ onDone }) {
  const [mode, setMode] = useState(new URLSearchParams(location.search).has('signup') ? 'signup' : 'signin');
  const [f, setF] = useState({ company: '', name: '', email: '', password: '', country: 'IN' });
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const go = (m) => { setMode(m); setErr(''); setNote(''); setUnverified(false); };

  const run = async (fn) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr(x.message);
      if (x.status === 403 && /confirm your email/i.test(x.message)) setUnverified(true);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    if (mode === 'signin') return run(async () => { await api.post('/login', f); onDone(); });
    if (mode === 'signup') return run(async () => { await api.post('/signup', f); setMode('sent'); setNote(`We've sent a confirmation link to ${f.email}. Open it to activate your account.`); });
    if (mode === 'forgot') return run(async () => { await api.post('/auth/forgot', { email: f.email }); setMode('sent'); setNote(`If ${f.email} has a Quayly account, a password reset link is on its way. It is valid for 1 hour.`); });
  };
  const resend = () => run(async () => { await api.post('/auth/resend-verification', { email: f.email }); setUnverified(false); setNote('A new confirmation link has been sent.'); });

  return (
    <div className="login-bg">
      <form className="login card" onSubmit={submit}>
        <Brand big />
        <p className="tagline">{PRODUCT.tagline}</p>
        {mode === 'sent' ? (
          <>
            <div className="alert alert-blue">{note}</div>
            <p className="small muted">Didn't get it? Check spam, or wait a minute and try again.</p>
            <Button type="button" variant="ghost" onClick={() => go('signin')}>Back to sign in</Button>
          </>
        ) : (
          <>
            <p className="muted">{mode === 'signup' ? 'Create your company account. Free 14-day trial, no card needed.' : mode === 'forgot' ? "Enter your email and we'll send you a link to set a new password." : 'Sign in to continue.'}</p>
            {mode === 'signup' && <>
              <Field label="Company name"><Input value={f.company} onChange={set('company')} required /></Field>
              <Field label="Country"><Select options={[{ value: 'IN', label: 'India' }, { value: 'HK', label: 'Hong Kong' }]} value={f.country} onChange={set('country')} /></Field>
              <Field label="Your name"><Input value={f.name} onChange={set('name')} required /></Field>
            </>}
            <Field label="Work email"><Input type="email" value={f.email} onChange={set('email')} required /></Field>
            {mode !== 'forgot' && <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters' : null}><Input type="password" value={f.password} onChange={set('password')} required /></Field>}
            {mode === 'signin' && <div className="small right"><button type="button" className="link" onClick={() => go('forgot')}>Forgot password?</button></div>}
            {note && <div className="alert alert-blue">{note}</div>}
            {err && <div className="alert alert-red">{err}{unverified && <> <button type="button" className="link" onClick={resend}>Resend the link</button></>}</div>}
            <Button busy={busy} type="submit">{mode === 'signup' ? 'Start free trial' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}</Button>
            <div className="small muted center">
              {mode === 'signin'
                ? <>New company? <button type="button" className="link" onClick={() => go('signup')}>Start a free trial</button></>
                : <>Already have an account? <button type="button" className="link" onClick={() => go('signin')}>Sign in</button></>}
            </div>
          </>
        )}
      </form>
    </div>
  );
}
