import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildCandidates,
  generate,
  isKnownBad,
  noteCandidateFailure,
  peek,
  retain,
  release,
} from '../lib/thumbnailEngine';
import { describeLooseFile } from '../lib/thumbnailDescriptor';
import { glyphForFile } from './fileGlyph';
import { useAppPrefs } from '../context/AppPrefsContext';

// Paints one file's thumbnail. All the decisions live in lib/thumbnailEngine.js;
// this component walks the candidate list that engine produces:
//
//   candidate 0 (usually `localfile://…?thumb=256`) → <img src>
//        │ onError
//        ▼
//   candidate 1 (the original bytes, images only)   → <img src>
//        │ onError
//        ▼
//   candidate 2 ('generate' — pdf.js / video frame / PPTX preview, queued)
//        │ null
//        ▼
//   the file's type glyph
//
// Walking a list is the whole reliability fix: a failed load moves FORWARD to a
// different source instead of re-running the resolution that just failed (which
// is what made thumbnails flap between broken and glyph). Each step is a normal
// <img> load, so a file can only ever cost as many requests as it has
// candidates — no loops, no retry storms.
//
// Two prop shapes:
//   <FileThumbnail descriptor={…} />                        (preferred)
//   <FileThumbnail mimeType= name= sourceUrl= glyph= />      (loose props)

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export default function FileThumbnail(props) {
  const {
    descriptor: incoming,
    glyph: glyphProp,
    duration: durationProp,
    // Loose props.
    mimeType,
    name,
    sourceUrl,
  } = props;

  const descriptor = useMemo(
    () => incoming || describeLooseFile({ name: name || '', mime: mimeType || '', url: sourceUrl || null }),
    // Loose props are primitives, so this only rebuilds when they really change.
    [incoming, name, mimeType, sourceUrl],
  );

  const key = descriptor?.contentKey || null;
  const { prefs } = useAppPrefs();
  const enabled = prefs.thumbnails !== false;

  // Everything downstream keys on contentKey, NOT descriptor identity. The
  // Files page rebuilds its item models (and their descriptors) on every
  // render, so memoising on the object would rebuild the candidate list each
  // time and restart the generate effect in a loop.
  const descRef = useRef(descriptor);
  descRef.current = descriptor;
  const candidates = useMemo(
    () => (enabled ? buildCandidates(descRef.current) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, enabled],
  );

  // Index into `candidates`. Reset whenever the file changes.
  const [step, setStep] = useState(0);
  // URL produced by a 'generate' candidate (a blob: we hold a reference to).
  const [madeUrl, setMadeUrl] = useState(() => (enabled ? peek(key) : null));
  useEffect(() => {
    setStep(0);
    setMadeUrl(enabled ? peek(key) : null);
  }, [key, enabled]);

  // Generation is the expensive path, so it only starts once the tile is near
  // the viewport. (<img> candidates need no gating — loading="lazy" already
  // defers those, and they cost nothing until the browser wants them.)
  const [visible, setVisible] = useState(false);
  const observerRef = useRef(null);
  // Callback ref: the painted element swaps between <img> and the glyph, so
  // re-observe whatever is currently mounted.
  const nodeRef = useCallback((node) => {
    if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
    if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
        observerRef.current = null;
      }
    }, { rootMargin: '300px' });
    io.observe(node);
    observerRef.current = io;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const current = candidates[step] || null;

  // Run the 'generate' candidate when we reach it. Refcount the resulting blob
  // URL for as long as this component paints it, so cache eviction can never
  // revoke a URL that's on screen.
  useEffect(() => {
    if (!current || current.kind !== 'generate' || !visible || !enabled) return undefined;
    if (isKnownBad(key)) { setStep((s) => s + 1); return undefined; }
    let alive = true;
    let held = null;
    generate(descRef.current).then((url) => {
      if (!alive) return;
      if (url) {
        retain(key);
        held = key;
        setMadeUrl(url);
      } else {
        setStep((s) => s + 1);   // out of options → glyph
      }
    });
    return () => {
      alive = false;
      if (held) release(held);
    };
  }, [current, visible, enabled, key]);

  // A painted URL failed to load → move to the next candidate. Never retries
  // the same source, so this can't loop. When it's the OS-thumbnail candidate
  // that failed, re-read which formats this machine can't thumbnail at all, so
  // the next tile of that type doesn't repeat a doomed request.
  const handleError = () => {
    noteCandidateFailure(current, descRef.current);
    setStep((s) => s + 1);
  };

  const glyph = glyphProp || glyphForFile(descriptor?.mime || '', descriptor?.name);
  const duration = durationProp ?? descriptor?.duration ?? null;

  let src = null;
  if (enabled && current) {
    if (current.kind === 'url') src = current.url;
    else if (current.kind === 'generate') src = madeUrl;
  }

  return (
    <>
      {src ? (
        <img
          ref={nodeRef}
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={handleError}
        />
      ) : (
        <span ref={nodeRef} className="project-files-icon">{glyph}</span>
      )}
      {duration ? (
        <span className="project-files-duration" aria-hidden="true">
          {formatDuration(duration)}
        </span>
      ) : null}
    </>
  );
}
