import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getCachedPdf } from '../lib/pdfCache';
import { loadPdfModule } from '../lib/pdfWorker';
import Tooltip from './Tooltip';

// Preview renderer for the FileDetailModal's preview pane.
// Dispatches by MIME to one of:
//   • <ImagePreview>  — image/*           (<img> of the original)
//   • <VideoPreview>  — video/*           (native <video controls> of the original)
//   • <PdfPreview>    — application/pdf   (pdf.js renders page 1 of the original)
//   • <TextPreview>   — text/*            (fetched body, capped at 1 MB)
// Anything else renders a fallback "no preview" panel with a hint to
// use the View button in the right pane.
//
// signedUrl is the 10-minute signed URL for the source file. onOpen is
// the modal's handleView callback — fired when the user clicks the
// preview pane so the whole preview reads as a "tap to open" surface.

// Hard cap on text preview fetch — a giant log file would lock the
// modal otherwise. The fallback message points the user at View, which
// downloads the full file via the same signed URL.
const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

// External-link arrow used inside the hover-revealed "Open" hint pill.
// Inline so we don't pull an icon dep for one glyph.
const OpenIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

// Wrap a child node in a clickable surface that opens the full file
// when activated. Centralised so every sub-renderer gets the same
// hover hint, focus ring, and keyboard semantics. The hint pill is
// pinned in the corner via the stylesheet — only visible on hover or
// keyboard focus so it doesn't clutter the preview itself.
//
// When `onOpen` is null (e.g. DOCX in the version-control inspector,
// where opening the file would trigger a browser download rather than
// an inline view), render children directly with no button wrapper —
// the preview pane stays purely visual.
function ClickablePreview({ onOpen, children, ariaLabel }) {
  if (!onOpen) return children;
  return (
    <Tooltip content="Click to open">
      <button
        type="button"
        className="file-preview-clickable"
        onClick={onOpen}
        aria-label={ariaLabel}
      >
        {children}
        <span className="file-preview-open-hint">
          {OpenIcon}
          <span>Open</span>
        </span>
      </button>
    </Tooltip>
  );
}

// Generic "no preview" panel — used for unsupported MIMEs AND as the
// error fallback for the type-specific renderers when something goes
// wrong (pdf.js worker fails, video codec unsupported, etc.). Hint
// directs the user to the right-pane View action.
function NoPreview({ reason, canOpen = true }) {
  return (
    <div className="file-preview-empty">
      <p className="file-preview-empty-title">No preview available</p>
      {reason && <p className="file-preview-empty-reason">{reason}</p>}
      {canOpen && (
        <p className="file-preview-empty-hint">Use the <strong>View</strong> button to open the file in a new tab.</p>
      )}
    </div>
  );
}

// ── Image ────────────────────────────────────────────────────────────────
function ImagePreview({ signedUrl, file, onOpen }) {
  const [errored, setErrored] = useState(false);
  if (errored) return <NoPreview reason={`Image failed to load: ${file.name}`} />;
  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-image">
        <img
          src={signedUrl}
          alt={file.name}
          onError={() => setErrored(true)}
          draggable={false}
        />
      </div>
    </ClickablePreview>
  );
}

// ── Video ────────────────────────────────────────────────────────────────
// Mounts a native <video controls> element with the original file. NOT
// wrapped in ClickablePreview because the click-to-open surface would
// intercept the native play/pause/scrub controls.
function VideoPreview({ signedUrl }) {
  if (!signedUrl) return <div className="file-preview-loading">Loading video…</div>;
  return (
    <div className="file-preview-video">
      <video src={signedUrl} controls preload="metadata" />
    </div>
  );
}

