// Side effects that reach the outside world (sending email, reading real mailboxes, paid tracking / AI calls,
// background jobs) run only in production. Test copies of Quayly (Railway forks, staging) are safe by default.
// Override with SIDE_EFFECTS=on or SIDE_EFFECTS=off.
export function liveSideEffects() {
  const flag = String(process.env.SIDE_EFFECTS || '').toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  const env = process.env.RAILWAY_ENVIRONMENT_NAME;
  return !env || env === 'production';
}
