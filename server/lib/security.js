// Browser security headers and safe file downloads.

/** Headers on every response. The CSP allows only Quayly's own scripts; map tiles and data: images for logos. */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
}

// Shown in the browser: documents and pictures that cannot run code. Anything else is downloaded.
const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)$/i;

/** Send a stored file (attachment, job document) without letting it run inside Quayly. */
export function sendStoredFile(res, { filename, content_type, data }) {
  const type = String(content_type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const inline = INLINE.test(type);
  const name = String(filename || 'file').replace(/[\r\n"\\]/g, '').slice(0, 200);
  res.setHeader('Content-Type', inline ? type : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; plugin-types application/pdf");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(data);
}
