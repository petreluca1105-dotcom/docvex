// Web demo workspace. The web build (docvex.ro/demo) is a no-sign-in demo of
// the app: when nobody is signed in, SelectedProjectContext selects the
// synthetic project below, and the Files tab opens a folder in OPFS (the
// browser's Origin Private File System) seeded with the starter files here.
//
// OPFS hands back a real FileSystemDirectoryHandle, so the entire existing
// web Files backend (list / preview / write / rename / trash / sidecar in
// lib/localFolder.js) works on it unchanged — no permission prompts, and the
// folder persists across visits. The visitor can add, rename, and delete
// files freely; "Reset" is just clearing site data.
//
// A signed-in user on web gets the real app (their own projects + a
// File System Access folder), never the demo.

import { isElectron } from './platform';

export const DEMO_PROJECT_ID = 'demo-workspace';

// Shaped like a `projects` row so every consumer of selectedProject renders
// it without special-casing.
export const DEMO_PROJECT = Object.freeze({
  id: DEMO_PROJECT_ID,
  name: 'Demo Workspace',
  description: 'A sample matter with starter files — explore DocVex freely. Nothing here leaves your browser.',
  created_by: 'demo',
  // The sample matter is a Bucharest firm's, so the demo shows the jurisdiction
  // setting populated rather than sitting on the implicit default.
  jurisdiction: 'RO',
  created_at: '2026-01-05T09:00:00.000Z',
  updated_at: '2026-07-01T09:00:00.000Z',
});

// Demo is active only on web with nobody signed in.
export function isDemoSession(session) {
  return !isElectron && !session;
}

const OPFS_DIR = 'docvex-demo-files';

// name → contents. Deliberately text-first: txt/md/csv all preview inline and
// feed the Doc Viewer, with zero binary payload in the bundle.
const STARTER_FILES = {
  'Welcome to the DocVex demo.md': `# Welcome to DocVex

This is a live demo workspace — everything you see runs in your browser and
nothing leaves your machine.

Things to try:

- **Open a file** — double-click any file in the Files tab to open the Doc
  Viewer (preview, and the AI advisor panel in the full app).
- **Organize** — rename files, delete them (they land in Recently deleted),
  drag new files in from your desktop.
- **Switch views** — tile and list layouts, Ctrl+scroll to zoom the grid.
- **Explore the tabs** — Chat, To-dos, and the AI hub show the project
  surfaces the full app ships with.

When you're ready for the real thing, download the desktop app from the
Download tab on the website — or create an account to work with your own
projects and team.
`,

  'Engagement letter — Vasilescu & Partners.md': `# Engagement Letter

**Vasilescu & Partners** · Bucharest, Romania
**Matter:** Corporate restructuring — Meridian Holdings S.R.L.
**Date:** 12 June 2026

Dear Mr. Ionescu,

Thank you for choosing Vasilescu & Partners to represent Meridian Holdings
S.R.L. in connection with the proposed corporate restructuring. This letter
confirms the scope of our engagement and the terms on which we will act.

## Scope of work

1. Legal due diligence over the current group structure;
2. Drafting and negotiation of the share transfer agreements;
3. Regulatory filings with the Trade Register (ONRC);
4. Closing support and post-closing corporate housekeeping.

## Fees

Our fees are calculated at the blended hourly rate agreed in Annex 1, with a
cap of EUR 24,000 for the phases above. Disbursements and ONRC fees are
invoiced at cost.

## Term

The engagement runs until the restructuring closes or either party terminates
on 15 days' written notice.

Yours faithfully,
**Andrei Vasilescu** — Managing Partner
`,

  'Case notes — Ionescu v. Popa.txt': `CASE NOTES — Ionescu v. Popa
File 2026-0142 · Civil — contractual dispute
Court: Tribunalul București, Secția a VI-a civilă

2026-05-02  Intake meeting with client (D. Ionescu). Dispute over late
            delivery penalties under the 2024 supply agreement. Client seeks
            recovery of 180,000 RON in liquidated damages.

2026-05-09  Reviewed supply agreement. Penalty clause (art. 12.3) caps
            damages at 15% of contract value — confirm cap math against
            invoiced amounts.

2026-05-21  Statement of claim drafted; sent to client for review.

2026-06-04  Claim filed. First hearing set for 18 September 2026.

2026-06-17  Opposing counsel proposes mediation. Client open to settlement
            at or above 140,000 RON. Prepare position paper before the
            18 Sept hearing.

TO DO
- [ ] Verify penalty cap calculation against invoices (Billing summary)
- [ ] Draft mediation position paper
- [ ] Collect delivery logs from client warehouse system
`,

  'Shareholder agreement — draft v2.md': `# Shareholder Agreement — DRAFT v2

**Company:** Meridian Holdings S.R.L.
**Parties:** A. Ionescu (60%), M. Popescu (25%), Cascade Invest S.A. (15%)

> Draft for internal review — comments marked with ⚠ need partner sign-off.

## 1. Governance

The Company is administered by a board of three directors. Each shareholder
holding at least 20% of the share capital may appoint one director.

⚠ Cascade Invest requests a board seat despite the 15% holding — decide
whether to lower the threshold or grant an observer seat.

## 2. Reserved matters

The following require the approval of shareholders representing at least 80%
of the share capital:

- amending the constitutive act;
- issuing new shares or convertible instruments;
- disposing of assets above EUR 250,000 in a single transaction;
- approving the annual budget.

## 3. Transfer restrictions

Shares may not be transferred to third parties before the third anniversary
of this agreement (lock-up), other than to affiliates. Thereafter, transfers
are subject to a right of first refusal exercisable within 30 days.

## 4. Deadlock

If the board is deadlocked on the same matter at two consecutive meetings,
the matter is escalated to mediation; failing resolution within 60 days, the
Russian-roulette mechanism in Annex C applies.
`,

  'Billing summary — Q3.csv': `Matter,Client,Hours,Rate (EUR),Amount (EUR),Status
Corporate restructuring,Meridian Holdings,42.5,180,7650,Invoiced
Ionescu v. Popa,D. Ionescu,28.0,160,4480,Invoiced
GDPR compliance program,Lex Retail,15.5,170,2635,Draft
Employment — collective dismissal,Novak Industries,9.0,160,1440,Invoiced
Trademark opposition,Aequitas Brands,6.5,150,975,Paid
Lease renegotiation,Meridian Holdings,11.0,180,1980,Draft
`,

  'GDPR compliance checklist.md': `# GDPR Compliance Checklist — Lex Retail

Status legend: ✅ done · 🔶 in progress · ⛔ not started

## Records & governance

- ✅ Records of processing activities (art. 30) — updated May 2026
- ✅ Data protection officer appointed and registered
- 🔶 Data-retention schedule — marketing data pending sign-off

## Rights of data subjects

- ✅ Access-request procedure (30-day SLA)
- 🔶 Erasure workflow — CRM integration in testing
- ⛔ Portability export format — awaiting vendor spec

## Processors & transfers

- ✅ Article 28 DPAs with all hosting providers
- 🔶 Standard contractual clauses for the US analytics vendor
- ⛔ Transfer impact assessment — draft due 30 August 2026

## Security

- ✅ Encryption at rest and in transit for customer data
- ✅ Breach-notification runbook (72-hour clock)
- 🔶 Annual penetration test — scheduled September 2026
`,
};

