import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
// Cursor coords are viewport px; the CSS lengths we set (--spot-x/y, the rail
// width) are layout px — under the app's CSS-zoom downscale the two differ
// (see lib/appZoom).
import { toLayoutPx } from '../../lib/appZoom';
import { miniHeaderSpot } from '../../lib/miniHeaderSpot';
import MiniHeaderFade from '../../components/MiniHeaderFade';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { usePaneChromeSlot, usePaneChromePortalEl, usePaneChromeFooterEl } from '../../context/PaneChromeContext';
import { useAuth } from '../../context/AuthContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useChatUnread } from '../../context/ChatUnreadContext';
import { listMembers } from '../../lib/projects';
import { supabase } from '../../lib/supabaseClient';
import {
  listChatMessages,
  sendChatMessage,
  editChatMessage,
  deleteChatMessage,
  subscribeChatMessages,
  listReactionsForProject,
  toggleReaction,
  subscribeReactions,
  listProjectReplies,
  sendThreadReply,
  setChatMessagePin,
} from '../../lib/chat';
import { readCachedChat, writeCachedChat } from '../../lib/chatCache';
import {
  listPrivateMessages,
  sendPrivateMessage,
  subscribePrivateMessages,
} from '../../lib/privateMessages';
import Tooltip from '../../components/Tooltip';
import { useMorphPill } from '../../components/useMorphPill';
import { openFileWindow, openDocx, isDocxFile, canOpenInApp } from '../../lib/platform';
import { useChatFind } from '../../lib/useChatFind';
import './ProjectScoped.css';
import './ProjectChatVariantB.css';

// Platform hint for the search shortcut chip (⌘F on macOS, Ctrl F elsewhere) —
// matches the Files toolbar search.
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');

// Per-project chat — Variant B "Split Pane" (ported from the Claude
// Design handoff). Two top tabs share the page: Team (realtime project
// thread) and Private (1:1 DMs). The Team tab is a split pane: the
// message thread on the left and a collapsible right rail with
// sub-tabs (Pinned / Threads / Mentions / Files).
//
// The data layer underneath is unchanged from the wiring pass:
//   - Team thread: load + realtime echo (chat_messages), send / edit /
//     delete, @mention resolution + popover, file attachments,
//     typing-indicator broadcast, scroll/unread bookkeeping.
//   - Variant-B extras: reactions, threaded replies (loaded into the
//     rail), pins (set_chat_message_pin RPC), header search filter,
//     per-message "jump to" refs.
//   - Private DMs: per-partner thread load + realtime + send.
//
// All visual classes are `dvx-` (shared primitives) / `vb-` (Variant B
// layout) and live in ProjectChatVariantB.css — they don't collide with
// the legacy `project-chat-`/`chat-` classes in ProjectChat.css (still
// used by ProjectAI). Colours all route through tokens.css.

// ───── Helpers ──────────────────────────────────────────────────────

function displayName(profile) {
  if (!profile) return 'Unknown';
  return profile.full_name || profile.name || profile.email || 'Unknown';
}

// ───── Time / format helpers ────────────────────────────────────────
function formatHM(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function sameLocalDay(a, b) {
  if (!a || !b) return false;
  return new Date(a).toDateString() === new Date(b).toDateString();
}
function formatDayLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  const diffDays = (now - d) / 86400000;
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
function relativeShort(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fileExt(name) {
  const dot = (name || '').lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE';
}

// 12-colour palette (djb2 hash) — deterministic per-id avatar / file
// accent, matching the AuthorAvatar pattern used elsewhere in the app.
const AUTHOR_COLORS = [
  '#22c55e', '#ef4444', '#a855f7', '#facc15',
  '#3b82f6', '#ec4899', '#14b8a6', '#f97316',
  '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e',
];
function hashColor(id) {
  if (!id) return AUTHOR_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}
const STATUS_COLORS = { online: '#22c55e', away: '#f59e0b', dnd: '#ef4444' };

// Emoji set offered by the reaction picker — small, common, no picker dep.
const REACTION_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏', '🔥', '✅'];

// ───── Inline icons (no icon lib — mirrors the design's Icon set) ───
const Icon = {
  Search: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>),
  Hash: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></svg>),
  Lock: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>),
  Headset: (p) => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3z" /><path d="M3 19a2 2 0 0 0 2 2h1v-6H3z" /></svg>),
  Pin: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 17v5" /><path d="M9 10.76V6a3 3 0 0 1 3-3 3 3 0 0 1 3 3v4.76a2 2 0 0 0 .59 1.42l1.41 1.41A2 2 0 0 1 17 15a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2 2 2 0 0 1 .59-1.41l1.41-1.41A2 2 0 0 0 9 10.76Z" /></svg>),
  Thread: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>),
  At: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></svg>),
  Paperclip: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.99 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>),
  Reply: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>),
  /* Up-arrow rather than a paper plane: the plane is a "mail it somewhere"
     metaphor, and this posts a message into a thread that's right there. The
     arrow points at where the message lands. */
  Send: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>),
  More: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" /></svg>),
  Plus: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>),
  Bell: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>),
  Close: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>),
  Arrow: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>),
  Menu: (p) => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>),
  Check: (p) => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="20 6 9 17 4 12" /></svg>),
  Pencil: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>),
  Trash: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>),
  Copy: (p) => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>),
};

// ───── Avatar (image when available, else colour-hashed initial) ────
function VbAvatar({ profile, authorId, size = 32, showStatus = false }) {
  const url = profile?.avatar_url;
  const initial = (displayName(profile) || '?').charAt(0).toUpperCase();
  const statusColor = STATUS_COLORS[profile?.status];
  return (
    <span className="dvx-avatar-wrap" style={{ width: size, height: size }}>
      <span
        className="dvx-avatar"
        style={{ width: size, height: size, background: url ? 'transparent' : hashColor(authorId), fontSize: Math.round(size * 0.42) }}
      >
        {url ? <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} /> : initial}
      </span>
      {showStatus && statusColor && (
        <span className="dvx-avatar-status" style={{ background: statusColor, borderColor: 'var(--bg-card)' }} />
      )}
    </span>
  );
}

