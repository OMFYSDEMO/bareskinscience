/**
 * bare Skinscience — Cloudflare Pages "advanced mode" worker.
 * Serves the static site and handles the forms at /api/enquiry.
 * Works with dashboard drag-and-drop uploads (unlike a functions/ folder).
 *
 * /api/enquiry
 *
 * POST  : saves a clinic enquiry or launch-list sign-up.
 * GET   : /api/enquiry?key=YOUR_ADMIN_KEY  -> downloads all entries as CSV.
 *
 * Bindings / variables (Pages project → Settings):
 *   ENQUIRIES   KV namespace binding (required to store entries)
 *   ADMIN_KEY   secret text, needed for the CSV download
 *   WEBHOOK_URL optional — every entry is also POSTed here as JSON
 *               (e.g. your ERP's lead endpoint, Zapier/Make, Google Apps Script)
 *
 * Email notification of every enquiry (Cloudflare Email Service REST API):
 *   CF_ACCOUNT_ID   your Cloudflare account ID (plain variable)
 *   CF_EMAIL_TOKEN  API token with Email Sending permission (secret)
 *   NOTIFY_TO       optional, default febinnajinsha10@gmail.com (the inbox hello@ forwards to)
 *   MAIL_FROM       optional, default website@bareskinscience.in
 */

const FIELDS = ['type', 'clinic', 'name', 'role', 'city', 'phone', 'email', 'message', 'page'];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });


const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABELS = { clinic: 'Clinic', name: 'Name', role: 'Role', city: 'City', phone: 'Phone', email: 'Email', message: 'Message', country: 'Country', at: 'Received (UTC)' };

async function notify(env, entry) {
  if (!env.CF_ACCOUNT_ID || !env.CF_EMAIL_TOKEN) return false;
  const isClinic = entry.type === 'clinic';
  const subject = isClinic
    ? `Clinic partner enquiry — ${entry.clinic} (${entry.city})`
    : `New launch-list sign-up — ${entry.email}`;
  const rows = Object.keys(LABELS).filter(k => entry[k]);
  const text = `${subject}\n\n` + rows.map(k => `${LABELS[k]}: ${entry[k]}`).join('\n') + '\n\nSent from www.bareskinscience.in';
  const html = `<div style="font-family:Arial,sans-serif;color:#27200F;max-width:560px">
    <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5F6B4E;margin:0 0 6px">bare Skinscience · website</p>
    <h2 style="margin:0 0 16px;font-weight:600">${esc(subject)}</h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${rows.map(k =>
      `<tr><td style="padding:8px 12px 8px 0;border-bottom:1px solid #eee;color:#6b6457;width:130px;vertical-align:top">${LABELS[k]}</td><td style="padding:8px 0;border-bottom:1px solid #eee;white-space:pre-wrap">${esc(entry[k])}</td></tr>`).join('')}</table>
    <p style="font-size:12px;color:#6b6457;margin-top:18px">Reply to this email to answer ${esc(entry.name || entry.email)} directly.</p></div>`;
  const body = {
    to: env.NOTIFY_TO || 'febinnajinsha10@gmail.com',
    from: env.MAIL_FROM || 'website@bareskinscience.in',
    subject, text, html,
    replyTo: entry.email
  };
  const send = b => fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(b)
  }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
  let res = await send(body);
  if (!res.ok || res.data.success === false) {
    // Retry without reply-to in case the API rejects that field.
    const { replyTo, ...plain } = body;
    res = await send(plain);
  }
  if (!res.ok || res.data.success === false) console.log('Email send failed', JSON.stringify(res.data.errors || res.data));
  return res.ok && res.data.success !== false;
}

async function onRequestPost({ request, env }) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  // Honeypot: bots fill hidden fields. Pretend success.
  if (data.company_website) return json({ ok: true });

  const entry = { id: crypto.randomUUID(), at: new Date().toISOString() };
  for (const f of FIELDS) entry[f] = String(data[f] ?? '').trim().slice(0, f === 'message' ? 2000 : 200);

  if (!['clinic', 'waitlist'].includes(entry.type)) return json({ ok: false, error: 'Unknown form' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(entry.email)) return json({ ok: false, error: 'Invalid email' }, 400);
  if (entry.type === 'clinic' && (!entry.clinic || !entry.name || !entry.phone || !entry.city))
    return json({ ok: false, error: 'Missing fields' }, 400);

  entry.country = request.cf?.country || '';

  let stored = false;
  if (env.ENQUIRIES) {
    await env.ENQUIRIES.put(`${entry.type}:${entry.at}:${entry.id}`, JSON.stringify(entry));
    stored = true;
  }
  if (env.WEBHOOK_URL) {
    try {
      await fetch(env.WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
      stored = true;
    } catch { /* keep KV copy */ }
  }
  try { if (await notify(env, entry)) stored = true; } catch (e) { console.log('Email error', String(e)); }
  if (!stored) return json({ ok: false, error: 'Storage not configured' }, 503);
  return json({ ok: true });
}

async function onRequestGet({ request, env }) {
  const key = new URL(request.url).searchParams.get('key');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response('Not found', { status: 404 });
  if (!env.ENQUIRIES) return new Response('KV not bound', { status: 500 });

  const rows = [];
  let cursor;
  do {
    const page = await env.ENQUIRIES.list({ cursor });
    for (const k of page.keys) {
      const v = await env.ENQUIRIES.get(k.name);
      if (v) rows.push(JSON.parse(v));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  rows.sort((a, b) => a.at.localeCompare(b.at));
  const cols = ['at', ...FIELDS, 'country', 'id'];
  // Quote every cell; neutralise spreadsheet formulas (=, +, -, @) typed into the form.
  const esc = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bare-enquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store'
    }
  });
}

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self' mailto:; frame-ancestors 'none'; base-uri 'self'"
};
function secure(res) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) if (!r.headers.has(k)) r.headers.set(k, v);
  return r;
}

// The Pages build publishes the whole repository, which also holds the bare Ops app's source in platform/
// (deployed separately, at ops.bareskinscience.in). Only the website's own files are ever served from here.
const PUBLIC_FILES = new Set(['/', '/index.html', '/style.css', '/main.js', '/favicon.svg', '/apple-touch-icon.png', '/og-image.png', '/robots.txt', '/sitemap.xml']);
const PUBLIC_DIRS = ['/assets/', '/fonts/'];
const isPublic = p => PUBLIC_FILES.has(p) || PUBLIC_DIRS.some(d => p.startsWith(d) && !p.includes('/.'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!isPublic(url.pathname) && url.pathname !== '/api/enquiry') {
      return secure(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
    if (url.pathname === '/api/enquiry') {
      try {
        if (request.method === 'POST') return secure(await onRequestPost({ request, env }));
        if (request.method === 'GET') return secure(await onRequestGet({ request, env }));
        return secure(new Response('Method not allowed', { status: 405, headers: { allow: 'GET, POST' } }));
      } catch (e) {
        return secure(json({ ok: false, error: 'Server error' }, 500));
      }
    }
    return secure(await env.ASSETS.fetch(request));
  }
};
