// Shared site chrome for sub-pages (auth, account): injects the same navbar +
// footer as the homepage and wires theme toggle, the signed-in account chip,
// the dropdown, sign out, and the activity-status dot. Single source so the
// sub-pages can't drift from each other.
const SUPABASE_AUTH_KEY = 'sb-pntxlvhkqfryyyxlqytr-auth-token';
const AVATAR_PALETTE = ['#0891B2','#BE185D','#4F46E5','#047857','#B45309','#6D28D9','#DC2626','#0369A1','#DB2777','#059669','#7C3AED','#EA580C'];
const STATUS_COLORS = { online: '#23a55a', idle: '#f0b232', dnd: '#f23f43', offline: '#80848e' };

function djb2(seed) { let h = 0; seed = seed || ''; for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; } return Math.abs(h); }
function avatarColor(seed) { return AVATAR_PALETTE[djb2(seed) % AVATAR_PALETTE.length]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const ICON_THEME =
  '<svg data-theme-icon="cream" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
  '<svg data-theme-icon="ink" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M12 3a6.4 6.4 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const ICON_CARET = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px;"><polyline points="6 9 12 15 18 9"/></svg>';
const ICON_USER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>';
const ICON_APP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>';
const ICON_OUT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

// ── Theme (shared via localStorage with the homepage) ──
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  // Every page's pre-paint <head> script writes the theme colour as an INLINE
  // style on <html> (so the first frame isn't the wrong colour). An inline
  // style beats chrome.css's `html { background: var(--bg-page) }`, so without
  // re-writing it here the page keeps the old theme's backdrop and the toggle
  // looks like it did nothing wherever the body doesn't cover the viewport.
  document.documentElement.style.backgroundColor = t === 'cream' ? '#F5F2EA' : '#0F172A';
  const root = document.getElementById('dv-root');
  if (root) root.setAttribute('data-theme', t);
  document.querySelectorAll('[data-theme-icon]').forEach((el) => {
    el.style.display = el.getAttribute('data-theme-icon') === (t === 'cream' ? 'ink' : 'cream') ? '' : 'none';
  });
  try { localStorage.setItem('docvex.site.theme', t); } catch (e) {}
}
function currentTheme() {
  try { return localStorage.getItem('docvex.site.theme') || 'ink'; } catch (e) { return 'ink'; }
}

