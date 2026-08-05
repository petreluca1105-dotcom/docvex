import React, { useEffect, useMemo, useRef, useState } from 'react';
import { listOcrHistories, OCR_HISTORY_PREFIX } from '../lib/extractionHistory';
import { localFolderApi, guessMimeFromName } from '../lib/localFolder';
import { describeLocalFile } from '../lib/thumbnailDescriptor';
import FileThumbnail from './FileThumbnail';
import Tooltip from './Tooltip';
import './ExtractionsPanel.css';

// "Extractions" tab (AI section, next to Mail). Surfaces every "Extract text"
// snippet collected in the Doc Viewer across all files. A left sidebar lists an
// "All files" entry plus one row per file that has extracted text; the main
// area lists the matching items in the SAME timeline-rail format the Doc
// Viewer's own "Extracted text" panel uses (date rail + thumbnail + text card).
// Read/lightly-mutates the per-file localStorage histories (lib/extractionHistory.js).

// "All files" / Extractions glyph — exported so the AI-section navbar tab can
// use the SAME icon as the sidebar's "All files" entry (single source).
export const ExtractionsIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8h10M7 12h10M7 16h6" />
  </svg>
);
// Split a timestamp into { date, time } — mirrors the Doc Viewer history rail.
function fmtStamp(ms) {
  if (!ms) return { date: '', time: '' };
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
  };
}

