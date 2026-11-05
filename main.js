/* bare Skinscience — site script */

/* ==== EDIT THESE BEFORE GOING LIVE ==================================
   Leave a value empty ('') to hide it. The forms post to /api/enquiry
   (Cloudflare Pages Function). If that isn't set up yet and an email
   is given here, the forms fall back to opening the visitor's email app. */
const CONFIG = {
  email: 'hello@bareskinscience.in',
  whatsapp: '',         // international format, digits only, e.g. '919800000000'
  instagram: '',        // full URL, e.g. 'https://instagram.com/yourhandle'
  clinicPortalUrl: ''   // link to the clinic ordering portal (the ERP), when live
};
/* =================================================================== */

document.documentElement.classList.remove('no-js');
document.getElementById('yr').textContent = new Date().getFullYear();

/* ---- Tubes (decorative product illustrations) ---- */
let tubeId = 0;
function tubeSVG(el) {
  const dark = el.classList.contains('t-dark');
  const id = 'g' + (tubeId++);
  const body = dark ? '#27200F' : '#FFFDF5';
  const edge = dark ? '#1a1509' : '#e4dece';
  const fg = dark ? '#FFFDF5' : '#27200F';
  const acc = dark ? '#A7B392' : '#5F6B4E';
  const cap = dark ? '#000' : '#27200F';
  const logo = dark ? 'assets/logo-cream.svg' : 'assets/logo-brown.svg';
  const no = el.dataset.no, name = el.dataset.name, pair = (el.dataset.pair || '').toUpperCase();
  el.innerHTML =
`<svg viewBox="0 0 60 262" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="${id}" x1="0" x2="1">
    <stop offset="0" stop-color="#000" stop-opacity="${dark ? .25 : .07}"/>
    <stop offset=".22" stop-color="#fff" stop-opacity="${dark ? .07 : .5}"/>
    <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
    <stop offset="1" stop-color="#000" stop-opacity="${dark ? .3 : .1}"/>
  </linearGradient></defs>
  <rect x="17" y="232" width="26" height="26" rx="3" fill="${cap}"/>
  <rect x="15" y="229" width="30" height="6" rx="1.5" fill="${cap}"/>
  <path d="M5 18 H55 L53 224 Q53 231 46 231 H14 Q7 231 7 224 Z" fill="${body}"/>
  <path d="M5 18 H55 L53 224 Q53 231 46 231 H14 Q7 231 7 224 Z" fill="url(#${id})"/>
  <rect x="4" y="5" width="52" height="15" fill="${edge}"/>
  <g stroke="${dark ? '#2f2714' : '#d6cfbc'}" stroke-width=".5">${[8, 11, 14, 17].map(y => `<line x1="4" x2="56" y1="${y}" y2="${y}"/>`).join('')}</g>
  <text x="30" y="46" text-anchor="middle" font-family="Lexend Deca, sans-serif" font-size="5" font-weight="600" letter-spacing=".6" fill="${fg}">No. ${no}</text>
  <circle cx="30" cy="54" r="1.9" fill="${acc}"/>
  <image href="${logo}" x="6" y="105" width="48" height="22" transform="rotate(-90 30 116)"/>
  <text transform="translate(17.5 206) rotate(-90)" font-family="Lexend Deca, sans-serif" font-size="4.4" font-weight="500" fill="${fg}">${name}</text>
  <text transform="translate(47.5 206) rotate(-90)" font-family="Lexend Deca, sans-serif" font-size="2.5" font-weight="600" letter-spacing=".45" fill="${acc}">${pair}</text>
  <text x="30" y="219" text-anchor="middle" font-family="Lexend Deca, sans-serif" font-size="3.6" fill="${fg}">50 ml</text>
</svg>`;
}
document.querySelectorAll('.tube').forEach(tubeSVG);

/* ---- Nav ---- */
const nav = document.querySelector('.nav');
const menu = document.querySelector('.menu');
const links = document.getElementById('navlinks');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', open);
  menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  links.classList.toggle('open', open);
});
links.addEventListener('click', e => {
  if (e.target.tagName === 'A') { menu.setAttribute('aria-expanded', 'false'); links.classList.remove('open'); }
});

/* ---- Reveal on scroll ---- */
const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
}, { rootMargin: '0px 0px -8% 0px', threshold: .08 }) : null;
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = (i % 4) * 70 + 'ms';
  io ? io.observe(el) : el.classList.add('in');
});

/* ---- Contact details from CONFIG ---- */
(function contact() {
  const box = document.querySelector('.contact');
  let any = false;
  const set = (sel, href, text) => {
    const a = box.querySelector(sel);
    if (!href) { a.remove(); return; }
    a.href = href; if (text) a.textContent = text; any = true;
  };
  set('.c-email', CONFIG.email && 'mailto:' + CONFIG.email, CONFIG.email);
  set('.c-wa', CONFIG.whatsapp && 'https://wa.me/' + CONFIG.whatsapp, CONFIG.whatsapp && 'WhatsApp');
  set('.c-ig', CONFIG.instagram, null);
  box.hidden = !any;
  if (CONFIG.clinicPortalUrl) {
    document.querySelectorAll('a').forEach(a => {
      if (a.textContent.startsWith('Clinic portal')) { a.href = CONFIG.clinicPortalUrl; a.textContent = 'Clinic portal'; }
    });
  }
})();

/* ---- Forms ---- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validate(form) {
  let ok = true;
  form.querySelectorAll('[required]').forEach(f => {
    const bad = !f.value.trim() || (f.type === 'email' && !EMAIL_RE.test(f.value.trim()));
    f.classList.toggle('invalid', bad);
    f.setAttribute('aria-invalid', bad);
    if (bad && ok) { f.focus(); ok = false; }
  });
  return ok;
}
function mailtoFallback(type, data) {
  if (!CONFIG.email) return false;
  const subject = type === 'clinic' ? `Clinic partner enquiry — ${data.clinic || ''}` : 'Launch list sign-up';
  const body = Object.entries(data).filter(([k, v]) => v && k !== 'type').map(([k, v]) => `${k}: ${v}`).join('\n');
  location.href = `mailto:${CONFIG.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return true;
}
document.querySelectorAll('form[data-type]').forEach(form => {
  const status = form.querySelector('.status');
  const btn = form.querySelector('button[type=submit]');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    status.className = 'status'; status.textContent = '';
    if (!validate(form)) { status.className = 'status err'; status.textContent = 'Please check the highlighted fields.'; return; }
    const data = Object.fromEntries(new FormData(form).entries());
    data.type = form.dataset.type;
    data.page = location.href;
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/enquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error(r.status);
      form.reset();
      status.className = 'status ok';
      status.textContent = data.type === 'clinic'
        ? 'Thank you. We\'ll be in touch within two working days.'
        : 'You\'re on the list. We\'ll write when bare arrives near you.';
    } catch (err) {
      if (mailtoFallback(data.type, data)) {
        status.className = 'status ok'; status.textContent = 'Opening your email app to send this to us…';
      } else {
        status.className = 'status err'; status.textContent = 'Sorry, that didn\'t go through. Please try again in a moment.';
      }
    } finally { btn.disabled = false; btn.textContent = label; }
  });
  form.addEventListener('input', e => { if (e.target.classList.contains('invalid')) { e.target.classList.remove('invalid'); e.target.removeAttribute('aria-invalid'); } });
});