// ── Session read (same logic as the homepage chip) ──
function readUser() {
  let raw; try { raw = localStorage.getItem(SUPABASE_AUTH_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let parsed; try { parsed = JSON.parse(raw); } catch (e) { return null; }
  const session = parsed && parsed.currentSession ? parsed.currentSession : parsed;
  const user = (session && session.user) || (parsed && parsed.user);
  if (!user) return null;
  const exp = session && session.expires_at;
  if (exp && !(session.refresh_token) && (exp * 1000) < Date.now()) return null;
  return user;
}

var ICON_ARROW = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg>';

// Same navbar as the homepage (the "main tab"): round logo + DOCVEX wordmark,
// the homepage's link set (section anchors resolve back to index.html), theme
// toggle, and Sign in + Get Started (or the signed-in account chip).
function navbarHTML() {
  return (
    '<header class="dvx-header"><div class="dvx-header-inner">' +
      '<a class="dvx-logo" href="index.html">' +
        '<span class="dvx-logo-ring dvx-logo-app"><img src="assets/appicon.png" alt="DocVex"></span>' +
        '<span class="dvx-logo-word">DOCVEX</span>' +
      '</a>' +
      '<nav class="dvx-nav">' +
        '<a href="index.html">Home</a>' +
        '<a href="company.html">Company</a>' +
        '<a href="legal.html">Legal</a>' +
        '<a href="installers.html">Download</a>' +
      '</nav>' +
      '<div class="dvx-actions">' +
        '<button type="button" class="dvx-theme" id="dvxTheme" title="Toggle theme" aria-label="Toggle theme">' + ICON_THEME + '</button>' +
        '<span id="dvxAuthButtons" style="display:contents;">' +
          '<a class="dvx-signin" href="auth.html?mode=signin">Sign in</a>' +
          '<a class="dvx-signup" href="auth.html?mode=signup">Get Started<span class="dvx-signup-arrow">' + ICON_ARROW + '</span></a>' +
        '</span>' +
        '<div class="dvx-chip" id="dvxChip" hidden>' +
          '<button class="dvx-chip-trigger" id="dvxChipTrigger" type="button" title="Account">' +
            '<span class="dvx-chip-avatarwrap"><span class="dvx-chip-avatar" id="dvxAvatar"></span><span class="dvx-chip-status" id="dvxStatus" hidden></span></span>' +
            '<span class="dvx-chip-name" id="dvxName"></span>' +
            ICON_CARET +
          '</button>' +
          '<div class="dvx-chip-menu" id="dvxChipMenu" hidden>' +
            '<a class="dvx-chip-item" href="account.html">' + ICON_USER + 'Account</a>' +
            '<button class="dvx-chip-item dvx-chip-danger" id="dvxSignOut" type="button">' + ICON_OUT + 'Sign out</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div></header>'
  );
}

// Scroll-aware header: transparent + taller at the very top (the CSS default),
// compact glass on scroll. The compact state lives on html too so the body's
// CSS-reserved padding compacts in lockstep.
function wireScrollHeader() {
  var hdr = document.querySelector('.dvx-header');
  if (!hdr) return;
  // Hysteresis: compacting shrinks the reserved space by 24px, which shifts
  // the scroll position — a single threshold would flip-flop near the top.
  // The 36px gap between the two thresholds exceeds that layout delta.
  var compact = false;
  function onScroll() {
    var y = window.scrollY;
    if (compact) { if (y < 4) compact = false; }
    else if (y > 40) { compact = true; }
    hdr.classList.toggle('is-compact', compact);
    document.documentElement.classList.toggle('dvx-scrolled', compact);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// Mark the nav link matching the current page so the active tab reads at a glance.
function markActiveNav() {
  var path = window.location.pathname.replace(/\/+$/, '');
  var page = path.split('/').pop() || 'index.html';
  if (page === '' || page === 'index') page = 'index.html';
  // The legal document pages live under the "Legal" nav item.
  if (['terms.html', 'privacy.html', 'cookies.html', 'gdpr.html', 'security.html', 'dpa.html'].indexOf(page) !== -1) page = 'legal.html';
  var links = document.querySelectorAll('.dvx-nav a');
  for (var i = 0; i < links.length; i++) {
    var href = (links[i].getAttribute('href') || '').split('#')[0].split('?')[0];
    var on = href === page;
    links[i].classList.toggle('is-active', on);
    if (on) links[i].setAttribute('aria-current', 'page');
    else links[i].removeAttribute('aria-current');
  }
}

// Same footer as the homepage (the "main tab"): brand + Quick Links + Contact
// Info + Newsletter, bottom bar with Terms/Privacy, outlined DOCVEX watermark.
function footerHTML() {
  return (
    '<footer class="dvx-footer">' +
      '<div class="dvx-footer-grid">' +
        '<div>' +
          '<a class="dvx-logo" href="index.html">' +
            '<span class="dvx-logo-ring"><img src="assets/logo.png" alt="DocVex"></span>' +
            '<span class="dvx-logo-word">DOCVEX</span>' +
          '</a>' +
          '<p class="dvx-footer-tag">Intelligent legal workflows for modern law firms. Privacy-first local file storage and focused AI tooling.</p>' +
        '</div>' +
        '<div>' +
          '<p class="dvx-footer-coltitle">Quick Links</p>' +
          '<div class="dvx-footer-links">' +
            '<a href="index.html">Home</a>' +
            '<a href="company.html">Company</a>' +
            '<a href="index.html#services">Services</a>' +
            '<a href="index.html#updates">Updates</a>' +
            '<a href="installers.html">Download</a>' +
            '<a href="enroll.html">Enroll</a>' +
            '<a href="legal.html">Legal</a>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<p class="dvx-footer-coltitle">Contact Info</p>' +
          '<div class="dvx-footer-links">' +
            '<a href="mailto:docvexteam@docvex.ro">docvexteam@docvex.ro</a>' +
            '<a href="https://docvex.ro">docvex.ro</a>' +
            '<span>Bucharest, Romania</span>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<p class="dvx-footer-coltitle">Newsletter</p>' +
          '<form class="dvx-footer-newsform" id="dvxNewsForm">' +
            '<input class="dvx-footer-newsinput" id="dvxNewsEmail" type="email" placeholder="Your Email" autocomplete="email" aria-label="Email for the newsletter">' +
            '<button class="dvx-footer-newsbtn" type="submit">Subscribe</button>' +
          '</form>' +
          '<p class="dvx-footer-newsmsg" id="dvxNewsMsg" hidden></p>' +
          '<p class="dvx-footer-newsnote">Legal updates, summarized for your practice.</p>' +
        '</div>' +
      '</div>' +
      '<div class="dvx-footer-bottom">' +
        '<p>© 2026 DocVex. All rights reserved.</p>' +
        '<div class="dvx-footer-bottomlinks"><a href="terms.html">Terms &amp; Conditions</a><a href="privacy.html">Privacy Policy</a></div>' +
      '</div>' +
      '<div class="dvx-footer-wm" aria-hidden="true"><span>DOCVEX</span></div>' +
    '</footer>'
  );
}

// Footer newsletter signup → enrollments table (type 'newsletter'; degrades to
// a tagged 'waitlist' row if the live table constrains the type column).
function wireNewsletter() {
  var form = document.getElementById('dvxNewsForm');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = (document.getElementById('dvxNewsEmail').value || '').trim();
    var msg = document.getElementById('dvxNewsMsg');
    var show = function (text, ok) { msg.textContent = text; msg.style.color = ok ? '' : 'var(--danger-soft)'; msg.hidden = false; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { show('Please enter a valid email address.', false); return; }
    import('./supabase.js').then(function (m) {
      return m.supabase.from('enrollments').insert({ type: 'newsletter', name: null, email: email, firm: null, message: null }).then(function (res) {
        if (res.error) return m.supabase.from('enrollments').insert({ type: 'waitlist', name: null, email: email, firm: null, message: '[newsletter subscription]' });
        return res;
      });
    }).then(function (res) {
      if (res && res.error) { show('Something went wrong — try again later.', false); return; }
      form.hidden = true;
      show('Subscribed — welcome to the briefing.', true);
    }).catch(function () { show('Something went wrong — try again later.', false); });
  });
}

function renderChip() {
  const auth = document.getElementById('dvxAuthButtons');
  const chip = document.getElementById('dvxChip');
  if (!auth || !chip) return;
  const user = readUser();
  if (!user) { auth.style.display = 'contents'; chip.hidden = true; return; }

  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || user.email || 'Account';
  document.getElementById('dvxName').textContent = name;

  const av = document.getElementById('dvxAvatar');
  if (meta.avatar_url) {
    av.style.background = 'transparent';
    av.innerHTML = '<img src="' + esc(meta.avatar_url) + '" alt="" referrerpolicy="no-referrer">';
  } else {
    av.textContent = (name.trim()[0] || '?').toUpperCase();
    av.style.background = avatarColor(user.id || user.email || name);
  }

  const dot = document.getElementById('dvxStatus');
  const status = meta.status || 'online';
  const color = STATUS_COLORS[status] || STATUS_COLORS.online;
  if (status === 'offline') { dot.style.background = 'var(--bg-page)'; dot.style.boxShadow = '0 0 0 2.5px var(--bg-page), inset 0 0 0 2px ' + color; }
  else { dot.style.background = color; dot.style.boxShadow = '0 0 0 2.5px var(--bg-page)'; }
  dot.title = status.charAt(0).toUpperCase() + status.slice(1);
  dot.hidden = false;

  auth.style.display = 'none';
  chip.hidden = false;
}

// Chip dropdown (Account / Sign out) — identical to the homepage chip: a
// simple menu anchored under the trigger (the old cursor-morph pill is gone
// so the account section reads the same on every page).
function wireChipMenu() {
  var trigger = document.getElementById('dvxChipTrigger');
  var menu = document.getElementById('dvxChipMenu');
  if (!trigger || !menu) return;
  trigger.addEventListener('click', function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; });
  window.addEventListener('mousedown', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) menu.hidden = true;
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu.hidden = true; });
  document.getElementById('dvxSignOut').addEventListener('click', function () {
    import('./supabase.js').then(function (m) { return m.supabase.auth.signOut(); })
      .catch(function () { try { localStorage.removeItem(SUPABASE_AUTH_KEY); } catch (e) {} })
      .then(function () { menu.hidden = true; renderChip(); });
  });
}