// ───── Attachment card (thumb card, or compact pill) ────────────────
function VbAttachment({ file, compact = false, onOpen }) {
  if (!file) return null;
  const ext = fileExt(file.name);
  const color = hashColor(file.id || file.name);
  if (compact) {
    return (
      <Tooltip content={file.name}>
        <button type="button" className="dvx-attach-pill" onClick={onOpen ? () => onOpen(file) : undefined}>
          <span className="dvx-attach-pill-ext" style={{ background: color }}>{ext}</span>
          <span className="dvx-attach-pill-name">{file.name}</span>
          <span className="dvx-attach-pill-size">{formatBytes(file.size_bytes)}</span>
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={file.name}>
      <button type="button" className="dvx-attach-card" onClick={onOpen ? () => onOpen(file) : undefined}>
        <span className="dvx-attach-thumb" style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)` }}>
          <span className="dvx-attach-ext">{ext}</span>
        </span>
        <span className="dvx-attach-meta">
          <span className="dvx-attach-name">{file.name}</span>
          <span className="dvx-attach-size">{formatBytes(file.size_bytes)}</span>
        </span>
      </button>
    </Tooltip>
  );
}

// Shared frozen empty array so message rows with no replies receive a
// stable prop reference (a fresh `[]` per render would defeat React.memo
// and re-render every reply-less row on each parent commit).
const EMPTY_REPLIES = [];

// ───── Message edit box (local-state child) ─────────────────────────
// Editing keystrokes stay inside this component so the rest of the
// message list never re-renders while you type an edit. Mounts focused
// with the caret at the end.
function MessageEditBox({ initialBody, onSave, onCancel }) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef(null);
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    const len = initialBody?.length || 0;
    ta.setSelectionRange(len, len);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="vb-edit">
      {/* Reuse the real .vb-msg-bubble (gets the is-mine accent from the
          parent .vb-msg.is-mine) so the bubble looks identical to view mode.
          The textarea sits in an auto-grow box (a hidden ::after replicates
          the text) so the bubble scales to its content — width AND height —
          exactly like a real message bubble. */}
      <div className="vb-msg-bubble vb-edit-bubble">
        <div className="vb-edit-grow" data-value={body}>
          <textarea
            className="vb-edit-textarea"
            ref={ref}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(body); }
              else if (e.key === 'Escape') { onCancel(); }
            }}
            rows={1}
          />
        </div>
        {/* Actions live inside the bubble, in the same section as the input. */}
        <div className="vb-edit-actions">
          <button type="button" className="vb-edit-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="vb-edit-btn vb-edit-btn-primary" onClick={() => onSave(body)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ───── Team message row (memoized) ──────────────────────────────────
// A single message in the team thread. Memoized so a parent re-render
// (new message arriving, reactions changing, someone typing, the search
// box / thread-reply box updating) only re-renders the rows whose props
// actually changed — not the whole list. All callbacks it receives are
// stable (useCallback in the parent); per-message UI state (isEditing) is
// passed as a boolean so non-edited rows get referentially identical props
// across commits and skip rendering. Per-message actions live in the shared
// morph pill (useMorphPill): hover shows a cursor "right-click for options"
// pill, which morphs into a dropdown of reactions / reply / pin / copy /
// edit / delete — same interaction + styling as the Files tab.
const TeamMessageRow = React.memo(function TeamMessageRow({
  msg, showDay, grouped, viewerId, memberById, fileById, rmap, replies,
  isEditing, renderBody, msgRefs,
  onToggleReaction, onAttachmentClick, onSaveEdit, onCancelEdit,
  onStartEdit, onDelete, onCopy,
}) {
  const author = memberById.get(msg.author_id);
  const isMine = msg.author_id === viewerId;
  const mentionsMe = !msg.deleted_at && (msg.mentions || []).includes(viewerId);
  const hasReactions = rmap && rmap.size > 0;
  const isPinned = Boolean(msg.pinned_at);
  const canAct = !msg.deleted_at; // tombstones have no actions / hint
  const hasBody = Boolean((msg.body || '').trim());

  // Morph pill — hover tooltip → right-click dropdown (Files-tab pattern).
  // The emoji quick-react strip rides in the menu header slot; delete uses
  // the pill's built-in confirm step instead of a window.confirm.
  const morph = useMorphPill({
    hoverContent: 'Right-click for options',
    menuHeader: (close) => (
      <div className="vb-morph-reactions">
        {REACTION_EMOJIS.map((em) => (
          <button
            key={em}
            type="button"
            className="vb-morph-emoji"
            onClick={() => { onToggleReaction(msg.id, em); close(); }}
          >
            {em}
          </button>
        ))}
      </div>
    ),
    menuItems: [
      hasBody && { key: 'copy', label: 'Copy text', onClick: () => onCopy(msg.body) },
      isMine && { key: 'edit', label: 'Edit message', onClick: () => onStartEdit(msg) },
      isMine && {
        key: 'delete',
        label: 'Delete message',
        danger: true,
        onClick: () => onDelete(msg),
        confirm: {
          title: 'Delete this message?',
          message: "This can't be undone.",
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        },
      },
    ],
  });

  return (
    <React.Fragment>
      {showDay && (
        <div className="dvx-day-divider" role="separator">
          <span className="dvx-day-divider-label">{formatDayLabel(msg.created_at)}</span>
        </div>
      )}
      <div
        ref={(el) => { if (el) msgRefs.current[msg.id] = el; else delete msgRefs.current[msg.id]; }}
        className={`dvx-msg-row vb-msg${isMine ? ' is-mine' : ''}${mentionsMe ? ' mentions-me' : ''}${hasReactions ? ' has-reactions' : ''}${grouped ? ' is-grouped' : ''}`}
      >
        {!isMine && (
          grouped
            // Empty spacer keeps the bubble aligned under the run's avatar.
            ? <div className="vb-msg-avatar" aria-hidden="true" />
            : (
              <div className="vb-msg-avatar">
                <VbAvatar profile={author?.profile} authorId={msg.author_id} size={32} showStatus />
              </div>
            )
        )}
        <div className="vb-msg-body">
          {!isMine && !grouped && (
            <div className="vb-msg-meta">
              <span className="vb-msg-author">{displayName(author?.profile)}</span>
              <span className="vb-msg-time">{formatHM(msg.created_at)}</span>
              {isPinned && <span className="vb-msg-pin"><Icon.Pin /></span>}
            </div>
          )}

          {isEditing ? (
            <MessageEditBox
              initialBody={msg.body || ''}
              onSave={(body) => onSaveEdit(msg.id, body)}
              onCancel={onCancelEdit}
            />
          ) : (
            <div
              className="vb-msg-bubble"
              onMouseMove={canAct ? morph.handleMouseMove : undefined}
              onMouseLeave={canAct ? morph.handleMouseLeave : undefined}
              onContextMenu={canAct ? morph.handleContextMenu : undefined}
            >
              <span className="vb-msg-text">{renderBody(msg)}</span>
              {!msg.deleted_at && (msg.attached_file_ids || []).length > 0 && (
                <div className="vb-msg-attachments">
                  {msg.attached_file_ids.map((fid) => {
                    const f = fileById.get(fid);
                    return f ? (
                      <VbAttachment key={fid} file={f} onOpen={onAttachmentClick} />
                    ) : (
                      <span key={fid} className="dvx-attach-pill is-missing">
                        <span className="dvx-attach-pill-name">File no longer available</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {/* Time under the bubble (like the AI chat) — no delivery ticks. */}
          {isMine && !msg.deleted_at && !isEditing && !grouped && (
            <span className="vb-msg-time-under">
              {formatHM(msg.created_at)}
              {msg.edited_at && <span className="vb-msg-edited"> · edited</span>}
            </span>
          )}

          {hasReactions && (
            <div className={`dvx-reactions${isMine ? ' dvx-reactions-right' : ''}`}>
              {Array.from(rmap.entries()).map(([emoji, info]) => (
                <button
                  key={emoji}
                  type="button"
                  className={`dvx-reaction${info.mine ? ' is-mine' : ''}`}
                  onClick={() => onToggleReaction(msg.id, emoji)}
                >
                  <span className="dvx-reaction-emoji">{emoji}</span>
                  <span className="dvx-reaction-count">{info.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* The reply-thread pill was removed with the rail feature. */}
        </div>
      </div>
      {/* Portalled morph pill — sibling of the row so menu clicks don't
          bubble back into the row's handlers. */}
      {morph.node}
    </React.Fragment>
  );
});

// ───── Team composer (local-state child) ────────────────────────────
// Owns the draft text + mention/attach popovers + send. Keeping this
// state OUT of ProjectChat means typing a message re-renders only the
// composer, never the message list above it (the previous source of the
// per-keystroke lag). Memoized so an incoming message / reaction in the
// parent doesn't re-render the composer either. On a successful send it
// hands the new row up via onSent so the parent does its optimistic
// insert + scroll-to-bottom.
const TeamComposer = React.memo(function TeamComposer({
  projectId, viewerId, projectName, members, memberById,
  notify, broadcastTyping, onSent,
}) {
  const [draft, setDraft] = useState('');
  const [draftMentions, setDraftMentions] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const textareaRef = useRef(null);

  // @mention popover state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const mentionTokenRef = useRef(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // Look for an in-progress @<word> token just before the caret and, if
  // present, open the mention popover with the partial-name query.
  const inspectCaretForMention = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) { setMentionOpen(false); mentionTokenRef.current = null; return; }
    const charBefore = at === 0 ? ' ' : before[at - 1];
    if (!/\s/.test(charBefore) && charBefore !== '\n') {
      setMentionOpen(false); mentionTokenRef.current = null; return;
    }
    const after = before.slice(at + 1);
    if (/\s/.test(after)) {
      setMentionOpen(false); mentionTokenRef.current = null; return;
    }
    setMentionOpen(true);
    setMentionQuery(after.toLowerCase());
    mentionTokenRef.current = { start: at, end: caret };
    setMentionIndex(0);
  }, []);

  const handleDraftChange = (e) => {
    setDraft(e.target.value);
    requestAnimationFrame(inspectCaretForMention);
    broadcastTyping();
  };

  // Filtered member list for the @mention popover.
  const mentionResults = useMemo(() => {
    if (!mentionOpen) return [];
    const q = mentionQuery;
    return (members || [])
      .filter((m) => {
        const n = displayName(m.profile).toLowerCase();
        const e = (m.profile?.email || '').toLowerCase();
        return q === '' || n.includes(q) || e.includes(q);
      })
      .slice(0, 6);
  }, [members, mentionOpen, mentionQuery]);

  const pickMention = (member) => {
    const name = displayName(member.profile);
    const token = mentionTokenRef.current;
    if (!token) return;
    const before = draft.slice(0, token.start);
    const after = draft.slice(token.end);
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setDraft(next);
    setDraftMentions((prev) => new Set([...prev, member.user_id]));
    setMentionOpen(false);
    mentionTokenRef.current = null;
    const caret = before.length + inserted.length;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); }
    });
  };

  // Send the draft.
  const handleSend = async () => {
    if (sending || !projectId || !viewerId) return;
    const body = draft.trim();
    if (!body) return;
    // Filter mentions to only those whose @<name> still appears in the
    // body — handles the backspace-out-of-token case.
    const finalMentions = Array.from(draftMentions).filter((uid) => {
      const m = memberById.get(uid);
      if (!m) return false;
      return body.includes(`@${displayName(m.profile)}`);
    });
    // Clear the input up-front so you can keep typing the next message
    // immediately (the textarea isn't disabled). The send proceeds with
    // the captured body.
    setDraft('');
    setDraftMentions(new Set());
    setMentionOpen(false);
    setSending(true);
    const { data, error } = await sendChatMessage({
      projectId,
      authorId: viewerId,
      body,
      mentions: finalMentions,
    });
    setSending(false);
    if (error) {
      // Restore the failed message — unless a new draft was started meanwhile.
      setDraft((cur) => (cur ? cur : body));
      setDraftMentions((cur) => (cur.size ? cur : new Set(finalMentions)));
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Send failed',
        body: error.message || 'Try again in a moment.',
        dedupeKey: `chat-send-error:${Date.now()}`,
      });
      return;
    }
    onSent?.(data);
  };

  // Files dragged from the Files tab carry a docvex payload. Chat attachments
  // have no storage backend (removed with the cloud file store), so dropping
  // files inserts their names into the draft as a reference the team can read.
  const handleFilesDragOver = (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const handleFilesDrop = (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('application/x-docvex-files')) return;
    e.preventDefault();
    let data = null;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-docvex-files')); } catch { /* malformed */ }
    const names = (data?.items || []).filter((d) => d?.kind !== 'folder').map((d) => d?.name).filter(Boolean);
    if (!names.length) return;
    const ref = names.join(', ');
    setDraft((cur) => (cur ? `${cur}${cur.endsWith(' ') ? '' : ' '}${ref}` : ref));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleDraftKeyDown = (e) => {
    if (mentionOpen) {
      const list = mentionResults;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && list.length > 0) {
        e.preventDefault();
        pickMention(list[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="vb-composer-wrap" onDragOver={handleFilesDragOver} onDrop={handleFilesDrop}>
      <div
        className="dvx-composer vb-composer"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          e.currentTarget.style.setProperty('--spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
          e.currentTarget.style.setProperty('--spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
        }}
      >
        <textarea
          ref={textareaRef}
          className="dvx-composer-textarea"
          value={draft}
          onChange={handleDraftChange}
          onKeyDown={handleDraftKeyDown}
          onSelect={inspectCaretForMention}
          placeholder={`Message ${projectName}…  (type @ to mention)`}
          rows={1}
          /* Intentionally NOT disabled while sending — keeps focus so
             you can keep typing the next message right after Enter. */
          maxLength={4000}
        />
        <div className="dvx-composer-toolbar">
          <Tooltip content="Mention someone"><button type="button" className="dvx-composer-btn" aria-label="Mention" onClick={() => textareaRef.current?.focus()}><Icon.At /></button></Tooltip>
          <div className="dvx-composer-toolbar-spacer" />
          <Tooltip content="Send"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={handleSend} disabled={sending || !draft.trim()} aria-label="Send"><Icon.Send /></button></Tooltip>
        </div>
      </div>

      {mentionOpen && mentionResults.length > 0 && (
        <div className="vb-popover">
          {mentionResults.map((m, idx) => (
            <button
              type="button"
              key={m.user_id}
              className={`vb-popover-item${idx === mentionIndex ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
              onMouseEnter={() => setMentionIndex(idx)}
            >
              <VbAvatar profile={m.profile} authorId={m.user_id} size={22} />
              <span className="vb-popover-name">{displayName(m.profile)}</span>
              {m.profile?.email && <span className="vb-popover-email">{m.profile.email}</span>}
            </button>
          ))}
        </div>
      )}

    </div>
  );
});

