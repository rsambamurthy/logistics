// Landing page for emailed links: /verify?token=… and /reset?token=… (password reset or invite).
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input, Loading } from '../components/ui.jsx';
import { Brand } from '../components/Brand.jsx';

export default function AccountLink({ onDone }) {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  const isVerify = location.pathname.startsWith('/verify');
  const isInvite = params.has('invite');
  const [state, setState] = useState({ loading: true });
  const [pw, setPw] = useState({ a: '', b: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const finish = () => { history.replaceState(null, '', '/'); onDone(); };

  useEffect(() => {
    (async () => {
      if (isVerify) {
        try {
          await api.post('/auth/verify', { token });
          setState({ verified: true });
          setTimeout(finish, 1200);
        } catch (e) {
          setState({ error: e.message });
        }
      } else {
        const c = await api.get(`/auth/check?token=${encodeURIComponent(token)}${isInvite ? '&invite=1' : ''}`).catch((e) => ({ ok: false, reason: e.message }));
        setState(c.ok ? { form: true, email: c.email } : { error: c.reason });
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    if (pw.a.length < 8) return setErr('Password must be at least 8 characters');
    if (pw.a !== pw.b) return setErr('The two passwords do not match');
    setBusy(true);
    setErr('');
    try {
      await api.post('/auth/reset', { token, password: pw.a });
      finish();
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-bg">
      <form className="login card" onSubmit={save}>
        <Brand big />
        {state.loading && <Loading />}
        {state.verified && <div className="alert alert-blue">Email confirmed. Signing you in…</div>}
        {state.error && <>
          <div className="alert alert-red">{state.error}</div>
          <Button type="button" variant="ghost" onClick={() => { location.href = '/'; }}>Go to sign in</Button>
        </>}
        {state.form && <>
          <p className="muted">{isInvite ? 'Welcome! Choose a password for' : 'Choose a new password for'} <b>{state.email}</b>.</p>
          <Field label="New password" hint="At least 8 characters"><Input type="password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} required autoFocus /></Field>
          <Field label="Repeat password"><Input type="password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} required /></Field>
          {err && <div className="alert alert-red">{err}</div>}
          <Button busy={busy} type="submit">{isInvite ? 'Set password & sign in' : 'Save & sign in'}</Button>
        </>}
      </form>
    </div>
  );
}