export default function ExtractionsPanel({ from = '', to = '', arrange = 'date' } = {}) {
  // Re-read on mount and whenever another window (the Doc Viewer) writes a
  // snippet — localStorage fires a cross-window `storage` event we listen for.
  const [tick, setTick] = useState(0);
  const files = useMemo(() => listOcrHistories(), [tick]);
  const [selectedPath, setSelectedPath] = useState(null); // null = All files
  const [copiedId, setCopiedId] = useState(null);
  const mainRef = useRef(null);
  const [currentGroupKey, setCurrentGroupKey] = useState(null);

  useEffect(() => {
    const onStorage = (e) => {
      if (!e.key || e.key.startsWith(OCR_HISTORY_PREFIX)) setTick((t) => t + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // If the selected file disappears (history cleared elsewhere), fall back to All.
  useEffect(() => {
    if (selectedPath && !files.some((f) => f.filePath === selectedPath)) setSelectedPath(null);
  }, [files, selectedPath]);

  const totalItems = files.reduce((n, f) => n + f.count, 0);

  // File rows as Files-window-style tiles (preview on top, name underneath) —
  // same as the Doc Viewer's open-files sidebar. Descriptor memoised so the
  // thumbnail resolver's cache key stays stable across renders.
  const fileTiles = useMemo(() => files.map((f) => ({
    ...f,
    descriptor: describeLocalFile({
      // MIME inferred from the filename — the engine classifies by extension
      // too, but a real MIME keeps the classification exact.
      localFile: { name: f.fileName, mimeType: guessMimeFromName(f.fileName), path: f.filePath },
    }),
  })), [files]);

  // Items for the main area: flattened across files (All), or one file's, each
  // tagged with its file. Filtered to the from–to date range, then chronological
  // (oldest first) like the Doc Viewer's "Extracted text" timeline.
  const items = useMemo(() => {
    const pick = selectedPath ? files.filter((f) => f.filePath === selectedPath) : files;
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const flat = pick
      .flatMap((f) => f.entries.map((e) => ({ ...e, fileName: f.fileName, filePath: f.filePath })))
      .filter((e) => {
        const t = e.createdAt || 0;
        if (fromMs != null && t < fromMs) return false;
        if (toMs != null && t > toMs) return false;
        return true;
      });
    return flat.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }, [files, selectedPath, from, to]);

  // filePath → thumbnail descriptor, so each timeline item can show its source
  // file as a tile (All-files view) reusing the memoised tile descriptors.
  const descByPath = useMemo(
    () => new Map(fileTiles.map((f) => [f.filePath, f.descriptor])),
    [fileTiles],
  );

  const isAll = selectedPath === null;

  // Sections for the All-files view. Each section is one sticky origin tile +
  // its items; the timeline line breaks between sections.
  //  • arrange 'date' → consecutive same-file runs in chronological order.
  //  • arrange 'file' → one section per file (all of a file's items together),
  //    files ordered by recency (the sidebar order).
  const groups = useMemo(() => {
    if (arrange === 'file') {
      const byPath = new Map();
      for (const it of items) {
        if (!byPath.has(it.filePath)) byPath.set(it.filePath, { filePath: it.filePath, fileName: it.fileName, items: [] });
        byPath.get(it.filePath).items.push(it);
      }
      const rank = new Map(fileTiles.map((f, i) => [f.filePath, i]));
      return [...byPath.values()].sort((a, b) => (rank.get(a.filePath) ?? 0) - (rank.get(b.filePath) ?? 0));
    }
    const out = [];
    for (const it of items) {
      const last = out[out.length - 1];
      if (last && last.filePath === it.filePath) last.items.push(it);
      else out.push({ filePath: it.filePath, fileName: it.fileName, items: [it] });
    }
    return out;
  }, [items, arrange, fileTiles]);

  // Track which section is currently scrolled to (the one whose sticky origin
  // tile is pinned at the top) so it can be highlighted. The active section is
  // the last group whose top has scrolled above a reference line near the top
  // of the scroller.
  useEffect(() => {
    const scroller = mainRef.current;
    if (!scroller || !isAll) { setCurrentGroupKey(null); return undefined; }
    const compute = () => {
      const refY = scroller.getBoundingClientRect().top + 28;
      let key = null;
      scroller.querySelectorAll('.exr-group').forEach((el) => {
        if (el.getBoundingClientRect().top <= refY) key = el.dataset.groupKey || null;
      });
      setCurrentGroupKey(key);
    };
    compute();
    scroller.addEventListener('scroll', compute, { passive: true });
    return () => scroller.removeEventListener('scroll', compute);
  }, [isAll, groups]);

  const copy = async (it) => {
    try {
      await navigator.clipboard.writeText(it.text || '');
      setCopiedId(it.id);
      setTimeout(() => setCopiedId((c) => (c === it.id ? null : c)), 1400);
    } catch { /* clipboard blocked — non-fatal */ }
  };

  // One timeline row (date rail + node + thumbnail + text card). The origin
  // file tile lives at the group level (sticky), not here. The line fades in/out
  // at the first/last item of its container via :first-child/:last-child.
  const renderItem = (it) => {
    const { date, time } = fmtStamp(it.createdAt);
    return (
      <div key={`${it.filePath}:${it.id}`} className="exr-history-item">
        <div className="exr-history-rail">
          <span className="exr-history-node" />
          <div className="exr-history-date">
            <span className="exr-history-date-d">{date}</span>
            <span className="exr-history-date-t">{time}</span>
          </div>
        </div>
        <div className="exr-history-content">
          {it.thumb && (
            <div className="exr-history-thumb"><img src={it.thumb} alt="" /></div>
          )}
          <div className="exr-history-card">
            <p className={`exr-history-text${it.text ? '' : ' is-empty'}`}>
              {it.text || 'No text found in this selection.'}
            </p>
            <div className="exr-history-actions">
              {it.text && (
                <button type="button" className="exr-history-act" onClick={() => copy(it)}>
                  {copiedId === it.id ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="exr-panel">
      <aside className="exr-sidebar">
        <button
          type="button"
          className={`exr-side-item exr-side-all${selectedPath === null ? ' is-active' : ''}`}
          onClick={() => setSelectedPath(null)}
        >
          <span className="exr-side-icon">{ExtractionsIcon({ width: 16, height: 16 })}</span>
          <span className="exr-side-label">All files</span>
          <span className="exr-side-count">{totalItems}</span>
        </button>

        <div className="exr-side-divider" role="separator" />

        <div className="exr-file-tiles">
          {fileTiles.map((f) => (
            <Tooltip key={f.filePath} content={f.filePath}>
              <button
                type="button"
                className={`exr-file-tile${selectedPath === f.filePath ? ' is-active' : ''}`}
                onClick={() => setSelectedPath(f.filePath)}
              >
                <span className="exr-file-thumb">
                  <FileThumbnail descriptor={f.descriptor} />
                </span>
                <span className="exr-file-count">{f.count}</span>
                <span className="exr-file-name">{f.fileName}</span>
              </button>
            </Tooltip>
          ))}
          {fileTiles.length === 0 && (
            <p className="exr-side-empty">No files with extracted text yet.</p>
          )}
        </div>
      </aside>

      <div className="exr-main" ref={mainRef}>
        {items.length === 0 ? (
          <div className="exr-empty">
            <span className="exr-empty-icon">{ExtractionsIcon({ width: 30, height: 30 })}</span>
            <h3>No extracted text</h3>
            <p>Open an image in the Doc Viewer and use “Extract text” to collect snippets — they’ll show up here, grouped by file.</p>
          </div>
        ) : isAll ? (
          // All-files view: one section per consecutive same-file run. The
          // origin tile sticks to the top of the scroll while its section is in
          // view, then the next section's tile takes over (sticky inside a
          // full-height group cell).
          <div className="exr-history-list is-all">
            {groups.map((g) => {
              const groupKey = `${g.filePath}:${g.items[0].id}`;
              return (
              <section
                className={`exr-group${currentGroupKey === groupKey ? ' is-current' : ''}`}
                data-group-key={groupKey}
                key={groupKey}
              >
                <div className="exr-group-origin">
                  <Tooltip content={g.filePath}>
                    <button
                      type="button"
                      className="exr-railtile"
                      onClick={() => localFolderApi.showInFolder?.(g.filePath)}
                    >
                      <span className="exr-railtile-thumb">
                        <FileThumbnail descriptor={descByPath.get(g.filePath)} />
                      </span>
                      <span className="exr-railtile-name">{g.fileName}</span>
                    </button>
                  </Tooltip>
                </div>
                <div className="exr-group-items">
                  {g.items.map(renderItem)}
                </div>
              </section>
              );
            })}
          </div>
        ) : (
          <div className="exr-history-list">
            {items.map(renderItem)}
          </div>
        )}
      </div>
    </div>
  );
}