// ───── Page ─────────────────────────────────────────────────────────

export default function ProjectChat() {
  const { selectedProject, loading: loadingProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;
  // /chat is a top-level route (alongside /files, /todos) — pulls
  // project state from SelectedProjectContext, not ProjectProvider
  // (which is scoped to /projects/:projectId/* by ProjectShell).
  // Members are fetched directly via the same listMembers helper
  // ProjectContext uses, so the data shape is identical and the @-
  // mention picker / message rendering needs no awareness of how
  // the page is mounted in the route tree.
  const [members, setMembers] = useState([]);
  useEffect(() => {
    if (!projectId) { setMembers([]); return undefined; }
    let cancelled = false;
    listMembers(projectId).then(({ data }) => {
      if (!cancelled) setMembers(data || []);
    });
    return () => { cancelled = true; };
  }, [projectId]);
  const { session } = useAuth();
  const viewerId = session?.user?.id || null;
  const { notify } = useNotifications();
  const { markRead: markChatRead } = useChatUnread();

  const [tab, setTab] = useState('team');

  // Build a (user_id → member-with-profile) map so message rendering
  // and mention resolution are O(1) lookups instead of array scans.
  const memberById = useMemo(() => {
    const m = new Map();
    for (const mem of members || []) m.set(mem.user_id, mem);
    return m;
  }, [members]);

  // ───── Messages ────────────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  // Clear the sidebar's chat-unread badge whenever the user is sitting
  // on the Team tab — both on first mount and on every fresh message
  // batch (messages.length is in the dep so a live arrival re-clears
  // immediately). The badge is "messages you haven't seen", and a
  // member with the team tab focused IS seeing them. The Assistant
  // tab doesn't count as "seeing the chat", so we deliberately gate
  // on tab. Placed after the messages state declaration so the dep on
  // `messages.length` doesn't hit the TDZ.
  useEffect(() => {
    if (tab !== 'team' || !projectId) return;
    markChatRead();
  }, [tab, projectId, markChatRead, messages.length]);

  useEffect(() => {
    if (!projectId) { setMessages([]); return undefined; }
    let cancelled = false;
    // Paint the thread as it was left, before the fetch has a chance to
    // resolve. Coming back to Chat is the common case and it barely changes
    // between visits — an empty column for the length of a round-trip made the
    // tab feel like it was loading from scratch every time. Only when there's
    // nothing cached does the spinner appear.
    const cached = readCachedChat(projectId);
    if (cached.length) { setMessages(cached); setLoading(false); }
    else setLoading(true);
    listChatMessages(projectId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        notify?.({
          category: 'system',
          variant: 'error',
          title: 'Could not load chat',
          body: error.message || 'Try again in a moment.',
          dedupeKey: `chat-load-error:${projectId}`,
        });
      } else {
        setMessages(data || []);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, notify]);

  // Mirror whatever is on screen back to the cache. Keyed on the message list
  // itself, so it captures the fetch AND every Realtime arrival / edit /
  // delete — the next open starts from the thread as it actually stands, not
  // as it stood when the tab was first opened. The write is debounced inside
  // chatCache so a busy thread doesn't serialise on every event.
  useEffect(() => {
    if (projectId && messages.length) writeCachedChat(projectId, messages);
  }, [projectId, messages]);

  // Realtime echo. Same merge pattern the BranchContext uses for
  // change_requests: dedupe INSERT by id (our optimistic insert may
  // race the echo), patch UPDATE, drop on DELETE.
  useEffect(() => {
    if (!projectId) return undefined;
    const unsub = subscribeChatMessages(projectId, ({ eventType, new: newRow, old: oldRow }) => {
      if (eventType === 'DELETE' && oldRow) {
        setMessages((prev) => prev.filter((m) => m.id !== oldRow.id));
        setProjectReplies((prev) => prev.filter((r) => r.id !== oldRow.id));
        return;
      }
      const row = newRow;
      if (!row) return;
      // Threaded replies (parent_id set) live in the reply store, not the
      // main message list.
      if (row.parent_id) {
        setProjectReplies((prev) => (
          eventType === 'INSERT'
            ? (prev.some((r) => r.id === row.id) ? prev : [...prev, row])
            : prev.map((r) => (r.id === row.id ? row : r))
        ));
        return;
      }
      if (eventType === 'INSERT') {
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      } else {
        setMessages((prev) => prev.map((m) => (m.id === row.id ? row : m)));
      }
    });
    return unsub;
  }, [projectId]);

  // Chat file-attachments were removed with the cloud file store. Any
  // legacy `attached_file_ids` on old messages resolve to nothing, so
  // they render as "File no longer available". Empty map keeps the
  // existing render paths valid without a data source.
  const fileById = useMemo(() => new Map(), []);

  // ───── Variant B: reactions · threads · pins · rail · search ────────
  const [reactions, setReactions] = useState([]);       // raw reaction rows
  const [projectReplies, setProjectReplies] = useState([]); // raw reply rows
  const [extrasTick, setExtrasTick] = useState(0);
  const bumpExtras = useCallback(() => setExtrasTick((t) => t + 1), []);
  const [railTab, setRailTab] = useState('threads');
  // The Pinned / Threads / Mentions rail (and its burger toggle) was removed —
  // the panel never opens, so the chat always renders full-width. The rail's
  // render paths below stay gated on this constant.
  const railCollapsed = true;
  // Width of the Pinned/Threads/Mentions/Files panel — drag the splitter to
  // resize it (clamped). Default tracks the header section-tabs width (so the
  // panel's left edge lines up with the "Pinned" tab) until the user drags.
  const [railWidth, setRailWidth] = useState(320);
  const [railUserSized, setRailUserSized] = useState(false);
  const [railResizing, setRailResizing] = useState(false);
  const headerSectionsRef = useRef(null);
  const startRailResize = useCallback((e) => {
    e.preventDefault();
    setRailUserSized(true); // stop auto-aligning once the user takes over
    setRailResizing(true);  // drops the grid transition so it tracks the cursor 1:1
    const startX = e.clientX;
    const startW = railWidth;
    const onMove = (ev) => {
      // Dragging the splitter LEFT widens the panel (it sits on the right).
      const next = Math.max(240, Math.min(560, startW + toLayoutPx(startX - ev.clientX)));
      setRailWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRailResizing(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [railWidth]);
  // Keep the panel's default width equal to the header section-tabs group, so
  // the panel sits directly under those tabs (left edge under "Pinned").
  useLayoutEffect(() => {
    if (railUserSized || tab !== 'team') return undefined;
    const el = headerSectionsRef.current;
    if (!el) return undefined;
    const apply = () => {
      const w = el.offsetWidth;
      if (w > 0) setRailWidth(Math.max(240, Math.min(560, w)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [railUserSized, tab]);
  const [chatSearch, setChatSearch] = useState('');
  const chatSearchRef = useRef(null);
  const [openThreadId, setOpenThreadId] = useState(null);
  const [threadDraft, setThreadDraft] = useState('');
  // Copy a message body to the clipboard (used by the morph pill's
  // "Copy text" item).
  const copyMessageText = useCallback((text) => {
    if (!text) return;
    // writeText rejects ASYNChronously (denied permission / unfocused document,
    // common in Electron), so a synchronous try/catch can't swallow it — attach
    // a .catch or it surfaces as an unhandled promise rejection.
    try { navigator.clipboard?.writeText(text)?.catch(() => { /* clipboard unavailable */ }); }
    catch { /* clipboard API missing */ }
  }, []);

  // Fetch reactions + replies for the project (refetch on tick).
  useEffect(() => {
    if (!projectId) { setReactions([]); setProjectReplies([]); return undefined; }
    let cancelled = false;
    listReactionsForProject(projectId).then(({ data }) => { if (!cancelled) setReactions(data || []); });
    listProjectReplies(projectId).then(({ data }) => { if (!cancelled) setProjectReplies(data || []); });
    return () => { cancelled = true; };
  }, [projectId, extrasTick]);

  // Realtime for reactions → refetch (cheap, reactions are small).
  useEffect(() => {
    if (!projectId) return undefined;
    return subscribeReactions(projectId, () => bumpExtras());
  }, [projectId, bumpExtras]);

  // Fold reactions by message → Map(messageId → Map(emoji → { count, mine })).
  const reactionsByMessage = useMemo(() => {
    const map = new Map();
    for (const r of reactions) {
      if (!map.has(r.message_id)) map.set(r.message_id, new Map());
      const em = map.get(r.message_id);
      const cur = em.get(r.emoji) || { count: 0, mine: false };
      cur.count += 1;
      if (r.user_id === viewerId) cur.mine = true;
      em.set(r.emoji, cur);
    }
    return map;
  }, [reactions, viewerId]);

  // Replies grouped by parent (drives the Threads rail + open-thread view).
  const repliesByParent = useMemo(() => {
    const map = new Map();
    for (const r of projectReplies) {
      if (!map.has(r.parent_id)) map.set(r.parent_id, []);
      map.get(r.parent_id).push(r);
    }
    return map;
  }, [projectReplies]);

  // Rail section data (Pinned / Threads / Mentions) — lifted out of
  // the team-tab render so the section tabs can live in the header nav bar
  // (the rail panel below just renders the selected section's content).
  const railSections = useMemo(() => {
    const pinned = messages
      .filter((m) => m.pinned_at && !m.deleted_at)
      .sort((a, b) => new Date(b.pinned_at) - new Date(a.pinned_at));
    const mentioned = messages.filter((m) => !m.deleted_at && (m.mentions || []).includes(viewerId));
    const threadParents = messages.filter((m) => (repliesByParent.get(m.id) || []).length > 0);
    const sections = [
      { id: 'pinned', label: 'Pinned', icon: <Icon.Pin />, count: pinned.length },
      { id: 'threads', label: 'Threads', icon: <Icon.Thread />, count: threadParents.length },
      { id: 'mentions', label: 'Mentions', icon: <Icon.At />, count: mentioned.length },
    ];
    return { pinned, mentioned, threadParents, sections };
  }, [messages, repliesByParent, viewerId]);

  const handleToggleReaction = useCallback(async (messageId, emoji) => {
    if (!projectId || !viewerId) return;
    const mine = reactionsByMessage.get(messageId)?.get(emoji)?.mine || false;
    // Optimistic — realtime echo reconciles via the extras refetch.
    setReactions((prev) => (mine
      ? prev.filter((r) => !(r.message_id === messageId && r.user_id === viewerId && r.emoji === emoji))
      : [...prev, { id: `tmp-${Date.now()}`, message_id: messageId, user_id: viewerId, emoji }]));
    await toggleReaction({ messageId, projectId, userId: viewerId, emoji, mine });
    bumpExtras();
  }, [projectId, viewerId, reactionsByMessage, bumpExtras]);

  const handleSendThreadReply = useCallback(async () => {
    if (!projectId || !viewerId || !openThreadId) return;
    const body = threadDraft.trim();
    if (!body) return;
    const { data, error } = await sendThreadReply({ projectId, authorId: viewerId, parentId: openThreadId, body });
    if (error) {
      notify?.({ category: 'system', variant: 'error', title: 'Reply failed', body: error.message || 'Try again in a moment.' });
      return;
    }
    if (data) setProjectReplies((prev) => (prev.some((r) => r.id === data.id) ? prev : [...prev, data]));
    setThreadDraft('');
  }, [projectId, viewerId, openThreadId, threadDraft, notify]);

  // Per-message DOM refs so the rail's "jump to message" can scroll a
  // pinned / mentioned message into view and briefly flash it.
  const msgRefs = useRef({});
  const jumpToMessage = useCallback((id) => {
    const el = msgRefs.current[id];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-jump-flash');
    setTimeout(() => el.classList.remove('is-jump-flash'), 1400);
  }, []);

  // Auto-scroll to bottom on new messages — only when the user is
  // already near the bottom (so we don't yank them away from a back-
  // scrolled history view when a teammate posts). When the user IS
  // scrolled up reading history, an "N new" pill appears above the
  // composer instead; clicking it scrolls down and clears the count.
  const listRef = useRef(null);
  // Root of the chat page. The TEAM tab nests a dedicated BLOCK scroll container
  // (.dvx-scroll-area, ref below) so the sticky mini-header pins against its
  // direct block scroll parent (the only reliable sticky case) while the masthead
  // scrolls away inside it. Auto-scroll + the header-pin watcher target it.
  const pageRef = useRef(null);
  const scrollRef = useRef(null);
  const getScroller = () => scrollRef.current || listRef.current;
  // VS-Code-style find: highlight every match of the header search across the
  // team thread, count them, and scroll to each on Enter / Shift+Enter.
  const find = useChatFind({ containerRef: listRef, query: chatSearch, name: 'teamchat', scope: '.vb-msg-text' });
  const stickToBottomRef = useRef(true);
  const [unreadCount, setUnreadCount] = useState(0);
  // True once the page has scrolled past the big masthead — pins the in-page
  // tools/tabs bar as the frosted "mini header" (mirrors the Files fx-pathbar).
  // Hysteresis (pin past 132px, unpin under 96px) avoids flicker at the edge.
  const [headerScrolled, setHeaderScrolled] = useState(false);
  // Mirror of stickToBottomRef as React state so CSS can react to
  // it. We need both: the ref is read synchronously inside layout
  // effects (where state would be stale), and the state drives the
  // composer's "lift" when the user is scrolled up to leave a gap
  // under the input field.
  const [isAtBottom, setIsAtBottom] = useState(true);
  const prevMessagesLenRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = getScroller();
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setIsAtBottom(true);
    setUnreadCount(0);
  }, []);

  const handleListScroll = () => {
    const el = getScroller();
    if (!el) return;
    // Pinned only once the bar is ACTUALLY stuck at the top (its rect reaches the
    // scroller's top + the sticky `top` gap), so the bg doesn't appear early while
    // the masthead is still scrolling away.
    const bar = el.querySelector('.dvx-toolbar');
    setHeaderScrolled(!!bar && (bar.getBoundingClientRect().top - el.getBoundingClientRect().top) <= 8);
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 80;
    stickToBottomRef.current = atBottom;
    // React bails out when the new state === current, so this set
    // call only re-renders when the user crosses the threshold
    // either way — not on every scroll pixel.
    setIsAtBottom(atBottom);
    // Reaching the bottom clears the unread tally — the user has
    // visually caught up so the pill should go away even without an
    // explicit click on it.
    if (atBottom) setUnreadCount(0);
  };

  // The page (.sv-single-scroll) is the scroller, which lives ABOVE this
  // component, so attach the scroll listener imperatively instead of via an
  // onScroll prop on the message list.
  useEffect(() => {
    if (tab !== 'team') return undefined;
    const el = getScroller();
    if (!el) return undefined;
    el.addEventListener('scroll', handleListScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleListScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loading]);

  // Open the tab ALREADY at the bottom. Entering the team tab pins the
  // scroller immediately (even while messages are still loading), so the user
  // never lands on the masthead and then gets yanked down.
  useLayoutEffect(() => {
    if (tab !== 'team') return;
    stickToBottomRef.current = true;
    setIsAtBottom(true);
    const el = getScroller();
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // …and STAY at the bottom while pinned content grows: the initial messages
  // commit, then attachments/images/link cards that finish loading after the
  // first paint all change the list's height without a `messages` state
  // change. A ResizeObserver fires between layout and paint, so re-pinning
  // here is invisible — no teleport. Scrolling up flips stickToBottomRef via
  // the scroll listener above, which turns these re-pins off.
  useEffect(() => {
    if (tab !== 'team') return undefined;
    const el = getScroller();
    const list = listRef.current;
    if (!el || !list || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(list);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loading]);

  // Auto-scroll layout effect — runs after every messages state
  // commit. Stick-to-bottom is the only fast path; otherwise we
  // count NEW messages (current length > previous length) and
  // bump the unread tally so the pill knows what to show.
  useLayoutEffect(() => {
    const prev = prevMessagesLenRef.current;
    const next = messages.length;
    prevMessagesLenRef.current = next;
    const grew = next > prev;
    if (stickToBottomRef.current) {
      const el = getScroller();
      if (el) el.scrollTop = el.scrollHeight;
    } else if (grew) {
      setUnreadCount((c) => c + (next - prev));
    }
  }, [messages, tab]);

  // ───── Composer ────────────────────────────────────────────────────
  // The draft text + mention/attach popovers + send all live inside the
  // <TeamComposer> child (local state) so typing re-renders only the
  // composer, not this whole page. The parent only needs the
  // optimistic-insert handler that runs after a successful send.
  const handleMessageSent = useCallback((data) => {
    // The user explicitly sent — always pin to the bottom so their own
    // message scrolls into view regardless of prior scroll position.
    stickToBottomRef.current = true;
    setIsAtBottom(true);
    setUnreadCount(0);
    if (data) setMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data]));
  }, []);

  // ───── Typing indicator (Realtime Broadcast) ───────────────────────
  // Each keystroke (throttled to once every 2 s) fires a broadcast on
  // a dedicated typing channel for this project. Other members'
  // clients receive the broadcast and stamp the sender's user_id with
  // an expiry 4 s in the future. A 500 ms pruning interval drops
  // entries past expiry, so a user who stops typing fades out of
  // everyone else's indicator without an explicit "stopped" message.
  //
  // Broadcast (vs Presence) was chosen because we don't need a
  // persistent member-list view of "who's currently in the channel"
  // — we only need a transient "this user pressed a key recently."
  // Broadcast is one round-trip per event, Presence is heavier.
  const [typingUsers, setTypingUsers] = useState(new Map());
  const typingChannelRef = useRef(null);
  const lastTypingBroadcastRef = useRef(0);

  // ───── Private DM state ────────────────────────────────────────────
  // Selected DM partner (a project member's user_id), the loaded
  // thread between viewer + partner, and the composer state. The
  // thread is keyed on the partner so switching members swaps the
  // thread without leaking messages from a previous conversation.
  const [selectedPartnerId, setSelectedPartnerId] = useState(null);
  const [privateMessages, setPrivateMessages] = useState([]);
  const [privateLoading, setPrivateLoading] = useState(false);
  const [privateDraft, setPrivateDraft] = useState('');
  const [privateSending, setPrivateSending] = useState(false);
  const privateListRef = useRef(null);

  // Load the thread when (projectId, viewerId, partner) changes.
  useEffect(() => {
    if (!projectId || !viewerId || !selectedPartnerId) {
      setPrivateMessages([]);
      return undefined;
    }
    let cancelled = false;
    setPrivateLoading(true);
    listPrivateMessages(projectId, viewerId, selectedPartnerId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        notify?.({
          category: 'system',
          variant: 'error',
          title: 'Could not load conversation',
          body: error.message || 'Try again in a moment.',
          dedupeKey: `pm-load-error:${selectedPartnerId}`,
        });
      } else {
        setPrivateMessages(data || []);
      }
      setPrivateLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, viewerId, selectedPartnerId, notify]);

  // Realtime: subscribe at the project level (RLS hides messages
  // outside the viewer's threads), and filter client-side to the
  // currently-open partner so unrelated DMs don't pollute the view.
  useEffect(() => {
    if (!projectId || !viewerId) return undefined;
    const unsub = subscribePrivateMessages(projectId, ({ eventType, new: newRow, old: oldRow }) => {
      const partner = selectedPartnerId;
      const inThread = (row) => row && (
        (row.sender_id === viewerId && row.recipient_id === partner)
        || (row.sender_id === partner && row.recipient_id === viewerId)
      );
      if (eventType === 'INSERT' && inThread(newRow)) {
        setPrivateMessages((prev) => (
          prev.some((m) => m.id === newRow.id) ? prev : [...prev, newRow]
        ));
      } else if (eventType === 'UPDATE' && inThread(newRow)) {
        setPrivateMessages((prev) => prev.map((m) => (m.id === newRow.id ? newRow : m)));
      } else if (eventType === 'DELETE' && inThread(oldRow)) {
        setPrivateMessages((prev) => prev.filter((m) => m.id !== oldRow.id));
      }
    });
    return unsub;
  }, [projectId, viewerId, selectedPartnerId]);

  // Auto-scroll the DM thread to the bottom on every message change.
  // Simpler than the Team-tab logic — DMs are short, scrolling away
  // to read history is rare, and "yank to bottom on send/receive" is
  // the expected behaviour for a 1:1 conversation.
  useLayoutEffect(() => {
    const el = privateListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [privateMessages.length, selectedPartnerId]);

  const handleSendPrivate = async () => {
    if (privateSending || !projectId || !viewerId || !selectedPartnerId) return;
    const body = privateDraft.trim();
    if (!body) return;
    setPrivateSending(true);
    const { data, error } = await sendPrivateMessage({
      projectId,
      senderId: viewerId,
      recipientId: selectedPartnerId,
      body,
    });
    setPrivateSending(false);
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Send failed',
        body: error.message || 'Try again in a moment.',
        dedupeKey: `pm-send-error:${Date.now()}`,
      });
      return;
    }
    if (data) {
      // Optimistic insert; Realtime will echo and dedupe by id.
      setPrivateMessages((prev) => (prev.some((m) => m.id === data.id) ? prev : [...prev, data]));
    }
    setPrivateDraft('');
  };

  const handlePrivateKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendPrivate();
    }
  };

  // ───── Snap-to-latest on tab activation ────────────────────────────
  // Clicking the Team or Private tab buttons should always land the
  // user at the freshest messages. We can't simply call
  // `scrollToBottom()` inside the onClick handler because the target
  // messages list may not be mounted yet (the tabs render their
  // panels conditionally on `tab`, and React commits the new tree
  // AFTER the click handler runs). Instead the click bumps this
  // nonce; the effect below re-runs after every commit, by which
  // point the listRef is guaranteed to point at the live DOM node.
  const [scrollToLatestNonce, setScrollToLatestNonce] = useState(0);
  useLayoutEffect(() => {
    if (scrollToLatestNonce === 0) return undefined;
    const doScroll = () => {
      if (tab === 'team') {
        const el = getScroller();
        if (el) el.scrollTop = el.scrollHeight;
      } else if (tab === 'private') {
        const el = privateListRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    };
    // Sync scroll first (immediate). Then re-run on the next
    // animation frame and once more after 120 ms — these catch
    // late layout changes from async content (image attachments
    // resolving, fonts loading) that grow `scrollHeight` after
    // the initial commit, which would otherwise leave the user
    // above the real bottom.
    doScroll();
    if (tab === 'team') {
      stickToBottomRef.current = true;
      setIsAtBottom(true);
      setUnreadCount(0);
    }
    const raf = requestAnimationFrame(doScroll);
    const timeout = setTimeout(doScroll, 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
    };
  }, [scrollToLatestNonce, tab]);

  // Sidebar Chat link → snap to latest. Two delivery channels:
  //   1. window CustomEvent — fires when the user clicks the
  //      sidebar Chat NavLink while ALREADY on /chat. NavLink to
  //      the same route doesn't remount the page, so a fresh
  //      `useLayoutEffect` on mount can't help.
  //   2. location.state.focusLatest — fires when the click navigates
  //      FROM a different route (CustomEvent would have dispatched
  //      before this page mounted, so the listener wouldn't catch
  //      it). The sidebar attaches a timestamped state on every
  //      click; an effect keyed on that timestamp triggers the
  //      scroll once the page is mounted and messages have rendered.
  useEffect(() => {
    const onFocusLatest = () => {
      setTab('team');
      setScrollToLatestNonce((n) => n + 1);
    };
    window.addEventListener('docvex:chat-focus-latest', onFocusLatest);
    return () => window.removeEventListener('docvex:chat-focus-latest', onFocusLatest);
  }, []);
  const location = useLocation();
  const focusLatestStamp = location?.state?.focusLatest;
  useEffect(() => {
    if (!focusLatestStamp) return;
    setTab('team');
    setScrollToLatestNonce((n) => n + 1);
  }, [focusLatestStamp]);

  // ───── Sticky-tab detection ────────────────────────────────────────
  // CSS can't natively distinguish `position: sticky` in its at-rest
  // vs pinned state, so a 1px sentinel sits in the document right
  // above the tab bar; when the sentinel scrolls out of view, the
  // tabs are pinned to the top of the scroll viewport. The class
  // toggle drives the at-rest (transparent, in-frame) vs pinned
  // (opaque, full-width) visual difference.
  const tabsSentinelRef = useRef(null);
  const [tabsStuck, setTabsStuck] = useState(false);
  useEffect(() => {
    const el = tabsSentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        // intersectionRatio < 1 means the sentinel is no longer
        // fully in view at the top edge → tab bar has pinned.
        setTabsStuck(entry.intersectionRatio < 1);
      },
      { threshold: [0, 1] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Typing indicators are rendered inside the messages list as
  // message-shaped rows, so an appearing typer pushes content down
  // the same way a new message would. Keep the bottom in view when
  // the user is already pinned there. No unread-count bump here —
  // a half-typed dot row isn't an unread "message", just a hint.
  // Declared after the typingUsers state so the dep doesn't hit TDZ.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = getScroller();
    if (el) el.scrollTop = el.scrollHeight;
  }, [typingUsers.size]);

  useEffect(() => {
    if (!projectId || !viewerId) return undefined;
    // Typing is a BROADCAST channel, so the topic is the cross-user routing
    // key and must stay shared (no unique suffix). supabase.channel(topic)
    // returns the SAME instance for a topic already in use, so when split view
    // mounts two chat panes for one project they share this channel — guard
    // the subscribe() so the second pane doesn't re-subscribe (which throws).
    const channel = supabase
      .channel(`chat-typing:${projectId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, (msg) => {
        const uid = msg?.payload?.user_id;
        if (!uid || uid === viewerId) return;
        setTypingUsers((prev) => {
          const next = new Map(prev);
          next.set(uid, Date.now() + 4000);
          return next;
        });
      });
    if (channel.state !== 'joined' && channel.state !== 'joining') {
      try { channel.subscribe(); } catch { /* already subscribing/joined */ }
    }
    typingChannelRef.current = channel;
    return () => {
      try { supabase.removeChannel(channel); } catch { /* non-fatal */ }
      typingChannelRef.current = null;
      setTypingUsers(new Map());
    };
  }, [projectId, viewerId]);

  // Prune expired typing entries. 500 ms is the cadence that feels
  // right: a typist who pauses for ~3 s fades cleanly without the
  // indicator looking laggy or jittery.
  useEffect(() => {
    const interval = setInterval(() => {
      setTypingUsers((prev) => {
        if (prev.size === 0) return prev;
        const now = Date.now();
        let changed = false;
        const next = new Map();
        for (const [uid, exp] of prev) {
          if (exp > now) next.set(uid, exp);
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Throttled broadcast — called from the draft onChange handler.
  // The 2 s throttle is enough that a steady typist re-asserts their
  // "typing" stamp before the 4 s expiry runs out, so receivers keep
  // their indicator lit; a typist that stops sees the indicator fade
  // 4 s after their LAST keystroke (one expiry window).
  const broadcastTyping = useCallback(() => {
    const ch = typingChannelRef.current;
    if (!ch || !viewerId) return;
    const now = Date.now();
    if (now - lastTypingBroadcastRef.current < 2000) return;
    lastTypingBroadcastRef.current = now;
    ch.send({ type: 'broadcast', event: 'typing', payload: { user_id: viewerId } });
  }, [viewerId]);

  // ───── Edit / Delete ───────────────────────────────────────────────
  // Only the *which message* is edited lives here; the edit textarea's
  // keystroke state lives inside <MessageEditBox> so typing an edit
  // doesn't re-render the list. All handlers are useCallback so the
  // memoized rows keep skipping re-renders.
  const [editingId, setEditingId] = useState(null);

  const startEdit = useCallback((msg) => { setEditingId(msg.id); }, []);
  const cancelEdit = useCallback(() => { setEditingId(null); }, []);
  const saveEdit = useCallback(async (id, rawBody) => {
    const body = (rawBody || '').trim();
    if (!body) {
      notify?.({ category: 'system', variant: 'error', title: 'Empty edit', body: 'Cannot save an empty message.' });
      return;
    }
    const newMentions = (members || [])
      .filter((m) => body.includes(`@${displayName(m.profile)}`))
      .map((m) => m.user_id);
    const { error } = await editChatMessage(id, { body, mentions: newMentions });
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Edit failed',
        body: error.message || 'Try again in a moment.',
      });
      return;
    }
    setEditingId(null);
  }, [members, notify]);
  const handleDelete = useCallback(async (msg) => {
    if (!msg) return;
    // Confirmation is handled by the morph pill's built-in confirm step
    // (the Delete menu item carries a `confirm` payload), so no window.confirm here.
    const { error } = await deleteChatMessage(msg.id);
    if (error) {
      notify?.({
        category: 'system',
        variant: 'error',
        title: 'Delete failed',
        body: error.message || 'Try again in a moment.',
      });
    }
  }, [notify]);

  // "Message privately" handler for the mention right-click menu.
  // Switches the chat to the Private tab and selects the mentioned
  // member as the DM partner. The Private tab effect picks the new
  // partnerId up, loads the thread, and the composer is ready to
  // type into.
  const handleMessagePrivately = useCallback((member) => {
    const uid = member?.user_id;
    if (!uid || uid === viewerId) return;
    setSelectedPartnerId(uid);
    setTab('private');
  }, [viewerId]);

  // Chat attachments were removed with the cloud file store; legacy
  // attachment cards on old messages are no longer openable.
  const handleAttachmentClick = useCallback(() => {}, []);

  // ───── Body rendering with mention highlights ──────────────────────
  // Stored body carries literal `@<display-name>` text; mentions[] holds
  // the user_ids. We scan for each token and wrap it in a .dvx-mention
  // chip. The viewer's own mention keeps their real name (just styled with
  // the borderless `.is-me` variant) so it reads naturally.
  const renderBody = useCallback((msg) => {
    if (msg.deleted_at) return <em className="vb-msg-deleted">Message deleted</em>;
    const body = msg.body || '';
    const mentions = msg.mentions || [];
    if (mentions.length === 0) return body;
    const tokens = [];
    for (const uid of mentions) {
      const m = memberById.get(uid);
      if (m) tokens.push({ uid, token: `@${displayName(m.profile)}` });
    }
    if (tokens.length === 0) return body;
    const occ = [];
    for (const t of tokens) {
      let idx = 0;
      while ((idx = body.indexOf(t.token, idx)) >= 0) {
        occ.push({ idx, end: idx + t.token.length, uid: t.uid });
        idx += t.token.length;
      }
    }
    occ.sort((a, b) => a.idx - b.idx);
    const parts = []; let cursor = 0; let k = 0;
    for (const o of occ) {
      if (o.idx < cursor) continue;
      if (o.idx > cursor) parts.push(<React.Fragment key={k++}>{body.slice(cursor, o.idx)}</React.Fragment>);
      const isMe = o.uid === viewerId;
      parts.push(
        <span key={k++} className={`dvx-mention${isMe ? ' is-me' : ''}`}>
          @{displayName(memberById.get(o.uid)?.profile)}
        </span>,
      );
      cursor = o.end;
    }
    if (cursor < body.length) parts.push(<React.Fragment key={k++}>{body.slice(cursor)}</React.Fragment>);
    return parts;
  }, [memberById, viewerId]);

  // ───── Window chrome integration ───────────────────────────────────
  // Like the Files tab: publish the header subtitle into the window topbar
  // (next to the "Chat" title) and portal the search + huddle controls into
  // the chrome's toolbar row, so the header reads as part of the topbar
  // instead of a separate in-page band. Hooks run before any early return.
  const chatChromeDesc = selectedProject
    ? `${selectedProject.name} · ${members.length} ${members.length === 1 ? 'member' : 'members'}`
    : null;
  usePaneChromeSlot({ description: chatChromeDesc });
  const chromeSlotEl = usePaneChromePortalEl();
  // The window's footer slot — the message composer is portalled here so it
  // docks in the app footer (relevant to this window), not inside the page.
  const chatFooterEl = usePaneChromeFooterEl();
  // Ctrl/⌘+F focuses the message search — only for the SELECTED window (the
  // input is portalled into this pane's chrome, so `.closest('.sv-pane')`
  // resolves to it; single-window mode has no `.sv-pane` and always fires).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const el = chatSearchRef.current;
        if (!el) return;
        const pane = el.closest('.sv-pane');
        if (pane && !pane.classList.contains('is-focused')) return;
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const chatChromeTools = (
    <div className="dvx-chrome-tools">
      {/* Huddle on the left, search on the right (search has margin-left:auto). */}
      <Tooltip content="Start a huddle (coming soon)">
        <button type="button" className="dvx-action-btn is-accent" disabled>
          <Icon.Headset /><span>Start huddle</span>
        </button>
      </Tooltip>
      <div className={`dvx-chrome-search${chatSearch ? ' is-active' : ''}`}>
        <Icon.Search className="dvx-chrome-search-glyph" width="15" height="15" />
        <input
          ref={chatSearchRef}
          type="text"
          placeholder="Search messages…"
          value={chatSearch}
          onChange={(e) => setChatSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && chatSearch) { e.stopPropagation(); setChatSearch(''); return; }
            // Enter → next match, Shift+Enter → previous (VS Code's find loop).
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) find.goPrev(); else find.goNext(); }
          }}
          aria-label="Search messages"
        />
        {chatSearch && find.supported ? (
          <span className={`chat-find-count${find.total === 0 ? ' is-empty' : ''}`} aria-live="polite">
            {find.total ? `${find.current}/${find.total}` : 'No results'}
          </span>
        ) : null}
        {chatSearch ? (
          <Tooltip content="Clear search">
            <button
              type="button"
              className="dvx-chrome-search-clear"
              aria-label="Clear search"
              onClick={() => { setChatSearch(''); chatSearchRef.current?.focus(); }}
            >
              <Icon.Close width="13" height="13" />
            </button>
          </Tooltip>
        ) : (
          <span className="dvx-chrome-search-kbd">
            <kbd>{isMacPlatform ? '⌘' : 'Ctrl'}</kbd>
            <span className="dvx-chrome-search-plus">+</span>
            <kbd>F</kbd>
          </span>
        )}
      </div>
    </div>
  );

  // ───── Early returns ───────────────────────────────────────────────
  if (loadingProject && !selectedProject) return null;
  if (!selectedProject) {
    return (
      <div className="project-scoped-empty">
        <h2>No project selected</h2>
        <p>Pick a project to start a conversation.</p>
        <Link to="/projects" className="project-scoped-cta">Browse projects</Link>
      </div>
    );
  }

  // Tab strip — lifted into the window topbar (chrome row 2), stacked UNDER the
  // huddle + search row, so the whole chat header reads as one bar. Falls back
  // in-page when there's no chrome.
  const chatTabs = (
    <div className="dvx-tabs vb-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'team'}
        className={`dvx-tab${tab === 'team' ? ' is-active' : ''}`}
        onClick={() => { setTab('team'); setScrollToLatestNonce((n) => n + 1); }}
      >
        <Icon.Hash />Team
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'private'}
        className={`dvx-tab${tab === 'private' ? ' is-active' : ''}`}
        onClick={() => { setTab('private'); setScrollToLatestNonce((n) => n + 1); }}
      >
        <Icon.Lock />Private
      </button>
      {/* The right-side rail section tabs (Pinned / Threads / Mentions) and
          their burger toggle were removed with the rail feature. */}
    </div>
  );

  // Team composer node — rendered ONCE, either portalled into the window's app
  // footer (the normal path) or inline as a fallback when there's no chrome.
  const teamComposerNode = (
    <TeamComposer
      projectId={projectId}
      viewerId={viewerId}
      projectName={selectedProject.name}
      members={members}
      memberById={memberById}
      notify={notify}
      broadcastTyping={broadcastTyping}
      onSent={handleMessageSent}
    />
  );

  // Big masthead — a Files-style hero (.dvx-mh mirrors .fx-masthead) that scrolls
  // away with the page; the in-page tools+tabs bar below it pins as the sticky
  // mini header. The eyebrow/kicker describe the active conversation.
  const memberCount = `${members.length} ${members.length === 1 ? 'member' : 'members'}`;
  const chatMasthead = (
    <header className="dvx-mh">
      <div className="dvx-mh-eyebrow">
        <span>{tab === 'team' ? 'Team chat' : 'Private messages'}</span>
        <span className="dvx-mh-muted">· {memberCount}</span>
      </div>
      <h1 className="dvx-mh-title">Chat</h1>
      <p className="dvx-mh-kicker">
        {tab === 'team'
          ? `${selectedProject.name} · ${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`
          : `${selectedProject.name} · Direct messages`}
      </p>
    </header>
  );

  // Big masthead + the in-page tools/tabs bar (the mini header), rendered at the
  // top of each tab's content. In the team tab these live inside the scroll-area
  // so the masthead scrolls away and the toolbar pins.
  const chatHeader = (
    <>
      {chatMasthead}
      {/* Single 40px row (same height as the Hub button): tabs on the left, the
          huddle + search tools fill the right. */}
      <MiniHeaderFade visible={headerScrolled} />
      <div className={`dvx-toolbar mini-glow${headerScrolled ? ' is-pinned' : ''}`} onMouseMove={miniHeaderSpot}>
        {chatTabs}
        {chatChromeTools}
      </div>
    </>
  );

  // ───── Render ──────────────────────────────────────────────────────
  return (
    <div className={`dvx-chat vb-chat${tab === 'private' ? ' is-private' : ''}`} ref={pageRef}>
      {/* Chromeless (the /chat route carries no window chrome). The team tab uses
          a dedicated block scroll-area so the big masthead scrolls away and the
          tools/tabs bar pins to the top as the mini header — like the Files tab. */}
      {tab === 'team' && (() => {
        // Section data + tabs now live in the header nav bar (railSections);
        // the rail panel below just renders the selected section's content.
        const { pinned, mentioned, threadParents } = railSections;
        return (
          <div className="dvx-scroll-area" ref={scrollRef}>
          {chatHeader}
          <div className="vb-team">
          <div
            className={`vb-split${railCollapsed ? ' rail-collapsed' : ''}${railResizing ? ' is-resizing' : ''}`}
            // Drag the splitter to resize the rail; the resizer is a thin
            // grid column between the thread and the panel.
            style={railCollapsed ? undefined : { gridTemplateColumns: `1fr 6px ${railWidth}px` }}
          >
            {/* ── Main thread ── */}
            <div className="vb-main">
              <div className="vb-messages" ref={listRef}>
                {loading && messages.length === 0 && <div className="vb-empty">Loading…</div>}
                {!loading && messages.length === 0 && <div className="vb-empty">No messages yet. Be the first to say hi.</div>}
                {messages.map((msg, i) => {
                  const prev = i > 0 ? messages[i - 1] : null;
                  const showDay = !prev || !sameLocalDay(prev.created_at, msg.created_at);
                  // Group consecutive messages from the same author within 1
                  // minute (and same day) — they share one avatar/header.
                  const grouped = !!prev && !showDay
                    && prev.author_id === msg.author_id
                    && (new Date(msg.created_at) - new Date(prev.created_at)) < 60 * 1000;
                  return (
                    <TeamMessageRow
                      key={msg.id}
                      msg={msg}
                      showDay={showDay}
                      grouped={grouped}
                      viewerId={viewerId}
                      memberById={memberById}
                      fileById={fileById}
                      rmap={reactionsByMessage.get(msg.id)}
                      replies={repliesByParent.get(msg.id) || EMPTY_REPLIES}
                      isEditing={editingId === msg.id}
                      renderBody={renderBody}
                      msgRefs={msgRefs}
                      onToggleReaction={handleToggleReaction}
                      onAttachmentClick={handleAttachmentClick}
                      onSaveEdit={saveEdit}
                      onCancelEdit={cancelEdit}
                      onStartEdit={startEdit}
                      onDelete={handleDelete}
                      onCopy={copyMessageText}
                    />
                  );
                })}

                {typingUsers.size > 0 && Array.from(typingUsers.keys()).map((uid) => {
                  const member = memberById.get(uid);
                  return (
                    <div key={`typing-${uid}`} className="dvx-msg-row vb-msg vb-typing">
                      <div className="vb-msg-avatar"><VbAvatar profile={member?.profile} authorId={uid} size={32} /></div>
                      <div className="vb-msg-body">
                        <div className="vb-typing-bubble">
                          <span className="vb-typing-dot" /><span className="vb-typing-dot" /><span className="vb-typing-dot" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {unreadCount > 0 && (
                <button type="button" className="vb-scroll-back" onClick={scrollToBottom} aria-label="Scroll to latest messages">
                  {unreadCount} new message{unreadCount === 1 ? '' : 's'} ↓
                </button>
              )}

            </div>

            {/* The right rail (Pinned / Threads / Mentions) was removed along
                with its tab-bar toggle — the thread pane always fills the row. */}
          </div>

          {/* Message input — docked flat in the window's app footer (.sv-footer),
              which is styled exactly like the Files bottom action bar (frosted
              border-top surface, 17.6px inset, no rounded floating box). */}
          {chatFooterEl ? createPortal(teamComposerNode, chatFooterEl) : teamComposerNode}
          </div>
          </div>
        );
      })()}

      {tab === 'private' && (() => {
        const otherMembers = (members || [])
          .filter((m) => m.user_id !== viewerId)
          .slice()
          .sort((a, b) => displayName(a.profile).localeCompare(displayName(b.profile)));
        const partner = selectedPartnerId ? memberById.get(selectedPartnerId) : null;
        const partnerName = partner ? displayName(partner.profile) : '';
        const partnerStatus = partner?.profile?.status;
        return (
          <>
          {chatHeader}
          <div className="vb-private">
            <div className="vb-private-list dvx-scroll">
              <div className="vb-private-list-header"><span>Direct messages</span></div>
              {otherMembers.length === 0 && <div className="vb-rail-empty">No other members yet.</div>}
              {otherMembers.map((m) => (
                <button
                  key={m.user_id}
                  type="button"
                  className={`vb-private-item${m.user_id === selectedPartnerId ? ' is-active' : ''}`}
                  onClick={() => setSelectedPartnerId(m.user_id)}
                >
                  <VbAvatar profile={m.profile} authorId={m.user_id} size={30} showStatus />
                  <div className="vb-private-item-text">
                    <div className="vb-private-item-top"><span className="vb-private-item-name">{displayName(m.profile)}</span></div>
                    <div className="vb-private-item-snippet">{m.profile?.email || 'Project member'}</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="vb-private-thread">
              {!selectedPartnerId ? (
                <div className="vb-empty">Select a member on the left to start a private conversation.</div>
              ) : (
                <>
                  <div className="vb-private-thread-header">
                    <VbAvatar profile={partner?.profile} authorId={selectedPartnerId} size={32} showStatus />
                    <div>
                      <div className="vb-private-thread-header-name">{partnerName}</div>
                      <div className="vb-private-thread-header-status">
                        <span className="dvx-status-dot" style={{ background: STATUS_COLORS[partnerStatus] || '#94a3b8' }} />
                        {partnerStatus === 'online' ? 'Active now' : partnerStatus === 'away' ? 'Away' : partnerStatus === 'dnd' ? 'Do not disturb' : 'Offline'}
                      </div>
                    </div>
                  </div>
                  <div className="vb-private-messages dvx-scroll" ref={privateListRef}>
                    {privateLoading && privateMessages.length === 0 && <div className="vb-empty">Loading…</div>}
                    {!privateLoading && privateMessages.length === 0 && (
                      <div className="vb-private-empty">
                        <VbAvatar profile={partner?.profile} authorId={selectedPartnerId} size={56} />
                        <h3>{partnerName}</h3>
                        <p>No messages yet. Say hi.</p>
                      </div>
                    )}
                    {privateMessages.map((msg, i) => {
                      const isMine = msg.sender_id === viewerId;
                      const prev = i > 0 ? privateMessages[i - 1] : null;
                      const showDay = !prev || !sameLocalDay(prev.created_at, msg.created_at);
                      return (
                        <React.Fragment key={msg.id}>
                          {showDay && (
                            <div className="dvx-day-divider" role="separator">
                              <span className="dvx-day-divider-label">{formatDayLabel(msg.created_at)}</span>
                            </div>
                          )}
                          <div className={`dvx-msg-row vb-msg${isMine ? ' is-mine' : ''}`}>
                            {!isMine && (
                              <div className="vb-msg-avatar"><VbAvatar profile={partner?.profile} authorId={msg.sender_id} size={32} /></div>
                            )}
                            <div className="vb-msg-body">
                              <div className="vb-msg-bubble">
                                <span className="vb-msg-text">
                                  {msg.deleted_at ? <em className="vb-msg-deleted">Message deleted</em> : msg.body}
                                </span>
                              </div>
                              {/* Time under the bubble (like the AI chat) — no ticks. */}
                              {!msg.deleted_at && (
                                <span className="vb-msg-time-under">{formatHM(msg.created_at)}</span>
                              )}
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div className="vb-composer-wrap">
                    <div className="dvx-composer vb-composer">
                      <textarea
                        className="dvx-composer-textarea"
                        value={privateDraft}
                        onChange={(e) => setPrivateDraft(e.target.value)}
                        onKeyDown={handlePrivateKeyDown}
                        placeholder={`Message ${partnerName}…`}
                        rows={1}
                        disabled={privateSending}
                        maxLength={4000}
                      />
                      <div className="dvx-composer-toolbar">
                        <div className="dvx-composer-toolbar-spacer" />
                        <Tooltip content="Send"><button type="button" className="dvx-composer-btn dvx-composer-send" onClick={handleSendPrivate} disabled={privateSending || !privateDraft.trim()} aria-label="Send"><Icon.Send /></button></Tooltip>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            <aside className="vb-private-rail dvx-scroll">
              <div className="vb-rail-section-title">Quick actions</div>
              <button type="button" className="dvx-action-btn" disabled><Icon.Headset /> Start huddle</button>
              <button type="button" className="dvx-action-btn" disabled><Icon.Bell /> Mute conversation</button>
            </aside>
          </div>
          </>
        );
      })()}
    </div>
  );
}
