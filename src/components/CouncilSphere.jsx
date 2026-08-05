import React from 'react';

// AI Thinking Sphere — the council visualization for the Timeline tab's
// Scanning step (Claude Design "AI Thinking Sphere" bundle, ported verbatim).
// A 720×540 canvas renders the council as a living dot-sphere: each member
// owns a dendritic cluster growing outward from their seat, source files dock
// onto the sphere surface as they're read, packets fly as 3D chords between
// clusters, the debate wires a colored web between existing points, and the
// merge funnels every cluster's strands through recursive confluences into
// the centre — which then flares into the "final timeline" core while the
// whole shape settles into a constellation graph.
//
// The design bundle's scripted demo scenario is REPLACED by real inputs:
// the parent (ProjectEvents' CouncilStep) drives everything through props —
// member activity/bubbles/stats from the council event stream, per-file read
// progress, debate/merge/contract stage flags — and through the imperative
// `spawnPacket` handle for files/thoughts in transit.
//
// Props:
//   files        — [{ name }] scanned items (one surface node each)
//   progress     — number[] 0–100 per file (birth + wiring of file nodes)
//   members      — { [id]: { active, bubble, stats } } (labels + growth rate)
//   phase        — centre-bottom phase line ('' hides it)
//   debate       — the council is deliberating (web links start wiring)
//   agitated     — open dispute (clusters vibrate until the chair intervenes)
//   merging      — chair merge in flight (core links + confluence strands)
//   contracting  — end sequence (constellation settle + core flare)
//   storyOn      — show the "It is decided!" card
//   storyEyebrow / storyLede / storyCta — card copy
//   onReadStory / onRedo — card actions
//   paused       — freeze the simulation clock
//   tintBySender — packets tinted by sender instead of type
//
// Ref handle: { spawnPacket(fromId, toId, type) } — toId 'core' rides the
// merge confluences; member↔member thought packets leave a permanent orb.

export const SPHERE_MEMBERS = [
  { id: 'chair', name: 'The Chair', role: 'Presiding', color: '#DCC9A3' },
  { id: 'chronologist', name: 'Chronologist', role: 'Dates & record', color: '#06B6D4' },
  { id: 'narrator', name: 'Narrator', role: 'Causal story', color: '#EC4899' },
  { id: 'auditor', name: 'Auditor', role: 'Contradictions', color: '#84CC16' },
];

// Canvas geometry — the stage box is CW×CH with the sphere centred at
// (CX, CY). The canvas carries 80px of extra headroom above the stage (the
// wrapper is an absolute layer pulled up over the gap to the step rail) and
// 240px below it (over the decision log / tasks, which stack ABOVE the canvas
// in z-order), so the sphere's outward growth and glow are never cut off at a
// section boundary; CW grew to the right so a larger sphere has room to
// breathe. SPHERE_LEFT_PAD extends the canvas across the stage's LEFT run
// (under the packet key / "we have a question" panel, which stack above at
// z1/z2) so packets and glow are never clipped at a hard left edge; the
// sphere's centre keeps its screen position because the wrap is anchored at
// left: 0 and CX carries the pad.
export const SPHERE_LEFT_PAD = 520;
// SPHERE_RIGHT_PAD extends the canvas across the stage's RIGHT run too, so
// packets and glow use all the space to the right of the sphere without
// clipping at a hard edge. The layer is anchored at left: 0 and CX is
// measured from the left, so widening rightward NEVER moves the sphere;
// ancestor overflow clipping (.sv-single-scroll / .main-content) absorbs
// whatever a narrow window can't show.
export const SPHERE_RIGHT_PAD = 480;
export const SPHERE_W = 720 + SPHERE_LEFT_PAD + SPHERE_RIGHT_PAD;
export const SPHERE_H = 860;
export const SPHERE_TOP_PAD = 80;
const CW = SPHERE_W, CH = SPHERE_H, CX = SPHERE_LEFT_PAD + 360, CY = 288 + SPHERE_TOP_PAD;

export const SPHERE_PACKET_COLORS = {
  doc: '#DCC9A3', pen: '#818CF8', fact: '#14B8A6', chat: '#38BDF8',
  flag: '#F59E0B', ask: '#8A93A8', ok: '#22C55E', no: '#F87171',
};

// The settled-constellation teal ramp, precomputed at module load — the
// finale recolours every dot per frame; an array index beats a mix + memo
// lookup in that hot path. Index = Math.round((1 - depth) * 8).
const TEAL_STEPS = (() => {
  const pa = 0x7FD1D9; const pb = 0x2E7E8C; const out = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const b = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    out.push(`rgb(${r},${g},${b})`);
  }
  return out;
})();

export default class CouncilSphere extends React.Component {
  constructor(props) {
    super(props);
    this.canvasRef = React.createRef();
    this.labelRefs = Object.fromEntries(SPHERE_MEMBERS.map((m) => [m.id, React.createRef()]));
    this.MEMBERS = SPHERE_MEMBERS.map((m) => ({ ...m, dir: [0, 1, 0] }));
    this.PACKET_COLORS = SPHERE_PACKET_COLORS;
    // sphere anim internals (never React state — mutated per frame)
    this.pts = []; this.edges = []; this.packets = []; this.trails = []; this.coreLinks = [];
    this.yaw = 0; this.pitch = -0.12; this.contract = 0; this.contractStart = 0;
    this.simTime = 0; this.lastTs = 0; this.raf = 0;
    this.dragging = false;
    this.commOn = false;
    this.unstable = 0; this.unstableTarget = 0; this.chairPulse = 0;
    this.mergeBegun = false;
    // Rotation speed eases toward a slow idle while the council is prompting
    // the author (and back to 1 after), so the spin calms/resumes smoothly.
    this.rotFactor = 1;
  }

  norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

  mixHex(a, b, t) {
    // memoised — callers quantise t, so the same few hundred keys recur every
    // frame; parsing + string building drops out of the frame budget
    const key = a + b + t;
    if (!this._mixCache) this._mixCache = new Map();
    const hit = this._mixCache.get(key);
    if (hit) return hit;
    const pa = parseInt(a.slice(1), 16); const pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    const v = `rgb(${r},${g},${bl})`;
    if (this._mixCache.size > 500) this._mixCache.clear();
    this._mixCache.set(key, v);
    return v;
  }