function wire() {
  // Theme toggle
  document.getElementById('dvxTheme').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'cream' ? 'ink' : 'cream'));
  applyTheme(currentTheme()); // also syncs the icon visibility

  renderChip();
  window.addEventListener('storage', (e) => { if (e.key === SUPABASE_AUTH_KEY) renderChip(); });
  // Live same-tab updates: re-render on sign-in / sign-out / status change.
  // Registered unconditionally so a session adopted after load (e.g. the desktop
  // app's "Open account" hands one across in the URL) updates the chip without a reload.
  import('./supabase.js').then((m) => { m.supabase.auth.onAuthStateChange(() => renderChip()); }).catch(() => {});

  wireChipMenu();
}

// Cursor-following spotlight (matches the app / homepage): move ONE small box
// via transform each frame and counter-shift its dot grid so the brighter dots
// stay pinned to the viewport grid.
function wireSpotlight() {
  var el = document.querySelector('.cursor-spotlight');
  if (!el) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.style.display = 'none'; return; }
  var R = 215, frame = null;
  // Restore the cursor position from the previous page so the spotlight is
  // already in place after a tab change (the view transition holds it frozen).
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('dvx.spot') || 'null'); } catch (e) {}
  var x = saved ? saved.x : window.innerWidth / 2;
  var y = saved ? saved.y : window.innerHeight / 2;
  function apply() {
    frame = null;
    var px = Math.round(x), py = Math.round(y);
    el.style.transform = 'translate3d(' + (px - R) + 'px,' + (py - R) + 'px,0)';
    el.style.backgroundPosition = (R - px) + 'px ' + (R - py) + 'px';
    try { sessionStorage.setItem('dvx.spot', JSON.stringify({ x: px, y: py })); } catch (e) {}
  }
  function onMove(e) {
    x = e.clientX; y = e.clientY;
    if (frame == null) frame = requestAnimationFrame(apply);
  }
  apply();
  window.addEventListener('pointermove', onMove, { passive: true });
}

