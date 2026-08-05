// Small base64 stills of images and video, for the AI file search's VISION
// pass — the thing that lets "car crash" match a photo of a car crash rather
// than only a file called `car-crash.jpg`.
//
// This is the one place in the app that sends picture CONTENT off the machine,
// so it's deliberately frugal about what leaves: each file is decoded locally,
// drawn to a canvas at a small max edge and re-encoded as a lossy JPEG. What
// goes up is a postcard — enough for "is this a collision?", not a usable copy
// of the original. Nothing is uploaded unless the user runs an AI search.
//
// Decoding happens through a Blob object URL (not localfile:// directly), so
// the canvas stays same-origin and untainted and toDataURL works.

import { readLocalBlob } from './localFolder';

// Long edge of the encoded still. 512 is about the floor where a model can
// still read a scene; going bigger multiplies image tokens for little gain.
const MAX_SIDE = 512;
const JPEG_QUALITY = 0.6;

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;   // formats a <img> can decode
const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)$/i;           // …and <video> can

// Encoded stills, keyed by path, invalidated by size+mtime. Bounded because
// each entry is a base64 string of a few tens of KB.
const MAX_CACHED = 60;
const cache = new Map();

export function isVisualFile(name) {
  return IMAGE_RE.test(name || '') || VIDEO_RE.test(name || '');
}

function versionKey(file) {
  return `${file?.sizeBytes ?? '?'}:${file?.mtimeIso ?? '?'}`;
}

// Draw whatever was decoded (an <img> or a <video> frame) at a bounded size.
function drawScaled(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // A JPEG has no alpha; without this, transparent PNGs come out black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(drawScaled(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

// One representative frame. Seeks a little way in — frame 0 of a video is very
// often a black or title frame that tells the model nothing.
function decodeVideoFrame(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; video.src = ''; fn(arg); } };
    video.muted = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const t = Number.isFinite(video.duration) && video.duration > 2 ? Math.min(3, video.duration * 0.1) : 0;
      video.currentTime = t;
    };
    video.onseeked = () => {
      try { done(resolve, drawScaled(video, video.videoWidth, video.videoHeight)); }
      catch (err) { done(reject, err); }
    };
    video.onerror = () => done(reject, new Error('video decode failed'));
    // Codecs Chromium can't play (a lot of .mkv) never fire either handler.
    setTimeout(() => done(reject, new Error('video decode timed out')), 6000);
    video.src = url;
  });
}

// Returns { media_type, data } (base64, no data: prefix) or null when the file
// can't be decoded — an unsupported codec, a corrupt image, a format the
// browser doesn't know. Callers treat null as "describe it by name instead".
export async function encodeVisualThumb(file) {
  const path = file?.path;
  if (!path || !isVisualFile(file.name)) return null;
  const key = versionKey(file);
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.thumb;

  let url = null;
  let thumb = null;
  try {
    const blob = await readLocalBlob(path);
    if (blob) {
      url = URL.createObjectURL(blob);
      const dataUrl = VIDEO_RE.test(file.name) ? await decodeVideoFrame(url) : await decodeImage(url);
      const comma = dataUrl.indexOf(',');
      if (comma > 0) thumb = { media_type: 'image/jpeg', data: dataUrl.slice(comma + 1) };
    }
  } catch {
    thumb = null;   // cached as a miss so a broken file isn't retried each keystroke
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  cache.set(path, { key, thumb });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return thumb;
}