  // ── external event surface ──────────────────────────────────────────────
  linkCore(id) {
    // Strands DON'T run straight to the centre: anchors merge pairwise or
    // triplewise level after level, radius shrinking each time, until ONE
    // line remains — and only that single line runs into the centre.
    const mi = this.MEMBERS.findIndex((m) => m.id === id);
    if (mi < 0) return;
    const anchors = [];
    const cand = [];
    for (const pt of this.pts) if (pt.region === mi && pt.vis) cand.push(pt);
    for (let k = 0; k < 9 && cand.length; k++) {
      const pt = cand[(Math.random() * cand.length) | 0];
      anchors.push([pt.p[0] * pt.rf, pt.p[1] * pt.rf, pt.p[2] * pt.rf]);
    }
    for (const wn of this.webNodes || []) if (wn.region === mi) anchors.push(wn.p.slice());
    if (!anchors.length) anchors.push(this.MEMBERS[mi].dir.slice());
    const segs = []; const nodes = [];
    const parentOf = new Map();
    let level = anchors.slice();
    let radius = 0.68;
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length;) {
        const take = level.length - i === 4 ? 2 : Math.min(level.length - i, 3);
        const chunk = level.slice(i, i + take); i += take;
        const avg = chunk.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => v / chunk.length);
        const len = Math.hypot(avg[0], avg[1], avg[2]) || 1;
        const jn = [avg[0] / len * radius, avg[1] / len * radius, avg[2] / len * radius];
        next.push(jn);
        nodes.push({ w: jn, ph: Math.random() * 6, s: 1.6 + (0.68 - radius) * 3 });
        for (const c of chunk) { segs.push({ a: c, b: jn }); parentOf.set(c, jn); }
      }
      level = next;
      radius *= 0.58;
    }
    const last = level[0];
    segs.push({ a: last, b: [0, 0, 0] });
    parentOf.set(last, [0, 0, 0]);
    const paths = anchors.map((a) => {
      const path = [a];
      let cur = a; let guard = 0;
      while (parentOf.has(cur) && guard++ < 12) { cur = parentOf.get(cur); path.push(cur); }
      return path;
    });
    if (!this.corePaths) this.corePaths = {};
    this.corePaths[id] = paths;
    this.coreLinks.push({ id, color: this.MEMBERS[mi].color, segs, nodes });
  }

  spawnPacket(fromId, toId, type) {
    // Chamber closed: once everything has been absorbed (or the finale is
    // settling), no NEW member↔member flights may start — late pipeline
    // packets would otherwise cross the "It is decided!" screen. Core-bound
    // packets stay allowed during the settle (they feed the core), but not
    // after absorption completed.
    if (this.absorbDone) return;
    if (this.contractStart && toId !== 'core') return;
    // Random visible dot in the sender's cluster → random visible dot in the
    // receiver's — a chord bending away from the centre, trajectory traced.
    const pick = (id) => {
      const r = this.MEMBERS.findIndex((m) => m.id === id);
      if (r < 0) return [0, 1, 0];
      const cand = [];
      for (const pt of this.pts) if (pt.region === r && pt.vis) cand.push(pt);
      const pt = cand.length ? cand[(Math.random() * cand.length) | 0]
        : (this.hubs && this.hubs[r] >= 0 ? this.pts[this.hubs[r]] : null);
      return pt ? pt.p.slice() : this.MEMBERS[r].dir.slice();
    };
    const pa = pick(fromId);
    if (toId !== 'core' && type !== 'doc') {
      // a new council thought: lands ONE LEVEL LOWER, becomes a permanent orb
      const pbRaw = pick(toId);
      let mid = [pa[0] + pbRaw[0], pa[1] + pbRaw[1], pa[2] + pbRaw[2]];
      if (Math.hypot(mid[0], mid[1], mid[2]) < 0.2) mid = [pa[0] + 0.3, pa[1], pa[2] + 0.2];
      mid = this.norm(mid);
      const jitter = 0.94 + Math.random() * 0.12;
      const lvl = this.thoughtLevel * jitter;
      this.thoughtLevel = Math.min(1.32, this.thoughtLevel + 0.012);
      this.packets.push({ pa, pb: [mid[0] * lvl, mid[1] * lvl, mid[2] * lvl], fromId, type, t: 0, dur: 1600, orb: true });
      return;
    }
    // Core-bound packets fly a STRAIGHT line into the centre (line flag);
    // member↔member packets keep their curved chords.
    const pb = toId === 'core' ? [0, 0, 0] : pick(toId);
    this.packets.push({ pa, pb, fromId, type, t: 0, dur: toId === 'core' ? 1100 : 1600, core: toId === 'core', line: toId === 'core' });
  }

  // Packet-type icon drawn in dark ink over a coloured chip — the same icon
  // language the old mesh packets used (doc / pen / fact / chat / flag / ask /
  // ok / no, matching the packet key). `s` is the glyph half-size.
  drawGlyph(ctx, type, x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = '#0F172A';
    ctx.fillStyle = '#0F172A';
    ctx.lineWidth = Math.max(1, s * 0.34);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    switch (type) {
      case 'ok':
        ctx.moveTo(-s * 0.7, s * 0.05); ctx.lineTo(-s * 0.15, s * 0.55); ctx.lineTo(s * 0.7, -s * 0.5);
        ctx.stroke();
        break;
      case 'no':
        ctx.moveTo(-s * 0.55, -s * 0.55); ctx.lineTo(s * 0.55, s * 0.55);
        ctx.moveTo(s * 0.55, -s * 0.55); ctx.lineTo(-s * 0.55, s * 0.55);
        ctx.stroke();
        break;
      case 'flag':
        ctx.moveTo(-s * 0.45, s * 0.7); ctx.lineTo(-s * 0.45, -s * 0.65);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-s * 0.45, -s * 0.65); ctx.lineTo(s * 0.6, -s * 0.32); ctx.lineTo(-s * 0.45, s * 0.02);
        ctx.closePath(); ctx.fill();
        break;
      case 'ask':
        ctx.font = `700 ${Math.max(4, s * 1.9)}px Inter, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, s * 0.08);
        break;
      case 'chat':
        for (let i = -1; i <= 1; i++) {
          ctx.moveTo(i * s * 0.55 + s * 0.18, 0);
          ctx.arc(i * s * 0.55, 0, s * 0.18, 0, Math.PI * 2);
        }
        ctx.fill();
        break;
      case 'pen':
        ctx.moveTo(-s * 0.55, s * 0.55); ctx.lineTo(s * 0.45, -s * 0.45);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 0.45, -s * 0.45, s * 0.2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'fact':
        ctx.arc(-s * 0.15, -s * 0.15, s * 0.42, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s * 0.18, s * 0.18); ctx.lineTo(s * 0.6, s * 0.6);
        ctx.stroke();
        break;
      case 'doc':
      default:
        ctx.rect(-s * 0.45, -s * 0.6, s * 0.9, s * 1.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-s * 0.2, -s * 0.25); ctx.lineTo(s * 0.2, -s * 0.25);
        ctx.moveTo(-s * 0.2, 0); ctx.lineTo(s * 0.2, 0);
        ctx.moveTo(-s * 0.2, s * 0.25); ctx.lineTo(s * 0.2, s * 0.25);
        ctx.lineWidth = Math.max(0.8, s * 0.2);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  // ── sphere geometry ─────────────────────────────────────────────────────
  buildSphere() {
    // Seats zig-zag around a shared ring — evenly spaced in longitude,
    // alternating above/below the equator; only the orientation is random.
    const M = this.MEMBERS.length;
    const baseLon = Math.random() * Math.PI * 2;
    const zig = 0.42;
    for (let i = 0; i < M; i++) {
      const lon = baseLon + (Math.PI * 2 / M) * i;
      const lat = i % 2 === 0 ? zig : -zig;
      this.MEMBERS[i].dir = this.norm([Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat)]);
    }
    // The source-material sphere's radius (fraction of the thinking radius).
    // The member seats ORIGINATE ON IT and their clusters branch outward
    // from there, so all growth visibly sprouts from the inner sphere.
    const SHELL_R = 0.62;
    this.shellR = SHELL_R;
    this.pts = [];
    // Each member owns a distinct cluster; only the seat is visible at
    // first — the rest are born as that member reads & drafts. BRANCHING
    // growth: each dot forks off an existing one, a step further OUT from
    // the surface, so the member's tree sprouts outward over time.
    for (let r = 0; r < M; r++) {
      const dir = this.MEMBERS[r].dir;
      // Each board member is CREATED FROM THE CENTER: the seat launches out
      // of the core on its own schedule and flies radially to its place.
      this.pts.push({ p: dir.slice(), region: r, tw: Math.random() * Math.PI * 2, sz: 3.4, rf: SHELL_R, launch: 500 + r * 200, launchDur: 550 });
      const seatIdx = this.pts.length - 1;
      const count = Math.round(750 / M / 2.4);
      const regionIdx = [seatIdx];
      for (let i = 0; i < count; i++) {
        const pi = regionIdx[(Math.random() * regionIdx.length) | 0];
        const par = this.pts[pi];
        const p = this.norm([
          par.p[0] + (Math.random() - 0.5) * 1.1,
          par.p[1] + (Math.random() - 0.5) * 1.1,
          par.p[2] + (Math.random() - 0.5) * 1.1,
        ]);
        const u2 = Math.random();
        const rf = Math.min(1.75, par.rf * (1.01 + Math.random() * 0.09));
        this.pts.push({ p, region: r, tw: Math.random() * Math.PI * 2, sz: 1.0 + Math.pow(u2, 6) * 3.0 + u2 * 0.7, rf, parent: pi });
        regionIdx.push(this.pts.length - 1);
      }
    }
    // The initial source-material sphere: a dust shell + the file circles,
    // drawn brighter than the design's barely-there dust so the inner body
    // stays visible under the clusters.
    this.shell = [];
    const gaS = Math.PI * (3 - Math.sqrt(5));
    const SN = 300;
    for (let i = 0; i < SN; i++) {
      const y = 1 - (i / (SN - 1)) * 2;
      const rr = Math.sqrt(1 - y * y);
      const th = gaS * i;
      this.shell.push({ p: [Math.cos(th) * rr * SHELL_R, y * SHELL_R, Math.sin(th) * rr * SHELL_R], tw: Math.random() * Math.PI * 2, sz: 0.7 + Math.random() * 0.8 });
    }
    const NN = this.pts.length;
    // Dendritic trees — one per region, edges stored in GROWTH ORDER and
    // revealed in real time as the member works.
    this.trees = this.MEMBERS.map(() => []);
    this.hubs = this.MEMBERS.map(() => -1);
    for (let i = 0; i < NN; i++) {
      const pt = this.pts[i];
      if (pt.parent === undefined) { this.hubs[pt.region] = i; continue; }
      const fu = Math.random();
      this.trees[pt.region].push({ a: pt.parent, b: i, birth: 0, fc: fu < 0.5 ? '#8CA8E8' : fu < 0.85 ? '#E5C068' : '#D96A8B' });
    }
    this.growth = this.MEMBERS.map(() => 0);
    this.revealed = this.MEMBERS.map(() => 0);
    this.pulses = [];
    this.crossEdges = [];
    // council thoughts: permanent orbs growing OUTWARD level by level
    this.thoughts = [];
    // leftovers transformed into final-product blue orbs at story time
    this.settledOrbs = [];
    this.thoughtLevel = 1.06;
    for (let i = 0; i < NN; i++) { this.pts[i].vis = false; this.pts[i].born = 0; }
    for (const h of this.hubs) { if (h >= 0) { this.pts[h].vis = true; this.pts[h].rf = SHELL_R; } }
    // Debate web: connections run between EXISTING points; each connection
    // births one junction dot which later connections may start from.
    this.webLinks = [];
    this.webNodes = [];
    this.lastWeb = 0;
    // File nodes — one circle per source file, spread evenly on the sphere
    // (Fibonacci). The source sphere is built by DISPENSING them one at a
    // time: each chip launches from the core on its own schedule and flies
    // out to its shell spot; reading a file later wires its orb to the
    // members' clusters.
    const gaF = Math.PI * (3 - Math.sqrt(5));
    const FN = Math.max(1, (this.props.files || []).length);
    this.fileNodes = (this.props.files || []).map((_, i) => {
      const y = 1 - ((i + 0.5) / FN) * 2;
      const rr = Math.sqrt(1 - y * y);
      const th = gaF * i + baseLon;
      return {
        p: [Math.cos(th) * rr * SHELL_R, y * SHELL_R, Math.sin(th) * rr * SHELL_R],
        launch: 300 + i * 220, // simTime when this chip leaves the core
        launchDur: 520,
        born: 0, // stamped on docking — drives the landing flash
        linked: false,
        links: [],
      };
    });
    // The whole formation window — the dust shell + seats grow across it, so
    // the sphere completes exactly as the last source chip docks.
    this.formTotal = 300 + Math.max(0, FN - 1) * 220 + 520;
    // The shell WIREFRAME builds from ONE source material outward: dust dots
    // reveal in order of angular distance from a randomly chosen chip (among
    // the first few dispensed, so the build starts promptly), rippling across
    // the sphere until the shape closes.
    const seedFn = this.fileNodes.length
      ? this.fileNodes[(Math.random() * Math.min(3, this.fileNodes.length)) | 0]
      : null;
    const seedDir = this.norm(seedFn ? seedFn.p.slice() : [1, 0.2, 0.3]);
    const revealBase = seedFn ? seedFn.launch + seedFn.launchDur : 400;
    for (const sp of this.shell) {
      const d = this.norm(sp.p);
      const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * seedDir[0] + d[1] * seedDir[1] + d[2] * seedDir[2])));
      sp.reveal = revealBase + (ang / Math.PI) * 1800 + Math.random() * 260;
    }
    this.corePaths = {};
    // Backdated so the core ember is at full presence on the FIRST frame —
    // no ramp-in; it lives in the sphere from the start and only grows.
    this.coreBorn = performance.now() - 1000;
    this.storyDim = 0;
  }

  rot(p) {
    // rot() runs thousands of times a frame — the four cos/sin only change
    // when yaw/pitch do (once per frame), so they're cached, not recomputed.
    if (this._rcYaw !== this.yaw || this._rcPitch !== this.pitch) {
      this._rcYaw = this.yaw; this._rcPitch = this.pitch;
      this._rcCY = Math.cos(this.yaw); this._rcSY = Math.sin(this.yaw);
      this._rcCX = Math.cos(this.pitch); this._rcSX = Math.sin(this.pitch);
    }
    const cy = this._rcCY, sy = this._rcSY, cx = this._rcCX, sx = this._rcSX;
    const x = p[0] * cy + p[2] * sy;
    const z0 = -p[0] * sy + p[2] * cy;
    const y = p[1] * cx - z0 * sx;
    const z = p[1] * sx + z0 * cx;
    return [x, y, z];
  }

  // Pre-rendered glow sprites replace per-call shadowBlur — the single most
  // expensive canvas-2D operation here. Each (fill, shadow, radius, blur)
  // combo is rasterised ONCE with the exact same fill+shadowBlur pipeline,
  // then reused via drawImage, so the pixels are identical to the old path.
  // Radius quantised to ½px (imperceptible) so the settle animation — which
  // shifts every radius continuously — recycles sprites instead of minting
  // new ones each frame.
  glowDot(ctx, x, y, r, fill, blur, shadow) {
    const rq = Math.max(0.5, Math.round(r * 2) / 2);
    const bq = Math.round(blur);
    const sh = shadow || fill;
    const key = `${fill}|${sh}:${rq}:${bq}`;
    if (!this._glow) this._glow = new Map();
    let sp = this._glow.get(key);
    if (!sp) {
      const size = Math.ceil((rq + bq * 2 + 2) * 2);
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const c2 = cv.getContext('2d');
      c2.fillStyle = fill;
      c2.shadowColor = sh;
      c2.shadowBlur = bq;
      c2.beginPath(); c2.arc(size / 2, size / 2, rq, 0, Math.PI * 2); c2.fill();
      sp = { cv, half: size / 2 };
      if (this._glow.size > 1600) this._glow.clear(); // safety valve
      this._glow.set(key, sp);
    }
    ctx.drawImage(sp.cv, x - sp.half, y - sp.half);
  }

  project(v, R) {
    const f = 900;
    const s = f / (f - v[2] * R);
    return [CX + v[0] * R * s, CY + v[1] * R * s, v[2], s];
  }

  // Allocation-free rot+project into a reusable 4-slot array — the hot loops
  // run thousands of projections a frame, and the rot()+project() pair costs
  // two array allocations each. Same math, zero garbage.
  projectInto(out, p, R) {
    if (this._rcYaw !== this.yaw || this._rcPitch !== this.pitch) {
      this._rcYaw = this.yaw; this._rcPitch = this.pitch;
      this._rcCY = Math.cos(this.yaw); this._rcSY = Math.sin(this.yaw);
      this._rcCX = Math.cos(this.pitch); this._rcSX = Math.sin(this.pitch);
    }
    const cy = this._rcCY, sy = this._rcSY, cx = this._rcCX, sx = this._rcSX;
    const x = p[0] * cy + p[2] * sy;
    const z0 = -p[0] * sy + p[2] * cy;
    const y = p[1] * cx - z0 * sx;
    const z = p[1] * sx + z0 * cx;
    const s = 900 / (900 - z * R);
    out[0] = CX + x * R * s; out[1] = CY + y * R * s; out[2] = z; out[3] = s;
    return out;
  }

  // ── render loop ─────────────────────────────────────────────────────────
  tick = (ts) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.lastTs ? Math.min(50, ts - this.lastTs) : 16;
    this.lastTs = ts;
    if (!this.props.paused) {
      this.simTime += dt;
      const rotTarget = this.props.prompted ? 0.3 : 1;
      this.rotFactor += (rotTarget - this.rotFactor) * Math.min(1, dt * 0.004);
      if (!this.dragging) this.yaw += dt * 0.00012 * this.rotFactor;
      // file nodes follow the REAL per-file read progress
      const prog = this.props.progress || [];
      const nowMs = performance.now();
      for (let i = 0; i < this.fileNodes.length; i++) {
        const fn = this.fileNodes[i];
        const pct = prog[i] || 0;
        if (pct > 0 && !fn.linked) {
          fn.linked = true;
          fn.links = [];
          this.MEMBERS.forEach((m, mi) => {
            const cand = [];
            for (const pt of this.pts) if (pt.region === mi && pt.vis) cand.push(pt);
            const pt = cand.length ? cand[(Math.random() * cand.length) | 0]
              : (this.hubs[mi] >= 0 ? this.pts[this.hubs[mi]] : null);
            if (pt) fn.links.push({ pb: pt.p.slice(), color: m.color, born: nowMs + mi * 160 });
          });
        }
      }
      // contraction tween
      if (this.contractStart && this.contract < 1) {
        this.contract = Math.min(1, (this.simTime - this.contractStart) / 1400);
      }
      // packets — finished flights keep their traced trajectory. Once the
      // finale starts, in-flight packets RUSH (3×) so nothing is still
      // travelling when the "It is decided!" screen appears.
      this.packets = this.packets.filter((pk) => {
        pk.t += (dt / pk.dur) * (this.contractStart ? 3 : 1);
        if (pk.t >= 1) {
          // EVERY non-core packet leaves a landed orb at its destination —
          // doc deliveries used to just vanish on arrival. Core packets are
          // the exception: they're absorbed (they FEED the core instead).
          if (!pk.core) this.thoughts.push({ p: pk.pb, color: this.PACKET_COLORS[pk.type] || '#F5F2EA', type: pk.type, born: performance.now() });
          if (pk.core) { this.coreEnergy = (this.coreEnergy || 0) + 1; this.corePulse = 1; }
          this.trails.push(pk);
          if (this.trails.length > 60) this.trails.shift();
          return false;
        }
        return true;
      });
      // The sweep runs DURING the merge, on a brisk cadence, so every orb is
      // already inside the core BEFORE the thinking finishes — the finale and
      // the "It is decided!" panel arrive to a fully-fed core (the contracting
      // block only mops up last-moment stragglers, fast).
      if (this.mergeBegun) {
        for (const th of this.thoughts) {
          if (th.abs == null) {
            this.absorbSeq = (this.absorbSeq || 0) + 1;
            // orbs landing after the finale began dive in immediately
            th.abs = this.contractStart ? this.simTime + 60 : this.simTime + 150 + this.absorbSeq * 100;
            th.absDur = this.contractStart ? 300 : 600;
            th.p0 = th.p.slice();
          }
        }
      }
      // sweep: scheduled thought orbs travel into the core; each one feeds it
      if (this.thoughts.some((th) => th.abs != null)) {
        this.thoughts = this.thoughts.filter((th) => {
          if (th.abs == null || this.simTime < th.abs) return true;
          const t = (this.simTime - th.abs) / th.absDur;
          if (t >= 1) {
            this.coreEnergy = (this.coreEnergy || 0) + 1;
            this.corePulse = 1;
            return false;
          }
          const e = t * t * (2 - t); // ease-in then accelerate into the centre
          th.p = [th.p0[0] * (1 - e), th.p0[1] * (1 - e), th.p0[2] * (1 - e)];
          return true;
        });
      }
      // the absorption pulse decays quickly — each arrival re-kicks it
      this.corePulse = Math.max(0, (this.corePulse || 0) - dt / 450);
      // absorption complete: every thought orb swallowed and every core-bound
      // packet landed. The "It is decided!" card is gated on this, so the
      // ending only shows once the whole exchange lives inside the core.
      if ((this.mergeBegun || this.contractStart) && !this.absorbDone
        && this.thoughts.length === 0
        && this.packets.length === 0) {
        this.absorbDone = true;
        this.forceUpdate();
      }
      // real-time dendrite growth + synapse firings — growth rate follows
      // whether the member is genuinely working (active from the event feed)
      const started = this.simTime > 400;
      const ms = this.props.members || {};
      for (let r = 0; r < this.MEMBERS.length; r++) {
        const tree = this.trees[r]; if (!tree || !tree.length) continue;
        const act = ms[this.MEMBERS[r].id]?.active ? 1 : 0;
        const forced = this.coreLinks.length > 0;
        if (started) {
          const rate = forced ? 0.0004 : 0.000022 + act * 0.00014;
          this.growth[r] = Math.min(1, this.growth[r] + dt * rate);
        }
        const target = Math.floor(this.growth[r] * tree.length);
        while (this.revealed[r] < target) {
          const e = tree[this.revealed[r]];
          e.birth = performance.now();
          const child = this.pts[e.b];
          child.vis = true; child.born = e.birth;
          if (this.pulses.length < 60) this.pulses.push({ region: r, a: e.a, b: e.b, t: 0, dur: 420 });
          this.revealed[r]++;
        }
        if (this.revealed[r] > 8 && Math.random() < dt * (0.0012 + act * 0.007) && this.pulses.length < 60) {
          const e = tree[(Math.random() * this.revealed[r]) | 0];
          this.pulses.push({ region: r, a: e.a, b: e.b, t: 0, dur: 500 });
        }
      }
      this.pulses = this.pulses.filter((pu) => { pu.t += dt / pu.dur; return pu.t < 1; });
      // instability easing (dispute → chair intervention). While the panel
      // is actually prompting the author the jitter rests too — the sphere
      // holds still and gray until the answer lands.
      this.unstableTarget = this.props.agitated && !this.props.prompted ? 1 : 0;
      this.unstable += (this.unstableTarget - this.unstable) * Math.min(1, dt * 0.004);
      // Per-member vibration: each cluster trembles only while ITS member is
      // actively thinking (eased in/out so it never pops). Rests on prompt.
      if (!this.actEase) this.actEase = this.MEMBERS.map(() => 0);
      for (let r = 0; r < this.MEMBERS.length; r++) {
        const target = !this.props.prompted && ms[this.MEMBERS[r].id]?.active ? 1 : 0;
        this.actEase[r] += (target - this.actEase[r]) * Math.min(1, dt * 0.004);
      }
      // Spontaneous WAVES — ripples that travel across the whole sphere at
      // random moments with random amplitudes (and a random travel axis).
      // In the FINISHED shape (settled constellation / story) waves never
      // stop: a new one spawns the moment none is running, on a faster
      // cadence, so the final product always breathes.
      this.waves = this.waves || [];
      this.waveTimer = (this.waveTimer ?? 800) - dt;
      const finished = this.contract >= 1 || this.props.storyOn;
      if (this.waveTimer <= 0 || (finished && this.waves.length === 0)) {
        if (this.waves.length < 2) {
          this.waves.push({
            born: this.simTime,
            dur: 1800 + Math.random() * 1600,
            // finished product breathes GENTLY — lower amplitude ceiling
            amp: finished ? 0.008 + Math.random() * 0.02 : 0.015 + Math.random() * 0.055,
            axis: this.norm([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1]),
            freq: 5 + Math.random() * 5,
          });
        }
        this.waveTimer = finished ? 500 + Math.random() * 1000 : 1200 + Math.random() * 2800;
      }
      this.waves = this.waves.filter((w) => this.simTime - w.born < w.dur);
      // A SECOND wave layer that rides only the PACKETS (their chords,
      // trails and in-flight chips) — same ripple maths as the sphere's
      // surface waves, but with its OWN spawn clock, axes, durations and a
      // different phase velocity, so the packet undulation always moves out
      // of step (async) with the original wave above.
      this.packetWaves = this.packetWaves || [];
      this.packetWaveTimer = (this.packetWaveTimer ?? 500) - dt;
      if (this.packetWaveTimer <= 0) {
        if (this.packetWaves.length < 2) {
          this.packetWaves.push({
            born: this.simTime,
            dur: 1400 + Math.random() * 1800,
            amp: 0.02 + Math.random() * 0.05,
            axis: this.norm([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1]),
            freq: 4 + Math.random() * 6,
          });
        }
        this.packetWaveTimer = 900 + Math.random() * 2200;
      }
      this.packetWaves = this.packetWaves.filter((w) => this.simTime - w.born < w.dur);
      // debate web — wire existing points together; junctions born at the
      // intersections become new start points. Rests while the council is
      // prompting the author — no new connections until the answer lands.
      if (this.commOn && !this.props.prompted && this.webLinks.length < 110 && this.simTime - this.lastWeb > (this.coreLinks.length ? 140 : 380)) {
        this.lastWeb = this.simTime;
        const r = (Math.random() * this.MEMBERS.length) | 0;
        const clusterPt = (ri) => {
          const cand = [];
          for (const pt of this.pts) if (pt.region === ri && pt.vis) cand.push(pt);
          return cand.length ? cand[(Math.random() * cand.length) | 0].p.slice() : null;
        };
        const own = this.webNodes.filter((n) => n.region === r);
        const start = (own.length && Math.random() < 0.5)
          ? own[(Math.random() * own.length) | 0].p.slice()
          : clusterPt(r);
        const roll = Math.random();
        let end = null;
        if (roll < 0.45) {
          const fls = (this.fileNodes || []).filter((f) => f.born);
          if (fls.length) end = fls[(Math.random() * fls.length) | 0].p.slice();
        } else if (roll < 0.8) {
          let o = (Math.random() * this.MEMBERS.length) | 0;
          if (o === r) o = (o + 1) % this.MEMBERS.length;
          end = clusterPt(o);
        } else if (this.webNodes.length) {
          end = this.webNodes[(Math.random() * this.webNodes.length) | 0].p.slice();
        }
        if (start && end) {
          const nowMs2 = performance.now();
          const color = this.MEMBERS[r].color;
          const jm = this.norm([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2]);
          const lvl = this.thoughtLevel * (0.94 + Math.random() * 0.12);
          this.thoughtLevel = Math.min(1.32, this.thoughtLevel + 0.012);
          const j = [jm[0] * lvl, jm[1] * lvl, jm[2] * lvl];
          this.webLinks.push({ pa: start, pb: j, color, born: nowMs2 });
          this.webLinks.push({ pa: j, pb: end, color, born: nowMs2 + 260 });
          this.webNodes.push({ p: j, color, born: nowMs2 + 200, region: r });
        }
      }
    }
    this.draw(ts);
  };

  draw(ts) {
    const cv = this.canvasRef.current;
    if (!cv) return;
    if (!this.ctx) {
      // Reduced-resolution backing store: rendered at 0.75 px per CSS px and
      // upscaled by the browser. Cuts the fill-rate massively (the old buffer
      // was devicePixelRatio× per axis — 4× the pixels on a 2× display) for a
      // barely-perceptible softness on this glowy, blurred aesthetic.
      const scale = 0.75;
      cv.width = Math.round(CW * scale); cv.height = Math.round(CH * scale);
      this.ctx = cv.getContext('2d');
      this.dpr = scale;
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, CW, CH);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Core sphere radius — thinking grows OUTWARD from it. The canvas box
    // stays CW×CH (the section height never changes); only the projection
    // scale grows, so outermost thought orbs may kiss the canvas edge.
    const R = 230;
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    const con = ease(this.contract);
    // finale REVERSED: the whole shape breathes OUTWARD as it settles into a
    // constellation graph (hub bursts, colored strands, cyan nodes)
    // Open-question swell: the WHOLE shape grows while the council is
    // prompting the author (eased both ways; also drives the core's "?").
    // Slow, deliberate breath — 0.02/frame (was 0.08), so the swell in and
    // the settle back take ~4× longer and read as a gradual grow/shrink
    // rather than a pop.
    this.askEase = (this.askEase || 0) + ((this.props.prompted ? 1 : 0) - (this.askEase || 0)) * 0.02;
    const shrink = (1 + con * 0.22) * (1 + this.askEase * 0.14);
    // The source sphere FORMS FROM THE CORE: every projected radius scales by
    // formE (0→1, ease-out across the dispense window), so the dust shell and
    // member seats expand out of the centre ember while the source chips are
    // dispensed onto it one by one.
    const formT = Math.min(1, this.simTime / (this.formTotal || 1100));
    const formE = 1 - Math.pow(1 - formT, 3);
    const RS = R * shrink * formE;
    // halo gradient — cached per quantised contraction step (1/24), so even
    // the settle animation reuses ~24 gradients instead of building one per
    // frame
    if (!this._haloCache) this._haloCache = new Map();
    const hq = Math.round(con * 24);
    let halo = this._haloCache.get(hq);
    if (!halo) {
      halo = ctx.createRadialGradient(CX, CY, 20, CX, CY, 320);
      halo.addColorStop(0, 'rgba(220, 201, 163, ' + (0.05 + (hq / 24) * 0.10) + ')');
      halo.addColorStop(1, 'rgba(220, 201, 163, 0)');
      this._haloCache.set(hq, halo);
    }
    ctx.fillStyle = halo;
    // the gradient is fully transparent beyond r=320 — fill only its square,
    // not the whole (left-extended) canvas, so the wider layer costs nothing
    ctx.fillRect(CX - 320, CY - 320, 640, 640);
    const ms = this.props.members || {};
    const actOf = (ri) => (ms[this.MEMBERS[ri].id]?.active ? 1 : 0);
    // the source-material sphere's dust shell — smaller than the thinking
    // growth and drawn brighter so the inner body always reads
    // radial wave displacement — every running wave contributes a ripple
    // travelling across the sphere along its own axis
    const waveAt = (p) => {
      let s = 1;
      for (const w of this.waves || []) {
        const wt = (this.simTime - w.born) / w.dur;
        if (wt < 0 || wt > 1) continue;
        const env = Math.sin(Math.PI * wt); // ramp in, peak, ramp out
        const ph = p[0] * w.axis[0] + p[1] * w.axis[1] + p[2] * w.axis[2];
        s += w.amp * env * Math.sin(ph * w.freq - (this.simTime - w.born) * 0.006);
      }
      return s;
    };
    // Packet-only wave displacement — the second wave layer (own spawn
    // clock/axes) with a FASTER phase velocity (0.009 vs 0.006), so even a
    // near-identical axis pair visibly drifts out of step with the sphere's
    // surface wave.
    const packetWaveAt = (p) => {
      let s = 1;
      for (const w of this.packetWaves || []) {
        const wt = (this.simTime - w.born) / w.dur;
        if (wt < 0 || wt > 1) continue;
        const env = Math.sin(Math.PI * wt);
        const ph = p[0] * w.axis[0] + p[1] * w.axis[1] + p[2] * w.axis[2];
        s += w.amp * env * Math.sin(ph * w.freq - (this.simTime - w.born) * 0.009);
      }
      return s;
    };
    // reusable projection scratches — one per concurrently-alive result
    const S1 = this._s1 || (this._s1 = [0, 0, 0, 0]);
    const S2 = this._s2 || (this._s2 = [0, 0, 0, 0]);
    const S3 = this._s3 || (this._s3 = [0, 0, 0, 0]);
    const V3 = this._v3 || (this._v3 = [0, 0, 0]);
    // dust batched by quantised alpha — 300 dots collapse to ~20 fill passes.
    // Each dot waits for its reveal time (the wireframe ripples outward from
    // the seed source material) and fades in over 400ms.
    const dustBatches = new Map();
    for (const sp of this.shell || []) {
      if (sp.reveal != null && this.simTime < sp.reveal) continue;
      const pr = this.projectInto(S1, sp.p, RS * waveAt(sp.p));
      const depth = (pr[2] + 1) / 2;
      const tw = 0.7 + 0.3 * Math.sin(ts * 0.0018 + sp.tw);
      let al = (0.16 + depth * 0.34) * tw * (1 - con * 0.85);
      if (sp.reveal != null) al *= Math.min(1, (this.simTime - sp.reveal) / 400);
      if (al < 0.015) continue;
      const aq = Math.min(24, Math.max(1, Math.round(al * 24)));
      let path = dustBatches.get(aq);
      if (!path) dustBatches.set(aq, path = new Path2D());
      const rr = sp.sz * (0.6 + depth * 0.6) * pr[3];
      path.moveTo(pr[0] + rr, pr[1]);
      path.arc(pr[0], pr[1], rr, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#A8B2C7';
    for (const [aq, path] of dustBatches) { ctx.globalAlpha = aq / 24; ctx.fill(path); }
    const now = performance.now();
    // vibration is PER-MEMBER: only the cluster segments of a member who is
    // actively thinking tremble (eased via actEase); an open dispute (un)
    // still shakes everyone until the Chair intervenes.
    const un = this.unstable || 0;
    // persistent projected-point buffer — rewritten in place each frame, so
    // the biggest per-frame allocation (one array per point) disappears
    if (!this._Pbuf || this._Pbuf.length !== this.pts.length) {
      this._Pbuf = this.pts.map(() => [0, 0, 0, 0]);
    }
    const P = this._Pbuf;
    for (let i = 0; i < this.pts.length; i++) {
      const pt = this.pts[i];
      const vib = Math.max(pt.region != null ? (this.actEase?.[pt.region] || 0) * 0.7 : 0, un);
      let rEff = RS * (pt.rf || 1) * waveAt(pt.p);
      // seats fly out of the core on their launch schedule
      if (pt.launch != null) {
        const lt = (this.simTime - pt.launch) / pt.launchDur;
        rEff *= lt <= 0 ? 0 : lt >= 1 ? 1 : 1 - Math.pow(1 - lt, 3);
      }
      if (vib > 0.01) rEff *= 1 + vib * 0.05 * Math.sin(ts * 0.006 + pt.tw * 5.7);
      const pr = this.projectInto(P[i], pt.p, rEff);
      if (vib > 0.01) {
        pr[0] += Math.sin(ts * 0.055 + pt.tw * 13) * 0.5 * vib;
        pr[1] += Math.cos(ts * 0.048 + pt.tw * 7) * 0.5 * vib;
      }
    }
    // chair intervention: every dot pulsates toward the Chair's sand
    const pulseAge = this.chairPulse ? now - this.chairPulse : 1e9;
    // pulse mix quantised to 12 steps — identical to the eye, but colours
    // repeat frame-to-frame so the glow-sprite cache actually hits
    const pw = pulseAge < 2600 ? Math.round((1 - pulseAge / 2600) * (0.55 + 0.45 * Math.sin(pulseAge * 0.012)) * 12) / 12 : 0;
    const regionCols = this.MEMBERS.map((m) => (pw > 0.02 ? this.mixHex(m.color, '#DCC9A3', Math.min(1, pw)) : m.color));
    const pathPos = (o, t) => {
      const pts = o.path; const n = pts.length - 1;
      const x = Math.min(0.9999, Math.max(0, t)) * n;
      const i = Math.floor(x); const f = x - i;
      const a = pts[i]; const b = pts[i + 1];
      return this.project(this.rot([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]), RS);
    };
    const pathStroke = (o, tEnd) => {
      const segs = 3 * (o.path.length - 1);
      ctx.beginPath();
      for (let s = 0; s <= segs; s++) {
        const p = pathPos(o, (s / segs) * tEnd);
        if (s === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    };
    // curved connection helper — chords BEND AWAY from the centre
    const ctrlOf = (o) => {
      if (!o.ctrl) {
        const a = o.pa, b = o.pb;
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const lm = Math.hypot(m[0], m[1], m[2]);
        let d;
        if (lm < 0.08) {
          const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          d = this.norm(Math.abs(ab[1]) < 0.9 ? [ab[2], 0, -ab[0]] : [0, ab[2], -ab[1]]);
        } else d = [m[0] / lm, m[1] / lm, m[2] / lm];
        const tg = Math.min(0.92, lm + 0.55 * (1 - lm));
        o.ctrl = [d[0] * tg, d[1] * tg, d[2] * tg];
      }
      return o.ctrl;
    };
    // Each packet's bezier is PRECOMPUTED once into 24 model-space samples
    // (cached on the object) — per frame only cheap sample-lerp + projection
    // runs, no quadratic evaluation. 24 segments is visually identical.
    const BZ_N = 24;
    const bezSamples = (o) => {
      if (!o._smp) {
        const c = ctrlOf(o);
        const pts = [];
        for (let s = 0; s <= BZ_N; s++) {
          const t = s / BZ_N;
          pts.push([
            (1 - t) * (1 - t) * o.pa[0] + 2 * t * (1 - t) * c[0] + t * t * o.pb[0],
            (1 - t) * (1 - t) * o.pa[1] + 2 * t * (1 - t) * c[1] + t * t * o.pb[1],
            (1 - t) * (1 - t) * o.pa[2] + 2 * t * (1 - t) * c[2] + t * t * o.pb[2],
          ]);
        }
        o._smp = pts;
      }
      return o._smp;
    };
    const bezPos = (o, t, out) => {
      const pts = bezSamples(o);
      // t may exceed 1 (landing overshoot) — extrapolate along the last leg
      const x = Math.max(0, t) * BZ_N;
      const i = Math.min(BZ_N - 1, x | 0); const f = x - i;
      const a = pts[i]; const b = pts[i + 1];
      V3[0] = a[0] + (b[0] - a[0]) * f;
      V3[1] = a[1] + (b[1] - a[1]) * f;
      V3[2] = a[2] + (b[2] - a[2]) * f;
      // The packet wave rides every sampled point, so chords + kept trails
      // undulate independently of the sphere's surface wave.
      return this.projectInto(out || S1, V3, RS * packetWaveAt(V3));
    };
    const bezStroke = (o, tEnd) => {
      const segs = 9;
      ctx.beginPath();
      for (let s = 0; s <= segs; s++) {
        const p = bezPos(o, (s / segs) * tEnd, S2);
        if (s === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    };
    // core-bound packets travel a STRAIGHT 3D line to the centre (a straight
    // segment stays straight under perspective, so two points suffice)
    const linePos = (o, t, out) => {
      V3[0] = o.pa[0] + (o.pb[0] - o.pa[0]) * t;
      V3[1] = o.pa[1] + (o.pb[1] - o.pa[1]) * t;
      V3[2] = o.pa[2] + (o.pb[2] - o.pa[2]) * t;
      return this.projectInto(out || S1, V3, RS * packetWaveAt(V3));
    };
    const lineStroke = (o, tEnd) => {
      const a = linePos(o, 0, S1); const b = linePos(o, tEnd, S2);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    };
    // arc that FOLLOWS the sphere's curvature: slerp the direction, lerp the
    // radius — every line reads as part of a growing sphere shell. The model-
    // space polyline is PRECOMPUTED once per connection (its endpoints never
    // move); per frame each vertex is only rot+projected — zero slerp trig.
    const buildArc = (o, wa, wb) => {
      const la = Math.hypot(wa[0], wa[1], wa[2]) || 1;
      const lb = Math.hypot(wb[0], wb[1], wb[2]) || 1;
      const a = [wa[0] / la, wa[1] / la, wa[2] / la];
      const b = [wb[0] / lb, wb[1] / lb, wb[2] / lb];
      const dotAB = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      const om = Math.acos(dotAB) || 0.0001;
      const so = Math.sin(om);
      const segs = om > 0.6 ? 12 : 6;
      const pts = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const sa = Math.sin((1 - t) * om) / so;
        const sb = Math.sin(t * om) / so;
        const rr = la + (lb - la) * t;
        const w = this.norm([a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb]);
        pts.push([w[0] * rr, w[1] * rr, w[2] * rr]);
      }
      o._arc = pts;
    };
    // Style-batched drawing: the frame's real cost is the NUMBER of stroke()/
    // fill() rasterisation passes (hundreds of thin translucent lines + tiny
    // dots, each with its own alpha). Group them by (colour, width, alpha
    // quantised to 1/24 — invisible at these opacities) into one Path2D per
    // style and rasterise each style ONCE.
    const strokeBatches = new Map();
    const batchPath = (color, width, alpha) => {
      const key = color + '|' + width + '|' + Math.min(24, Math.max(1, Math.round(alpha * 24)));
      let p = strokeBatches.get(key);
      if (!p) strokeBatches.set(key, p = new Path2D());
      return p;
    };
    const flushStrokes = () => {
      for (const [key, p] of strokeBatches) {
        const i1 = key.indexOf('|'); const i2 = key.lastIndexOf('|');
        ctx.strokeStyle = key.slice(0, i1);
        ctx.lineWidth = +key.slice(i1 + 1, i2);
        ctx.globalAlpha = +key.slice(i2 + 1) / 24;
        ctx.stroke(p);
      }
      strokeBatches.clear();
    };
    const arcInto = (path, o) => {
      const pts = o._arc;
      for (let s = 0; s < pts.length; s++) {
        const pp = this.projectInto(S2, pts[s], RS);
        if (s === 0) path.moveTo(pp[0], pp[1]); else path.lineTo(pp[0], pp[1]);
      }
    };
    // dendrite branches — only the edges grown so far, newborn ones flaring
    for (let r = 0; r < this.MEMBERS.length; r++) {
      const tree = this.trees[r]; if (!tree) continue;
      const act = actOf(r);
      for (let k = 0; k < this.revealed[r]; k++) {
        const e = tree[k];
        const a = P[e.a]; const b = P[e.b];
        // Smooth back-fade instead of a hard z-cull: lines sink away as they
        // rotate behind the sphere and rise back in — no popping.
        const minZ = Math.min(a[2], b[2]);
        const bf0 = Math.max(0, Math.min(1, (minZ + 0.6) / 0.5));
        const backFade = bf0 * bf0 * (3 - 2 * bf0);
        if (backFade <= 0.01) continue;
        const depth = (minZ + 1) / 2;
        const age = now - e.birth;
        // no activity fade — same opacity for every member's branches
        let al = ((0.10 + depth * 0.16) * (1 - con) + con * (0.22 + depth * 0.28)) * backFade;
        let color; let width;
        if (age < 900) {
          color = this.MEMBERS[r].color;
          al += (1 - age / 900) * 0.5 * depth * backFade;
          width = 1.1;
        } else if (con > 0.01) {
          color = e.fc || '#8CA8E8';
          width = 0.75;
        } else {
          color = '#8A93A8';
          width = 0.55;
        }
        if (al < 0.015) continue;
        if (!e._arc) {
          const ea = this.pts[e.a]; const eb = this.pts[e.b];
          buildArc(e, [ea.p[0] * ea.rf, ea.p[1] * ea.rf, ea.p[2] * ea.rf], [eb.p[0] * eb.rf, eb.p[1] * eb.rf, eb.p[2] * eb.rf]);
        }
        arcInto(batchPath(color, width, Math.min(1, al)), e);
      }
    }
    flushStrokes();
    // debate web — links between existing points, junction dots at intersections
    for (const wl of this.webLinks || []) {
      if (now < wl.born) continue;
      const a = this.projectInto(S1, wl.pa, RS);
      const b = this.projectInto(S2, wl.pb, RS);
      const depth = ((a[2] + b[2]) / 2 + 1) / 2;
      const age = now - wl.born;
      let lal = (0.11 + depth * 0.18) * (1 - con * 0.6);
      if (age < 900) lal += (1 - age / 900) * 0.5;
      if (lal < 0.015) continue;
      if (!wl._arc) buildArc(wl, wl.pa, wl.pb);
      arcInto(batchPath(wl.color, age < 900 ? 1.2 : 0.7, Math.min(1, lal)), wl);
    }
    flushStrokes();
    // settled blue orbs — leftovers transformed at story time; they wear the
    // final-product constellation teal and simply sit in the settled shape
    for (const so of this.settledOrbs || []) {
      const pos = this.projectInto(S1, so.p, RS);
      const depth = (pos[2] + 1) / 2;
      const age = now - so.born;
      let sal = 0.5 + depth * 0.4;
      if (age < 500) sal *= age / 500; // soft transform-in
      ctx.globalAlpha = Math.min(1, sal);
      // depth-mix from the precomputed teal ramp
      const soCol = TEAL_STEPS[Math.round((1 - depth) * 8)];
      this.glowDot(ctx, pos[0], pos[1], 2.6 * pos[3], soCol, 6, '#7FD1D9');
    }
    // permanent thought orbs — one per council exchange, deeper over time
    for (const th of this.thoughts || []) {
      const pos = this.projectInto(S1, th.p, RS);
      const depth = (pos[2] + 1) / 2;
      // No birth flash — the arriving chip already carries this exact alpha
      // (same depth formula), so the hand-off is seamless.
      const al = (0.45 + depth * 0.45) * (1 - con * 0.7);
      ctx.globalAlpha = Math.min(1, al);
      const thR = 7.5 * pos[3];
      this.glowDot(ctx, pos[0], pos[1], thR, th.color, 7);
      // the packet's icon rides inside the landed orb
      this.drawGlyph(ctx, th.type, pos[0], pos[1], thR * 0.62);
    }
    for (const wn of this.webNodes || []) {
      if (now < wn.born) continue;
      const pos = this.projectInto(S1, wn.p, RS);
      const depth = (pos[2] + 1) / 2;
      const age = now - wn.born;
      let dal = (0.35 + depth * 0.5) * (1 - con * 0.9);
      if (age < 700) dal += (1 - age / 700) * 0.6;
      ctx.globalAlpha = Math.min(1, dal);
      ctx.strokeStyle = wn.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(pos[0], pos[1], 1.9 * pos[3], 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = Math.min(1, dal * 0.55);
      ctx.fillStyle = wn.color;
      ctx.beginPath(); ctx.arc(pos[0], pos[1], 0.8 * pos[3], 0, Math.PI * 2); ctx.fill();
    }
    // file nodes — circles on the sphere, wired to every member once read.
    // Each chip is DISPENSED from the core on its own schedule (launch /
    // launchDur, simTime-based): it flies radially out of the ember to its
    // shell spot, building the source sphere one material at a time.
    // Pass 1 batches all the wires (so they rasterise in a handful of
    // strokes and stay UNDER the chips); pass 2 draws the chips.
    const fnFlight = (fn) => {
      const lt = (this.simTime - fn.launch) / fn.launchDur;
      if (lt <= 0) return 0;
      if (lt >= 1) return 1;
      return 1 - Math.pow(1 - lt, 3);
    };
    for (const fn of this.fileNodes || []) {
      if (fnFlight(fn) < 1) continue; // wires only once the chip has docked
      const pos = this.projectInto(S3, fn.p, RS);
      const depth = (pos[2] + 1) / 2;
      for (const lk of fn.links) {
        if (now < lk.born) continue;
        const lage = now - lk.born;
        let lal = (0.07 + depth * 0.12) * (1 - con);
        if (lage < 900) lal += (1 - lage / 900) * 0.45;
        if (lal < 0.015) continue;
        if (!lk._arc) buildArc(lk, fn.p, lk.pb);
        arcInto(batchPath(lk.color, lage < 900 ? 1.1 : 0.6, Math.min(1, lal)), lk);
      }
    }
    flushStrokes();
    for (const fn of this.fileNodes || []) {
      const k = fnFlight(fn);
      if (k <= 0) continue; // still inside the core, waiting its turn
      if (k >= 1 && !fn.born) fn.born = now; // docked — stamp for the flash
      const pos = this.projectInto(S3, fn.p, RS * k);
      const depth = (pos[2] + 1) / 2;
      const age = fn.born ? now - fn.born : 0;
      let nal = (0.5 + depth * 0.45) * (1 - con * 0.95);
      if (fn.born && age < 700) nal += (1 - age / 700) * 0.5;
      // source-material chip — the same sand circle + doc glyph the packet
      // key shows for "Source material", so the orbs read as that key entry
      const fnR = (6.2 + depth * 2.2) * pos[3];
      ctx.globalAlpha = Math.min(1, nal);
      this.glowDot(ctx, pos[0], pos[1], fnR, '#DCC9A3', 6);
      this.drawGlyph(ctx, 'doc', pos[0], pos[1], fnR * 0.62);
    }
    // core links — a bundle of strands from each member's web into the centre
    if (this.coreLinks.length && con < 1) {
      // Strand gradients: ONE cached screen-space radial per link (cream at
      // the centre → member colour at the rim — same "brighter inward" read)
      // instead of a per-segment createLinearGradient every frame; segments
      // batch per quantised alpha and stroke once per bucket. This was the
      // finale's worst per-frame cost (~70 gradients + 70 strokes).
      if (!this._linkGrads) this._linkGrads = new Map();
      const lgR = Math.max(1, Math.round(RS / 4) * 4);
      for (const link of this.coreLinks) {
        const lgKey = link.color + ':' + lgR;
        let lg = this._linkGrads.get(lgKey);
        if (!lg) {
          lg = ctx.createRadialGradient(CX, CY, 0, CX, CY, lgR);
          lg.addColorStop(0, '#F5F2EA');
          lg.addColorStop(1, link.color);
          if (this._linkGrads.size > 200) this._linkGrads.clear();
          this._linkGrads.set(lgKey, lg);
        }
        const segBuckets = new Map();
        for (const sg of link.segs) {
          const a = this.projectInto(S1, sg.a, RS);
          const b = this.projectInto(S2, sg.b, RS);
          const pulse = 0.20 + 0.16 * Math.sin(ts * 0.004 + sg.a[0] * 7);
          const sal = pulse * (1 - con * 0.5);
          const aq = Math.min(24, Math.max(1, Math.round(sal * 24)));
          let p = segBuckets.get(aq);
          if (!p) segBuckets.set(aq, p = new Path2D());
          p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]);
        }
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = lg;
        for (const [aq, p] of segBuckets) { ctx.globalAlpha = aq / 24; ctx.stroke(p); }
        for (const nd of link.nodes) {
          const c = this.projectInto(S1, nd.w, RS);
          const depth = (c[2] + 1) / 2;
          ctx.globalAlpha = (0.45 + 0.3 * Math.sin(ts * 0.005 + nd.ph)) * (1 - con * 0.7);
          this.glowDot(ctx, c[0], c[1], nd.s * (0.6 + depth * 0.6) * c[3], '#F5F2EA', 8, link.color);
        }
      }
    }
    // points — small dots batched by (colour, quantised alpha); only the few
    // large glow dots still draw individually (as cached sprites)
    const dotBatches = new Map();
    for (let i = 0; i < this.pts.length; i++) {
      const pt = this.pts[i]; const pr = P[i];
      if (!pt.vis) continue;
      const depth = (pr[2] + 1) / 2;
      const tw = 0.75 + 0.25 * Math.sin(ts * 0.002 + pt.tw);
      // No activity fade — every member's cluster reads at the same opacity;
      // the THINKING member is marked by its vibration alone (see actEase).
      let al = (0.22 + depth * 0.6) * tw;
      const age = now - pt.born;
      if (pt.born && age < 700) al += (1 - age / 700) * 0.6;
      al = al * (1 - con * 0.9) + con * (0.5 + depth * 0.4);
      if (al < 0.02) continue;
      const dotCol = con > 0.01
        ? TEAL_STEPS[Math.round((1 - depth) * 8)]
        : regionCols[pt.region];
      const s = pt.sz * (0.6 + depth * 0.7) * pr[3];
      if (pt.sz > 2.6) {
        ctx.globalAlpha = Math.min(1, al);
        this.glowDot(ctx, pr[0], pr[1], s, dotCol, 8, con > 0.01 ? '#7FD1D9' : dotCol);
      } else {
        const aq = Math.min(24, Math.max(1, Math.round(Math.min(1, al) * 24)));
        const key = dotCol + '|' + aq;
        let path = dotBatches.get(key);
        if (!path) dotBatches.set(key, path = new Path2D());
        path.moveTo(pr[0] + s, pr[1]);
        path.arc(pr[0], pr[1], s, 0, Math.PI * 2);
      }
    }
    for (const [key, path] of dotBatches) {
      const i1 = key.lastIndexOf('|');
      ctx.fillStyle = key.slice(0, i1);
      ctx.globalAlpha = +key.slice(i1 + 1) / 24;
      ctx.fill(path);
    }
    // synapse firings — bright sparks racing along freshly grown branches
    for (const pu of this.pulses) {
      const a = P[pu.a]; const b = P[pu.b];
      // same smooth back-fade as the branches — sparks dim behind the sphere
      const minZ = Math.min(a[2], b[2]);
      const bf0 = Math.max(0, Math.min(1, (minZ + 0.6) / 0.5));
      const backFade = bf0 * bf0 * (3 - 2 * bf0);
      if (backFade <= 0.01) continue;
      const x = a[0] + (b[0] - a[0]) * pu.t;
      const y = a[1] + (b[1] - a[1]) * pu.t;
      const depth = (minZ + 1) / 2;
      const c = this.MEMBERS[pu.region].color;
      ctx.globalAlpha = Math.sin(Math.PI * pu.t) * (0.35 + depth * 0.6) * (1 - con) * backFade;
      this.glowDot(ctx, x, y, 1.4 + depth * 0.9, '#F5F2EA', 7, c);
    }
    // hub nodes — one bright anchor per region
    for (let r = 0; r < this.MEMBERS.length; r++) {
      if (this.hubs[r] < 0) continue;
      const hubPt = this.pts[this.hubs[r]];
      // not yet created — still inside the core, waiting its launch slot
      if (hubPt.launch != null && this.simTime < hubPt.launch) continue;
      const hp = P[this.hubs[r]];
      if (!hp) continue;
      const depth = (hp[2] + 1) / 2;
      const act = actOf(r);
      // pop-in as it leaves the core
      const spawnAl = hubPt.launch != null ? Math.min(1, (this.simTime - hubPt.launch) / 250) : 1;
      ctx.globalAlpha = (0.5 + depth * 0.5) * (1 - con) * spawnAl;
      this.glowDot(ctx, hp[0], hp[1], (3.2 + act * 1.4) * hp[3], this.MEMBERS[r].color, 12 + act * 8);
    }
    // packets — chords through the sphere, trajectories kept
    const pkColor = (pk) => (this.props.tintBySender
      ? (this.MEMBERS.find((m) => m.id === pk.fromId)?.color || '#DCC9A3')
      : this.PACKET_COLORS[pk.type] || '#DCC9A3');
    // trails batched by (colour, alpha) — up to 60 strokes collapse to a few
    for (const tr of this.trails) {
      const a = tr.path ? pathPos(tr, 0) : tr.line ? linePos(tr, 0, S1) : bezPos(tr, 0, S1);
      const b = tr.path ? pathPos(tr, 1) : tr.line ? linePos(tr, 1, S2) : bezPos(tr, 1, S2);
      const depth = ((a[2] + b[2]) / 2 + 1) / 2;
      const tal = (0.08 + depth * 0.14) * (1 - con);
      if (tal < 0.015) continue;
      if (tr.path) {
        ctx.strokeStyle = pkColor(tr); ctx.globalAlpha = tal; ctx.lineWidth = 0.7;
        pathStroke(tr, 1);
      } else {
        const path = batchPath(pkColor(tr), 0.7, tal);
        if (tr.line) {
          const pa2 = linePos(tr, 0, S1); path.moveTo(pa2[0], pa2[1]);
          const pb2 = linePos(tr, 1, S2); path.lineTo(pb2[0], pb2[1]);
        } else {
          for (let s = 0; s <= 9; s++) {
            const p = bezPos(tr, s / 9, S2);
            if (s === 0) path.moveTo(p[0], p[1]); else path.lineTo(p[0], p[1]);
          }
        }
      }
    }
    flushStrokes();
    // ease-out-back: overshoots the destination (~6% of the path) near the
    // end of the flight and springs back — the landing bounce lives in the
    // POSITION, not the size. Ends exactly at 1 so the orb hand-off is clean.
    const backOut = (t) => { const c1 = 1.2; const c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };
    for (const pk of this.packets) {
      const t = pk.t;
      // core packets are absorbed — no overshoot THROUGH the core
      const u = pk.core ? t : backOut(t);
      // S3: the head position must survive the trajectory strokes below
      // (which recycle S1/S2)
      const pos = pk.path ? pathPos(pk, u) : pk.line ? linePos(pk, u, S3) : bezPos(pk, u, S3);
      const color = pkColor(pk);
      const depth = (pos[2] + 1) / 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = (0.14 + depth * 0.18) * (1 - con);
      if (pk.path) pathStroke(pk, t); else if (pk.line) lineStroke(pk, t); else bezStroke(pk, t);
      // Opacity follows the SAME depth formula as the landed orbs, so it
      // glides continuously along the flight and matches the destination orb
      // exactly on arrival — no sine fade, no flicker, no alpha jump.
      ctx.globalAlpha = Math.min(1, (0.45 + depth * 0.45) * (1 - con * 0.7));
      // Depth-scaled like the LANDED orbs (7.5 × perspective) so the size
      // glides continuously along the flight and matches the destination orb
      // exactly on arrival — no size jump at the hand-off.
      const pkR = 7.5 * pos[3];
      this.glowDot(ctx, pos[0], pos[1], pkR, color, 9);
      // the packet's icon rides on the chip in flight
      this.drawGlyph(ctx, pk.type, pos[0], pos[1], pkR * 0.62);
    }
    // core — the "final timeline" orb. ALWAYS on: it starts as a weak ember
    // at the centre and FEEDS on what it swallows — every packet or thought
    // orb absorbed bumps coreEnergy, which grows the orb and brightens the
    // flare; corePulse gives each arrival a visible kick.
    const energy = this.coreEnergy || 0;
    const pulse = this.corePulse || 0;
    {
      if (!this.coreBorn) this.coreBorn = now;
      const ramp = Math.min(1, (now - this.coreBorn) / 900);
      if (this.props.storyOn) {
        this.storyDim = Math.min(1, (this.storyDim || 0) + 0.02);
      } else this.storyDim = 0;
      const dim = 1 - (this.storyDim || 0) * 0.55;
      const grow = Math.min(9, energy * 0.5);
      const bright = Math.min(1, 0.42 + energy * 0.035 + (this.mergeBegun ? 0.15 : 0));
      // hover swell (final product): the core breathes up while the pointer
      // rests on its hotspot — eased per frame so it glides in and out
      this.coreHoverEase = (this.coreHoverEase || 0) + ((this.coreHover ? 1 : 0) - (this.coreHoverEase || 0)) * 0.12;
      // open question: the core TRANSFORMS into the ask marker — it swells to
      // at least the size that fits the "?" glyph (askEase is updated at the
      // top of draw, where it also swells the whole shape) and wears the icon
      // until the answer lands.
      let coreR = (4.5 + grow + con * 9) * ramp * (1 + pulse * 0.3) * (1 + this.coreHoverEase * 0.22);
      const ASK_R = 26; // fits the glyph comfortably
      coreR += (Math.max(coreR, ASK_R) - coreR) * this.askEase;
      // Once the thinking finishes, the core burns at MAX glow and full
      // opacity — `con` (the finale settle, 0→1) blends the resting look
      // into that state, so it peaks exactly as the shape settles.
      // flare gradient cached by (quantised radius, quantised con) — the
      // settle grows the core every frame and used to rebuild this each time
      if (!this._flareCache) this._flareCache = new Map();
      const fqR = Math.max(1, Math.round(coreR * 2) / 2);
      const fqC = Math.round(con * 12);
      const fKey = fqR + ':' + fqC;
      let flare = this._flareCache.get(fKey);
      if (!flare) {
        flare = ctx.createRadialGradient(CX, CY, 0, CX, CY, fqR * 3.2);
        flare.addColorStop(0, `rgba(245, 242, 234, ${0.8 + 0.2 * (fqC / 12)})`);
        flare.addColorStop(0.35, `rgba(220, 201, 163, ${0.45 + 0.15 * (fqC / 12)})`);
        flare.addColorStop(1, 'rgba(220, 201, 163, 0)');
        if (this._flareCache.size > 300) this._flareCache.clear();
        this._flareCache.set(fKey, flare);
      }
      const restFlare = (0.75 + 0.06 * Math.sin(ts * 0.003)) * ramp * dim * bright + pulse * 0.2;
      ctx.globalAlpha = Math.min(1, restFlare * (1 - con) + con);
      ctx.fillStyle = flare;
      ctx.beginPath(); ctx.arc(CX, CY, coreR * 3.2, 0, Math.PI * 2); ctx.fill();
      const restInner = 0.95 * ramp * dim * (bright + 0.25) + pulse * 0.15;
      ctx.globalAlpha = Math.min(1, restInner * (1 - con) + con);
      ctx.fillStyle = '#F5F2EA';
      if (con > 0.01) { ctx.shadowColor = '#F5F2EA'; ctx.shadowBlur = 18 * con; }
      ctx.beginPath(); ctx.arc(CX, CY, coreR * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // the open-question "?" rides the transformed core while prompting
      if (this.askEase > 0.02) {
        ctx.globalAlpha = this.askEase;
        this.drawGlyph(ctx, 'ask', CX, CY, coreR * 0.45 * 0.72);
      }
      ctx.globalAlpha = 1;
    }
    // top fade toward the step-tab connector line — done IN-canvas with a
    // cached gradient + destination-out (a CSS mask forced the compositor to
    // re-mask the whole 720×860 layer every frame)
    if (!this._fadeGrad) {
      this._fadeGrad = ctx.createLinearGradient(0, 0, 0, 110);
      this._fadeGrad.addColorStop(0, 'rgba(0,0,0,1)');
      this._fadeGrad.addColorStop(1, 'rgba(0,0,0,0)');
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = this._fadeGrad;
    ctx.fillRect(0, 0, CW, 110);
    ctx.globalCompositeOperation = 'source-over';
    // member labels — projected seat directions; far-side labels fade out.
    // A label fades in only after its seat dot has ARRIVED at its place
    // (launch + flight from the core), over 350ms.
    for (let mi = 0; mi < this.MEMBERS.length; mi++) {
      const m = this.MEMBERS[mi];
      const el = this.labelRefs[m.id].current;
      if (!el) continue;
      const hubPt = this.hubs[mi] >= 0 ? this.pts[this.hubs[mi]] : null;
      const arriveAt = hubPt && hubPt.launch != null ? hubPt.launch + hubPt.launchDur : 0;
      const arrived = Math.max(0, Math.min(1, (this.simTime - arriveAt) / 350));
      const c = this.project(this.rot(m.dir), RS * (this.shellR || 1));
      const t = Math.max(0, Math.min(1, (c[2] + 0.05) / 0.45));
      const vis = t * t * (3 - 2 * t);
      el.style.left = c[0] + 'px';
      el.style.top = (c[1] + 14) + 'px';
      el.style.opacity = this.props.contracting ? 0 : vis * (1 - con) * arrived;
      el.style.zIndex = c[2] > 0 ? 2 : 1;
    }
  }

  // ── lifecycle / prop-driven stage transitions ───────────────────────────
  componentDidMount() {
    this.buildSphere();
    this.syncStages({});
    this.raf = requestAnimationFrame(this.tick);
  }

  componentDidUpdate(prev) { this.syncStages(prev); }

  componentWillUnmount() { cancelAnimationFrame(this.raf); }

  syncStages(prev) {
    const p = this.props;
    if (p.debate && !this.commOn) this.commOn = true;
    // dispute settled → the chair's calming pulse ripples every cluster
    if (prev.agitated && !p.agitated) this.chairPulse = performance.now();
    // merge: wire every member's web into the centre, then feed it packets
    if (p.merging && !this.mergeBegun) {
      this.mergeBegun = true;
      this.commOn = true;
      this.MEMBERS.forEach((m, i) => {
        setTimeout(() => {
          this.linkCore(m.id);
          this.spawnPacket(m.id, 'core', 'pen');
        }, 300 + i * 400);
      });
    }
    // "It is decided!" is showing: anything STILL outside the core stops
    // travelling and TRANSFORMS into a settled blue orb — the same teal the
    // final-product constellation wears — so the screen is always calm.
    if (p.storyOn && !prev.storyOn) {
      const leftovers = [];
      for (const pk of this.packets) {
        const t = Math.max(0, Math.min(1, pk.t));
        const c = pk.ctrl;
        leftovers.push(c ? [
          (1 - t) * (1 - t) * pk.pa[0] + 2 * t * (1 - t) * c[0] + t * t * pk.pb[0],
          (1 - t) * (1 - t) * pk.pa[1] + 2 * t * (1 - t) * c[1] + t * t * pk.pb[1],
          (1 - t) * (1 - t) * pk.pa[2] + 2 * t * (1 - t) * c[2] + t * t * pk.pb[2],
        ] : [
          pk.pa[0] + (pk.pb[0] - pk.pa[0]) * t,
          pk.pa[1] + (pk.pb[1] - pk.pa[1]) * t,
          pk.pa[2] + (pk.pb[2] - pk.pa[2]) * t,
        ]);
      }
      for (const th of this.thoughts) leftovers.push(th.p.slice());
      this.packets = [];
      this.thoughts = [];
      if (leftovers.length) {
        this.settledOrbs = (this.settledOrbs || []).concat(
          leftovers.map((pos) => ({ p: pos, born: performance.now() }))
        );
      }
      if (!this.absorbDone) { this.absorbDone = true; this.forceUpdate(); }
    }
    // finale compression
    if (p.contracting && !this.contractStart) {
      if (!this.mergeBegun) {
        // restored/degraded runs jump straight to the end — still wire the
        // confluences so the compression has strands to pull in
        this.mergeBegun = true;
        this.MEMBERS.forEach((m) => this.linkCore(m.id));
      }
      this.contractStart = this.simTime || 1;
      // Mop up any last-moment stragglers FAST (most orbs were already
      // swallowed during the merge) — everything must be inside the core
      // well before the settle ends and the "It is decided!" panel shows.
      const WINDOW = 500; const DUR = 350; const LEAD = 60;
      const base = this.simTime || 1;
      const n = this.thoughts.length;
      const span = Math.max(0, WINDOW - DUR - LEAD);
      this.thoughts.forEach((th, i) => {
        if (th.abs != null && base >= th.abs) return; // mid-flight — don't yank
        if (!th.p0) th.p0 = th.p.slice();
        th.abs = Math.min(th.abs ?? Infinity, base + LEAD + (n > 1 ? (span * i) / (n - 1) : 0));
        th.absDur = Math.min(th.absDur || DUR, DUR);
      });
      // RECALL every packet still in the air: it abandons its route mid-
      // flight and flies STRAIGHT to the core from wherever it is right now.
      // Combined with the closed-chamber spawn guard, this is what guarantees
      // nothing is travelling by the time the settle ends.
      this.packets = this.packets.map((pk) => {
        if (pk.core) return pk;
        const t = Math.max(0, Math.min(1, pk.t));
        const c = pk.ctrl; // cached by the draw's ctrlOf on first render
        const cur = c ? [
          (1 - t) * (1 - t) * pk.pa[0] + 2 * t * (1 - t) * c[0] + t * t * pk.pb[0],
          (1 - t) * (1 - t) * pk.pa[1] + 2 * t * (1 - t) * c[1] + t * t * pk.pb[1],
          (1 - t) * (1 - t) * pk.pa[2] + 2 * t * (1 - t) * c[2] + t * t * pk.pb[2],
        ] : [
          pk.pa[0] + (pk.pb[0] - pk.pa[0]) * t,
          pk.pa[1] + (pk.pb[1] - pk.pa[1]) * t,
          pk.pa[2] + (pk.pb[2] - pk.pa[2]) * t,
        ];
        return { pa: cur, pb: [0, 0, 0], fromId: pk.fromId, type: pk.type, t: 0, dur: 450, core: true, line: true };
      });
      this.MEMBERS.forEach((m, i) => {
        setTimeout(() => this.spawnPacket(m.id, 'core', 'fact'), 100 + i * 150);
      });
    }
  }

  render() {
    const { members = {}, phase, storyOn, storyEyebrow, storyLede, storyCta, onReadStory, onRedo } = this.props;
    return (
      <div className={`csx-stagewrap${this.props.prompted ? ' is-prompted' : ''}`}>
        <canvas
          ref={this.canvasRef}
          width={SPHERE_W}
          height={SPHERE_H}
          className="csx-canvas"
          aria-hidden="true"
          style={{ width: SPHERE_W, height: SPHERE_H, display: 'block', pointerEvents: 'none' }}
        />
        {SPHERE_MEMBERS.map((m) => {
          const st = members[m.id] || {};
          return (
            <div key={m.id} ref={this.labelRefs[m.id]} className="csx-label">
              <span className="csx-label-name">
                <span
                  className="csx-label-dot"
                  style={{ background: m.color, boxShadow: st.active ? `0 0 8px ${m.color}` : 'none' }}
                />
                {m.name}
              </span>
              <span className="csx-label-role">{m.role}</span>
              <span className="csx-label-stat" style={{ color: m.color }}>{st.stats || ''}</span>
            </div>
          );
        })}
        <div className="csx-phase" style={{ opacity: phase ? 1 : 0 }}>{phase}</div>
        {/* Final product: the core itself is clickable — it IS the final
            story. Hovering swells its glow (coreHover read by the draw loop)
            and reveals the hint pill; clicking opens the story tab. */}
        {storyOn && (
          <button
            type="button"
            className="csx-core-hit"
            onMouseEnter={() => { this.coreHover = true; }}
            onMouseLeave={() => { this.coreHover = false; }}
            onClick={onReadStory}
            aria-label="Open the final story"
          >
            <span className="csx-core-hint">This is the final story — click to open it</span>
          </button>
        )}
        {/* The card shows as soon as the pipeline reaches the story stage —
            any packets/orbs still outside are transformed into settled blue
            orbs at that same moment (see the storyOn block in syncStages). */}
        {storyOn && (
          <div className="csx-story">
            <div className="csx-story-eyebrow">{storyEyebrow || 'Council ruling · unanimous'}</div>
            <div className="csx-story-title">It is decided!</div>
            <p className="csx-story-lede">{storyLede || 'The council assembled the story — every beat sourced and merged.'}</p>
            <div className="csx-story-actions">
              <button type="button" className="csx-story-redo" onClick={onRedo}>Run again</button>
              <button type="button" className="csx-story-btn" onClick={onReadStory}>{storyCta || 'Read the whole story'}</button>
            </div>
          </div>
        )}
      </div>
    );
  }
}