// True once per browser: seed only when the OPFS folder has no visible files
// (dotfiles like the .docvex.json sidecar don't count), so a visitor's own
// edits/deletions are never overwritten on the next visit.
async function folderHasFiles(dir) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && !entry.name.startsWith('.')) return true;
  }
  return false;
}

// Marker holding the manifest version last seeded into this browser. A
// matching marker means "already seeded from this exact set" — a visitor who
// deletes every starter file gets an empty folder on return, not a re-seeded
// one. When a NEW deploy ships a different manifest version, files from the
// new set that aren't present get added (existing files are never touched).
const SEEDED_MARKER = '.demo-seeded';

async function readSeededMarker(dir) {
  try {
    const fh = await dir.getFileHandle(SEEDED_MARKER, { create: false });
    return (await (await fh.getFile()).text()).trim();
  } catch {
    return null;
  }
}

async function writeSeededMarker(dir, stamp) {
  const fh = await dir.getFileHandle(SEEDED_MARKER, { create: true });
  const w = await fh.createWritable();
  await w.write(stamp);
  await w.close();
}

async function writeDemoFile(dir, name, content) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

// The DEPLOYED starter set: real files served by the site at /demo-files/
// (source: landing/home/demo-files/, staged there by the localhost "Seed
// demo files" debug button, published by the site deploy). The site and the
// app share one origin (docvex.ro serves the demo at /demo/), so a root-
// relative fetch reaches them from either. Returns null when unreachable
// (offline, or `web:dev` where the site isn't mounted) — the caller falls
// back to the inline STARTER_FILES.
async function fetchDemoManifest() {
  try {
    const res = await fetch('/demo-files/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const m = await res.json();
    if (!Array.isArray(m?.files)) return null;
    return {
      version: String(m.version || ''),
      files: m.files.filter((n) => typeof n === 'string' && n && !n.startsWith('.')),
    };
  } catch {
    return null;
  }
}

// Resolve (and when the deployed starter set calls for it: seed) the demo
// folder in OPFS. Returns the FileSystemDirectoryHandle, or null when OPFS
// is unavailable.
export async function ensureDemoFolder() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  let dir;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
  try {
    const manifest = await fetchDemoManifest();
    const marker = await readSeededMarker(dir);
    if (manifest && manifest.files.length > 0) {
      const stamp = `manifest:${manifest.version}`;
      if (marker !== stamp) {
        // Add manifest files this browser doesn't have; never overwrite —
        // a visitor's edits to a same-named file survive redeploys.
        const existing = new Set();
        for await (const entry of dir.values()) existing.add(entry.name);
        for (const name of manifest.files) {
          if (existing.has(name)) continue;
          try {
            const res = await fetch(`/demo-files/${encodeURIComponent(name)}`);
            if (!res.ok) continue;
            await writeDemoFile(dir, name, await res.blob());
          } catch { /* skip this file — the rest still seed */ }
        }
        await writeSeededMarker(dir, stamp);
      }
    } else if (!marker && !(await folderHasFiles(dir))) {
      // Offline / dev fallback: the inline starter texts.
      for (const [name, content] of Object.entries(STARTER_FILES)) {
        await writeDemoFile(dir, name, content);
      }
      await writeSeededMarker(dir, 'builtin');
    }
  } catch {
    // Partial seed is fine — whatever was written still lists.
  }
  return dir;
}