// ── PDF ──────────────────────────────────────────────────────────────────
// Renders page 1 of the original PDF via pdf.js to a canvas. No thumbnail
// fast-paint layer — the canvas is the only display surface, and a
// "Loading PDF…" string shows while pdf.js parses and renders.
function PdfPreview({ signedUrl, file, onOpen }) {
  const canvasRef = useRef(null);
  // A transparent copy of the page's text, positioned over the canvas. The
  // canvas is pixels — nothing in it can be selected, searched or read by a
  // screen reader — so pdf.js's text layer is what makes a PDF behave like a
  // document rather than a picture of one. The Doc Viewer's find bar walks
  // exactly these nodes.
  const textLayerRef = useRef(null);
  const containerRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  // True once pdf.js has finished its first render. Drives the canvas
  // fade-in; stays true for the lifetime of the component so a
  // resize-reflow doesn't bounce visibility.
  const [pdfPainted, setPdfPainted] = useState(false);

  // Load the document via the module-level LRU cache (src/lib/pdfCache.js).
  // First open: pdf.js fetches + parses, result is cached. Second-and-
  // subsequent opens of the same file: cache hit, near-zero latency.
  // Skips the work entirely while signedUrl is still null — lets the
  // thumbnail paint immediately even before the signed URL resolves.
  //
  // Cleanup intentionally does NOT call doc.destroy(): the cache owns the
  // handle's lifetime via LRU eviction. Destroying on every unmount would
  // defeat the cache (next reopen of the same file would re-parse).
  useEffect(() => {
    if (!signedUrl) return undefined;
    let cancelled = false;
    pdfRef.current = null;
    setLoading(true);
    setError(null);
    setPdfPainted(false);

    (async () => {
      try {
        const pdf = await getCachedPdf(file.storage_path, signedUrl);
        if (cancelled) return;
        pdfRef.current = pdf;
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load PDF');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      pdfRef.current = null;  // cache keeps the doc alive; just drop our ref
    };
  }, [signedUrl, file.storage_path]);

  // Debounced container-size tracking — same pattern the old paginator
  // used; without the 150ms debounce a resize-drag stacks render
  // cancellations and the canvas flashes blank.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer = null;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setContainerSize({ w: width, h: height }), 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Render page 1 whenever the pdf handle resolves or the pane resizes.
  // `loading` is in the deps so the effect re-fires the moment the
  // pdf finishes loading — that's the render where the <canvas>
  // actually mounts (it's gated on !loading in the JSX below), so
  // before that flip canvasRef.current is null and the effect's
  // early-return is hit. Without this dep the canvas mounts but the
  // render never happens and the user sees a blank pane forever.
  // Cancels any in-flight render before starting a new one —
  // RenderingCancelledException is expected and swallowed.
  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    if (containerSize.w === 0 || containerSize.h === 0) return;

    let cancelled = false;
    (async () => {
      try {
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
          renderTaskRef.current = null;
        }
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitW = containerSize.w;
        const fitH = containerSize.h;
        const scale = Math.min(fitW / baseViewport.width, fitH / baseViewport.height);
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });

        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const task = page.render({ canvasContext: ctx, viewport, canvas });
        renderTaskRef.current = task;
        await task.promise;
        if (renderTaskRef.current === task) renderTaskRef.current = null;
        if (!cancelled) setPdfPainted(true);

        // Text layer, at CSS scale (the canvas is oversampled by dpr; the
        // overlay is not). Best-effort: a PDF that is pure scanned image has no
        // text content, and a failure here must never cost the rendered page.
        const layer = textLayerRef.current;
        if (layer && !cancelled) {
          layer.replaceChildren();
          try {
            const cssViewport = page.getViewport({ scale });
            layer.style.width = `${Math.round(cssViewport.width)}px`;
            layer.style.height = `${Math.round(cssViewport.height)}px`;
            layer.style.setProperty('--scale-factor', String(scale));
            const pdfjs = await loadPdfModule();
            if (cancelled) return;
            const textContent = await page.getTextContent();
            if (cancelled) return;
            if (pdfjs.TextLayer) {
              await new pdfjs.TextLayer({ textContentSource: textContent, container: layer, viewport: cssViewport }).render();
            } else if (pdfjs.renderTextLayer) {
              await pdfjs.renderTextLayer({ textContentSource: textContent, container: layer, viewport: cssViewport }).promise;
            }
          } catch { /* no text in this PDF, or an older pdf.js — the page still renders */ }
        }
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException' && !cancelled) {
          setError(err?.message || 'Failed to render page');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [containerSize, loading]);

  if (error) return <NoPreview reason={error} />;

  return (
    <ClickablePreview onOpen={onOpen} ariaLabel={`Open ${file.name}`}>
      <div className="file-preview-pdf-static" ref={containerRef}>
        <div className="file-preview-pdf-stack">
          <canvas
            ref={canvasRef}
            className={`file-preview-pdf-canvas${pdfPainted ? ' is-visible' : ''}`}
          />
          <div className="file-preview-pdf-text" ref={textLayerRef} aria-hidden="true" />
        </div>
        {!pdfPainted && (
          <div className="file-preview-loading">Loading PDF…</div>
        )}
      </div>
    </ClickablePreview>
  );
}

// ── Text ─────────────────────────────────────────────────────────────────
// Fetches the file body as text, capped at 1 MB. Markdown gets piped
// through ReactMarkdown (same dep the rest of the app uses for release
// notes etc.); everything else renders in a <pre> with word-break so
// long lines wrap inside the pane.
//
// Text previews are NOT click-to-open — the rendered text is itself the
// thing the user came to read, so we keep the existing scrollable
// content and let the right-pane View button serve the "open the file"
// intent.
function TextPreview({ signedUrl, file }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setTooLarge(false);

    // Pre-flight HEAD-like check via the file row's known size. We
    // already have file.size_bytes from the metadata — no need to
    // round-trip just to know if it's too big.
    if ((file.size_bytes || 0) > TEXT_PREVIEW_MAX_BYTES) {
      setTooLarge(true);
      return undefined;
    }

    (async () => {
      try {
        const res = await fetch(signedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (cancelled) return;
        // Defence in depth: if the metadata's size_bytes was wrong /
        // stale (unlikely — we set it at upload time from File.size),
        // truncate so the DOM doesn't choke on a runaway file.
        if (text.length > TEXT_PREVIEW_MAX_BYTES) {
          setTooLarge(true);
          return;
        }
        setContent(text);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Failed to load text');
      }
    })();

    return () => { cancelled = true; };
  }, [signedUrl, file.size_bytes]);

  if (tooLarge) return <NoPreview reason="File is too large to preview (over 1 MB)." />;
  if (error)    return <NoPreview reason={error} />;
  if (content == null) return <div className="file-preview-loading">Loading text…</div>;

  const isMarkdown = file.mime_type === 'text/markdown' || /\.md$/i.test(file.name);

  return (
    <div className="file-preview-text">
      {isMarkdown ? (
        <div className="file-preview-text-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="file-preview-text-pre">{content}</pre>
      )}
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────
// Previews are intentionally limited to image / video / PDF / text.
// DOCX (and other document formats) used to round-trip through a
// rasterized "rich render" of their text; that's been removed — the
// rendering was approximate, mismatched the real document, and the
// generator was a maintenance burden. DOCX now falls into NoPreview.
export default function FilePreview({ file, signedUrl, onOpen }) {
  if (!file) return null;

  const t = file.mime_type || '';

  // Both PDF and Video wait on signedUrl internally — PdfPreview gates
  // its pdf.js parse on it; VideoPreview shows a loading message until
  // it arrives, then mounts the native <video>.
  if (t === 'application/pdf') return <PdfPreview   file={file} signedUrl={signedUrl} onOpen={onOpen} />;
  if (t.startsWith('video/'))  return <VideoPreview signedUrl={signedUrl} />;

  // Everything else needs the signed URL before it can show anything.
  if (!signedUrl) {
    return <div className="file-preview-loading">Loading preview…</div>;
  }
  if (t.startsWith('image/'))  return <ImagePreview file={file} signedUrl={signedUrl} onOpen={onOpen} />;
  if (t.startsWith('text/'))   return <TextPreview  file={file} signedUrl={signedUrl} />;
  return <NoPreview reason={`No preview for ${t || 'this file type'}.`} canOpen={Boolean(onOpen)} />;
}