// Prerender likely navigation targets (nav tabs, footer links) on hover so tab
// changes are instant; the view-transition cross-fade in chrome.css then makes
// them feel like in-app tab switches.
// it would boot the whole React app in the background.
function wirePrerender() {
  if (!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'))) return;
  var sr = document.createElement('script');
  sr.type = 'speculationrules';
  sr.textContent = JSON.stringify({
    prerender: [{ where: { href_matches: '/*' }, eagerness: 'moderate' }],
  });
  document.head.appendChild(sr);
}

// Floating scroll-to-top button, shown once the page is scrolled past 400px.
function wireToTop() {
  var btn = document.createElement('button');
  btn.className = 'dvx-totop';
  btn.type = 'button';
  btn.title = 'Back to top';
  btn.setAttribute('aria-label', 'Back to top');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
  btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  document.body.appendChild(btn);
  function onScroll() { btn.classList.toggle('is-visible', window.scrollY > 400); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

function mount() {
  // A page can opt out of the navbar (e.g. the login tab) with
  // <html data-dvx-no-navbar> — the footer + theme still apply.
  var noNav = document.documentElement.hasAttribute('data-dvx-no-navbar');
  document.documentElement.classList.add('dvx-has-chrome');
  wireToTop();
  wirePrerender();
  // Ambient dot grid + cursor spotlight (the homepage background). Skip the
  // grid on pages that already paint their own (en-/acc-/inst-dotgrid divs).
  if (!document.querySelector('[class*="dotgrid"]') && !noNav) {
    document.body.insertAdjacentHTML('afterbegin', '<div class="dvx-dotgrid" aria-hidden="true"></div>');
  }
  if (!document.querySelector('.cursor-spotlight')) {
    document.body.insertAdjacentHTML('afterbegin', '<div class="cursor-spotlight" aria-hidden="true"></div>');
    wireSpotlight();
  }
  if (!noNav) {
    document.documentElement.classList.add('dvx-has-navbar');
    document.body.insertAdjacentHTML('afterbegin', navbarHTML());
    markActiveNav();
    wireScrollHeader();
  }
  document.body.insertAdjacentHTML('beforeend', footerHTML());
  wireNewsletter();
  if (!noNav) wire();
  else applyTheme(currentTheme());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
