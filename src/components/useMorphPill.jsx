import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// Cursor coords / innerWidth / DOMRects are viewport px; the transform we set
// is layout px — under the app's CSS-zoom downscale the two differ (see
// lib/appZoom). pillPos is therefore stored in LAYOUT px. The FLIP morph
// needs no conversion: its scale factors are viewport/viewport ratios and the
// translate it re-applies is parsed back out of the (layout-px) transform.
import { toLayoutPx } from '../lib/appZoom';
// Co-located styling — every consumer of useMorphPill gets the
// dropdown / confirm-panel CSS automatically. Previously these
// rules lived in ProjectFiles.css, which meant the hook only looked
// right on the Files page; consumers on other pages (Chat,
// future surfaces) had to remember to import an unrelated CSS file
// or the dropdown rendered with the bare tooltip styling.
import './useMorphPill.css';

// How long the menu's dismissal fade runs. Must stay in step with the
// `.is-closing` animation in useMorphPill.css — the JS keeps the pill mounted
// for exactly this long before tearing the state down.
const MENU_EXIT_MS = 130;

// Shared morph-pill hook + portal renderer. Powers the same hover-
// tooltip → right-click-menu interaction the file grid uses on every
// surface (Cloud-tab FileCard, My-branch LocalFileCard). Lives here
// instead of inline so the FLIP animation + sticky-mode dismissal
// logic stays in one place — adding a third caller is a one-line
// change instead of another 100-line copy-paste.
//
// State machine:
//   tooltip  (hover)             — pillPos set, !menuMode, !confirming
//   menu     (right-click)       — pillPos set, menuMode, !confirming
//   confirm  (menu item w/      — pillPos set, menuMode, confirming
//             .confirm picked)
//
// Each transition runs the FLIP morph: snapshot old rect, let React
// commit the new shape, scale-down + animate-to-1. Same recipe in
// every direction so the visual feels uniform.
//
// Usage:
//   const morphPill = useMorphPill({
//     hoverContent: 'Tooltip text',
//     menuItems: [
//       { label: 'Open',  onClick: () => …, key: 'open' },
//       {
//         label: 'Hide',  onClick: () => onDelete?.(file),
//         danger: true,
//         confirm: {
//           title: 'Hide this file?',
//           message: 'The file will be removed from disk…',
//           confirmLabel: 'Hide',
//           cancelLabel: 'Cancel',
//         },
//       },
//     ],
//   });
//
// `menuItems` entries: `{ label, onClick, key?, danger?, disabled?, confirm? }`.
// When `confirm` is set, clicking the item morphs the pill into a
// confirmation panel instead of firing onClick directly. Confirm
// there runs onClick + closes; Cancel just closes.
//
// Falsy entries in menuItems are filtered, so callers can write
// `[itemA, condition && itemB, itemC]` and have the conditional
// collapse cleanly without per-render branching.
export function useMorphPill({ hoverContent, menuItems, menuHeader, prompt, className = '', placement = 'right', stickyMenu = false, instant = false }) {
  const [pillPos, setPillPos] = useState(null);
  const [menuMode, setMenuMode] = useState(false);
  // True while the menu is playing its exit animation — still mounted, but on
  // its way out (see closeMenu / MENU_EXIT_MS).
  const [closing, setClosing] = useState(false);
  const exitTimerRef = useRef(null);
  // Mirror of `closing` for the handlers. They can run from a listener bound in
  // an earlier render (a document-level right-click handler, say), where the
  // captured `closing` is stale — and a stale `false` there would skip the
  // reset and leave the pill stuck in its faded-out, click-through state.
  const closingRef = useRef(false);
  // Item currently in its confirmation step (or null). Holds the
  // whole item so the panel can read title / message / labels / the
  // onClick to fire when the user confirms. Mutually exclusive with
  // the menu list — when this is set, the menu items aren't rendered.
  const [confirmingItem, setConfirmingItem] = useState(null);
  // Key of the menu item whose inline submenu is expanded (or null). A menu
  // item carrying a `submenu` array acts like a nested dropdown: clicking it
  // expands its sub-items in place (the pill FLIP-morphs to the taller shape)
  // rather than firing an action. Mutually independent of confirm/prompt.
  const [openSubKey, setOpenSubKey] = useState(null);
  // When the side flyout would overflow the right viewport edge, open it to the
  // LEFT of the menu instead. Measured after it renders (see effect below).
  const [subFlipLeft, setSubFlipLeft] = useState(false);
  // Prompt mode — a confirm panel that ALSO carries a free-text input
  // (e.g. "reason for rejecting"). Opened directly via handleOpenPrompt
  // (a left-click, not the right-click menu) so the tooltip morphs
  // straight into the input panel. `prompt` config shape:
  //   { title?, message?, placeholder?, confirmLabel?, cancelLabel?,
  //     danger?, requireText?, onSubmit(text) }
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const pillRef = useRef(null);
  const subRef = useRef(null);
  const oldPillRectRef = useRef(null);
  // The element that opened the menu (the trigger button / card). Tracked so
  // the global outside-mousedown dismissal can IGNORE a press on the trigger
  // itself — otherwise pressing an already-open trigger would close it on
  // mousedown and the trigger's own click handler would immediately reopen it
  // (the menu is portalled, so it never "contains" the trigger). Letting the
  // click handler own the toggle makes a second press close-and-stay-closed.
  const triggerElRef = useRef(null);
  // Whether pressing the trigger again is what CLOSES the menu (the left-click
  // toggles) — only then is it exempt from outside-click dismissal.
  const triggerTogglesRef = useRef(false);
  // Grace timer for menu dismissal. Rather than closing the instant the
  // cursor leaves the pill (which made the menu vanish when crossing the
  // small offset gap from the trigger, or skimming an edge), we wait a beat
  // and cancel the close if the cursor comes back over the pill.
  const closeTimerRef = useRef(null);
  const cancelScheduledClose = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => { closeTimerRef.current = null; closeMenu(); }, 280);
  };

  const handleMouseMove = (e) => {
    if (menuMode || promptOpen) return;
    setPillPos({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) });
  };
  const handleMouseLeave = () => {
    if (menuMode || promptOpen) return;
    setPillPos(null);
  };
  const handleContextMenu = (e) => {
    e.preventDefault();
    cancelExit();   // right-clicking again mid-fade re-opens rather than half-fading
    // Snapshot the pill's current (tooltip-size) rect BEFORE the
    // menu-mode flip so the FLIP effect below has a "from" size to
    // scale up from. Captured here in the event handler rather than
    // in the effect because by the time the effect runs the DOM is
    // already at menu-size.
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    triggerElRef.current = e.currentTarget;
    // A right-click opens the menu; it never TOGGLES it shut, so the trigger
    // gets no exemption from outside-click dismissal. This matters because a
    // background menu's trigger is a whole surface (the Files page frame) —
    // exempting it would swallow the click-away over most of the window.
    triggerTogglesRef.current = false;
    setPillPos({ x: toLayoutPx(e.clientX), y: toLayoutPx(e.clientY) });
    setMenuMode(true);
  };
  // Tear the menu down for real. Split out of closeMenu so the dismissal can
  // be deferred behind an exit animation (see below).
  const finishClose = () => {
    if (exitTimerRef.current) { clearTimeout(exitTimerRef.current); exitTimerRef.current = null; }
    closingRef.current = false;
    setClosing(false);
    setMenuMode(false);
    setConfirmingItem(null);
    setOpenSubKey(null);
    setSubFlipLeft(false);
    setPromptOpen(false);
    setPromptText('');
    setPromptBusy(false);
    setPillPos(null);
    oldPillRectRef.current = null;
    triggerElRef.current = null;
  };

  // Dismissal is animated: the pill stays mounted with `.is-closing` for one
  // short fade, THEN the state is torn down. The exit fades opacity only —
  // never transform — because the pill's position is an inline transform the
  // FLIP code owns, and a CSS animation would override it mid-flight and fling
  // the menu to the corner as it left.
  const closeMenu = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (closingRef.current) return;             // already leaving
    if (!menuMode && !promptOpen) { finishClose(); return; }  // hover pill — nothing to animate
    closingRef.current = true;
    setClosing(true);
    exitTimerRef.current = setTimeout(finishClose, MENU_EXIT_MS);
  };

  // Re-opening mid-fade cancels it, so a fast right-click → right-click never
  // leaves a half-faded menu behind.
  const cancelExit = () => {
    if (exitTimerRef.current) { clearTimeout(exitTimerRef.current); exitTimerRef.current = null; }
    closingRef.current = false;
    setClosing(false);
  };

  // LEFT-click entry into menu mode. Mirrors handleContextMenu (same FLIP
  // snapshot + cursor anchoring) but for a normal click, so a left-click
  // morphs the already-showing hover tooltip straight into the menu — the
  // exact right-click feel, on the primary button. Toggles closed if the
  // menu is already open. Used by the title bar's Split / Theme controls.
  const handleOpenMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only an OPEN menu toggles shut; one that's already fading gets re-opened
    // by the same press instead of being left to finish dying.
    if (menuMode && !closingRef.current) { closeMenu(); return; }
    cancelExit();
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    triggerElRef.current = e.currentTarget;
    triggerTogglesRef.current = true;   // a second press on it closes the menu
    const rect = e.currentTarget?.getBoundingClientRect?.();
    const x = toLayoutPx(e.clientX || (rect ? rect.left : 0));
    const y = toLayoutPx(e.clientY || (rect ? rect.bottom : 0));
    setPillPos((prev) => prev || { x, y });
    setMenuMode(true);
  };

  // Left-click entry into prompt mode. Morphs the (already-showing,
  // from hover) tooltip straight into the input panel — snapshot the
  // tooltip rect first so the FLIP effect has a "from" shape. Keeps
  // the current cursor-anchored pillPos when present; falls back to
  // the trigger's own rect for keyboard activation (which reports a
  // 0,0 cursor).
  const handleOpenPrompt = (e) => {
    if (!prompt) return;
    e.preventDefault();
    e.stopPropagation();
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    triggerElRef.current = e.currentTarget;
    const rect = e.currentTarget?.getBoundingClientRect?.();
    const x = toLayoutPx(e.clientX || (rect ? rect.left : 0));
    const y = toLayoutPx(e.clientY || (rect ? rect.bottom : 0));
    setPromptText('');
    setPromptBusy(false);
    setPillPos((prev) => prev || { x, y });
    setPromptOpen(true);
  };

  const handlePromptSubmit = async () => {
    if (!prompt || promptBusy) return;
    const text = promptText.trim();
    if (prompt.requireText && !text) return;
    setPromptBusy(true);
    try {
      await prompt.onSubmit?.(text);
    } finally {
      closeMenu();
    }
  };

  // Click handler for an item in the menu. If the item carries a
  // `confirm` payload, we morph the pill into a confirmation step
  // instead of firing the action. Otherwise the action runs and the
  // menu closes — behaviour matches the pre-confirm-step version.
  const handleMenuItemClick = (item) => {
    if (item.submenu) {
      // Toggle the side flyout. It's a SEPARATE floating panel (not part of the
      // pill's box), so there's no pill-height morph to snapshot here.
      const k = item.key || item.label;
      setSubFlipLeft(false);
      setOpenSubKey((cur) => (cur === k ? null : k));
      return;
    }
    if (item.confirm) {
      // Snapshot CURRENT (menu) rect so the menu → confirm FLIP has
      // a "from" size. Same FLIP recipe the right-click step uses.
      if (pillRef.current) {
        oldPillRectRef.current = pillRef.current.getBoundingClientRect();
      }
      setConfirmingItem(item);
      return;
    }
    closeMenu();
    item.onClick?.();
  };

  const handleConfirmYes = () => {
    const item = confirmingItem;
    closeMenu();
    item?.onClick?.();
  };

  // Clear any pending close timer if the host unmounts mid-grace.
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  // Sticky-mode dismissal: outside click, Escape, or scroll. Applies
  // in BOTH menu and confirm modes — clicking outside the confirmation
  // is the same as Cancel; Escape too.
  useEffect(() => {
    if (!menuMode && !promptOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    const onDown = (e) => {
      if (pillRef.current && pillRef.current.contains(e.target)) return;
      // A press on a TOGGLING trigger isn't an "outside" click — let the
      // trigger's own click handler decide (it toggles the menu closed).
      // Without this, mousedown would close the menu here and the ensuing
      // click would reopen it, so a second press never stuck.
      // Only for left-click triggers: a right-click-opened menu has no toggle,
      // and its "trigger" can be a whole page surface, which would otherwise
      // swallow the click-away across most of the window.
      if (triggerTogglesRef.current && triggerElRef.current?.contains(e.target)) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    // Scroll-dismiss keeps a cursor-anchored menu from drifting off its
    // anchor. A stickyMenu (the split-layout control) opts OUT: it's anchored
    // to a fixed title-bar button AND acting on it (selecting a layout)
    // reflows the panes, which fires scroll events — that must NOT tear the
    // menu down while the user is trying layouts.
    if (!stickyMenu) window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuMode, promptOpen, stickyMenu]);

  // Position-clamp — same recipe as the shared Tooltip: keep the pill
  // inside the viewport on both axes, snap on first mount so the CSS
  // transition doesn't visibly slide in from (0,0). Re-runs on menu-
  // mode AND confirm-mode flips too so each shape gets re-clamped.
  useLayoutEffect(() => {
    if (!pillPos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = toLayoutPx(window.innerWidth);
    const vh = toLayoutPx(window.innerHeight);
    // `placement: 'left'` anchors the pill's RIGHT edge near the cursor and
    // grows it leftward (used by the title bar's right-edge buttons so the
    // menu doesn't run off-screen); default grows rightward from the cursor.
    const desiredX = placement === 'left' ? pillPos.x - 8 - w : pillPos.x + 8;
    const x = Math.max(8, Math.min(desiredX, vw - 8 - w));
    const y = Math.max(8, Math.min(pillPos.y + 8, vh - 8 - h));
    const isFirstSet = !pill.style.transform;
    if (isFirstSet) {
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else if (instant) {
      // Re-anchoring an instant menu (a second right-click elsewhere) should
      // jump, not glide across the screen from where it was.
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pillPos, menuMode, confirmingItem, promptOpen, placement, openSubKey]);

  // FLIP morph — fires whenever the pill's RENDERED SHAPE changes,
  // not just on menu-mode entry. Three transitions all use the same
  // recipe:
  //   tooltip → menu     (handleContextMenu sets oldPillRectRef)
  //   menu    → confirm  (handleMenuItemClick sets oldPillRectRef)
  //   confirm → menu     (Cancel — sets oldPillRectRef inside the
  //                       confirm panel's Cancel onClick)
  //
  //   F (First) — captured as oldPillRectRef before the React commit.
  //   L (Last)  — measured here, after React has rendered the new shape.
  //   I (Invert) — apply an inline transform that scales the pill
  //               DOWN/UP so it visually matches the old shape.
  //   P (Play)  — transition back to scale(1) using a transform-only
  //               animation. Composites on the GPU, no layout thrash.
  useLayoutEffect(() => {
    const oldRect = oldPillRectRef.current;
    if (!oldRect) return;
    // `instant` opts out of the morph entirely: a menu with no hover tooltip
    // behind it (the Files background right-click) has nothing to morph FROM,
    // so the scale-up just reads as the menu taking 220ms to show up.
    if (instant) { oldPillRectRef.current = null; return; }
    const pill = pillRef.current;
    if (!pill) return;
    const newRect = pill.getBoundingClientRect();
    if (newRect.width === 0 || newRect.height === 0) {
      oldPillRectRef.current = null;
      return;
    }
    const sx = oldRect.width / newRect.width;
    const sy = oldRect.height / newRect.height;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(pill.style.transform || '');
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    // Left-placed pills share a RIGHT edge between tooltip + menu sizes, so
    // pivot the scale there (top right) to keep the morph seamless; default
    // pivots top left.
    pill.style.transformOrigin = placement === 'left' ? 'top right' : 'top left';
    pill.style.transition = 'none';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    void pill.offsetWidth;
    pill.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(1, 1)`;
    oldPillRectRef.current = null;
  }, [menuMode, confirmingItem, promptOpen, placement, openSubKey]);

  // Side-flyout edge guard: after the submenu renders (default: opens to the
  // RIGHT of the menu), measure it; if it runs past the right viewport edge,
  // flip it to open leftward. Runs once per open — setting the flip state
  // doesn't re-trigger this (deps unchanged), so it can't oscillate.
  useLayoutEffect(() => {
    if (!openSubKey) { return; }
    const el = subRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) setSubFlipLeft(true);
  }, [openSubKey, pillPos]);

  // Cancel out of the confirm step back to the menu. Snapshots the
  // CURRENT (confirm panel) rect so the reverse FLIP shrinks the
  // confirm shape DOWN into the menu shape just like the forward
  // morph grew it up.
  const handleConfirmCancel = () => {
    // Cancel dismisses everything (the confirm panel AND the menu it morphed out
    // of) rather than stepping back to the menu.
    closeMenu();
  };

  const filteredItems = (menuItems || []).filter(Boolean);

  // Render branches: confirm > menu > tooltip. Pill className gets a
  // modifier per state so the CSS can size + style each shape
  // distinctly while keeping the same root element so FLIP works.
  let content;
  let pillClassMod;
  if (promptOpen) {
    // Reuses the confirm panel's chrome (.is-menu shell + confirm
    // title/message/actions classes) and slots a textarea between the
    // message and the action row.
    pillClassMod = ' is-menu is-confirm is-prompt';
    const p = prompt || {};
    const isDanger = Boolean(p.danger);
    const submitDisabled = promptBusy || (p.requireText && !promptText.trim());
    content = (
      // The pill is portalled, but React replays its events through the
      // React tree — so without stopping them, clicks/keys here bubble to
      // whatever element rendered the pill (e.g. a selectable card) and
      // trigger its handlers. Stop click + keydown propagation so the
      // panel behaves like the standalone dialog it looks like.
      <div
        className="project-files-morph-confirm project-files-morph-prompt"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {p.title && (
          <div className="project-files-morph-confirm-title">{p.title}</div>
        )}
        {p.message && (
          <p className="project-files-morph-confirm-message">{p.message}</p>
        )}
        <textarea
          className="project-files-morph-prompt-input"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder={p.placeholder || ''}
          rows={3}
          autoFocus
          // Cmd/Ctrl+Enter submits; plain Enter stays a newline so the
          // reason can be multi-line. Keystrokes are kept from bubbling
          // to the host element (a Space/Enter there could toggle a
          // selectable card behind the portal). Escape is the exception
          // — it must propagate so the global dismiss handler closes us.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handlePromptSubmit();
            }
          }}
        />
        <div className="project-files-morph-confirm-actions">
          <button
            type="button"
            className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel"
            onClick={closeMenu}
          >
            {p.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            className={`project-files-morph-confirm-btn ${isDanger ? 'project-files-morph-confirm-btn-danger' : 'project-files-morph-confirm-btn-primary'}`}
            onClick={handlePromptSubmit}
            disabled={submitDisabled}
          >
            {promptBusy ? '…' : (p.confirmLabel || 'Submit')}
          </button>
        </div>
      </div>
    );
  } else if (confirmingItem) {
    const c = confirmingItem.confirm || {};
    const isDanger = Boolean(confirmingItem.danger);
    // Danger confirms (Delete / Hide) tint the whole panel to match the red
    // delete button the user clicked, so the destructive action reads through
    // the morph, not just on the confirm button.
    pillClassMod = ` is-menu is-confirm${isDanger ? ' is-danger' : ''}`;
    content = (
      <div className="project-files-morph-confirm">
        {isDanger && (
          <div className="project-files-morph-confirm-header">
            <span className="project-files-morph-confirm-header-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <span className="project-files-morph-confirm-header-text">
              <span className="project-files-morph-confirm-header-title">
                {c.count != null ? (
                  <>Delete <span className="project-files-morph-confirm-header-count">{c.count}</span> file{c.count === 1 ? '' : 's'}?</>
                ) : c.title}
              </span>
              {c.subtitle && (
                <span className="project-files-morph-confirm-header-subtitle">{c.subtitle}</span>
              )}
            </span>
          </div>
        )}
        {c.title && !isDanger && (
          <div className="project-files-morph-confirm-title">{c.title}</div>
        )}
        {c.message && (
          <p className="project-files-morph-confirm-message">{c.message}</p>
        )}
        <div className="project-files-morph-confirm-actions">
          <button
            type="button"
            className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel"
            onClick={handleConfirmCancel}
          >
            {c.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            className={`project-files-morph-confirm-btn ${isDanger ? 'project-files-morph-confirm-btn-danger' : 'project-files-morph-confirm-btn-primary'}`}
            onClick={handleConfirmYes}
            autoFocus
          >
            {c.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    );
  } else if (menuMode) {
    pillClassMod = ' is-menu';
    // Optional header slot above the item list (e.g. the chat's quick-
    // reaction emoji strip). A render-prop form receives closeMenu so
    // header controls can dismiss the pill after acting. Files passes
    // nothing, so this is inert there.
    const header = typeof menuHeader === 'function' ? menuHeader(closeMenu) : menuHeader;
    content = (
      <>
        {header}
        <ul className="project-files-morph-list">
          {filteredItems.map((item, i) => {
            const itemKey = item.key || item.label || i;
            const subOpen = item.submenu && openSubKey === (item.key || item.label);
            return (
              <li key={itemKey} role="none">
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup={item.submenu ? 'menu' : undefined}
                  aria-expanded={item.submenu ? Boolean(subOpen) : undefined}
                  className={`project-files-morph-item${item.danger ? ' project-files-morph-item-danger' : ''}${item.submenu ? ' project-files-morph-item-parent' : ''}${subOpen ? ' is-open' : ''}${item.className ? ` ${item.className}` : ''}`}
                  onClick={() => handleMenuItemClick(item)}
                  disabled={item.disabled || false}
                >
                  {item.label}
                  {item.submenu && <span className="project-files-morph-caret" aria-hidden="true" />}
                </button>
                {subOpen && (
                  <ul ref={subRef} className={`project-files-morph-sublist${subFlipLeft ? ' flip-left' : ''}`}>
                    {(item.submenu || []).filter(Boolean).map((sub, j) => {
                      // A sub-item button (closes the menu + fires its action).
                      const subButton = (it, k) => (
                        <button
                          key={it.key || it.label || k}
                          type="button"
                          role="menuitem"
                          className="project-files-morph-item project-files-morph-subitem"
                          onClick={() => { closeMenu(); it.onClick?.(); }}
                          disabled={it.disabled || false}
                        >
                          {it.label}
                        </button>
                      );
                      // A grouped set (optional heading + items) wrapped in one
                      // box — used to ring the "Build with AI" types with the
                      // animated AI border.
                      if (sub.aiGroup) {
                        return (
                          <li key={sub.key || `g${j}`} role="none">
                            <div className="project-files-morph-ai-group">
                              {sub.heading && <div className="project-files-morph-subhead">{sub.heading}</div>}
                              {(sub.items || []).filter(Boolean).map((it, k) => subButton(it, k))}
                            </div>
                          </li>
                        );
                      }
                      if (sub.heading) {
                        return (
                          <li key={sub.key || `h${j}`} role="none">
                            <div className="project-files-morph-subhead">{sub.heading}</div>
                          </li>
                        );
                      }
                      return <li key={sub.key || sub.label || j} role="none">{subButton(sub, j)}</li>;
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  } else {
    pillClassMod = '';
    content = <span className="project-files-morph-text">{hoverContent}</span>;
  }

  // Tooltip-mode pill grows visibly when hoverContent carries an
  // explicit newline (e.g. `Sent <date>\nEdited <date>`). Fully-
  // rounded ends (999px) only look right on a single-line pill; on
  // 2+ lines the half-circles pinch the corners and the shape reads
  // as a stretched stadium. Halving the radius for multi-line content
  // lets the longer pill keep a soft-corner look without going
  // sharp-rectangular. Driven by an `.is-multiline` modifier so the
  // visual rule lives in CSS.
  const isMultilineHover = !menuMode
    && !confirmingItem
    && typeof hoverContent === 'string'
    && hoverContent.includes('\n');
  const multilineMod = isMultilineHover ? ' is-multiline' : '';

  const node = pillPos ? createPortal(
    <div
      ref={pillRef}
      className={`tooltip project-files-morph-pill${pillClassMod}${multilineMod}${closing ? ' is-closing' : ''}${className ? ` ${className}` : ''}`}
      role={confirmingItem || promptOpen ? 'dialog' : menuMode ? 'menu' : 'tooltip'}
      aria-modal={confirmingItem || promptOpen ? 'true' : undefined}
      // In menu mode, cursor leaving the pill dismisses it after a short
      // grace period — UNLESS we're in the confirm step. Re-entering (or any
      // move over) the pill cancels the pending close, so crossing the small
      // offset gap from the trigger, or skimming an edge, no longer makes the
      // menu vanish. The confirm panel demands an explicit choice (Cancel,
      // Esc, outside-click), so its dismissal is intentionally inert here.
      // `stickyMenu` opts out of mouseleave auto-dismiss — for menus with
      // interactive content (inputs, multi-step controls) where a stray
      // cursor exit shouldn't tear the menu down mid-interaction. Such menus
      // close only on outside-click / Escape / a second trigger press.
      onMouseEnter={menuMode && !confirmingItem && !stickyMenu ? cancelScheduledClose : undefined}
      onMouseMove={(e) => {
        // Cursor-tracked spotlight + border shine (same language as the sidebar
        // rail): write the pointer position (pill-relative, layout px) into vars
        // the ::before / ::after gradients read, plus a per-button spot so each
        // button brightens toward the cursor like a nav item.
        const el = pillRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          el.style.setProperty('--spot-x', `${toLayoutPx(e.clientX - r.left)}px`);
          el.style.setProperty('--spot-y', `${toLayoutPx(e.clientY - r.top)}px`);
          const btn = e.target.closest('.project-files-morph-confirm-btn');
          if (btn) {
            const br = btn.getBoundingClientRect();
            btn.style.setProperty('--item-spot-x', `${toLayoutPx(e.clientX - br.left)}px`);
            btn.style.setProperty('--item-spot-y', `${toLayoutPx(e.clientY - br.top)}px`);
          }
        }
        if (menuMode && !confirmingItem && !stickyMenu) cancelScheduledClose();
      }}
      onMouseLeave={menuMode && !confirmingItem && !stickyMenu ? scheduleClose : undefined}
    >
      {content}
    </div>,
    document.body,
  ) : null;

  return {
    handleMouseMove,
    handleMouseLeave,
    handleContextMenu,
    handleOpenMenu,
    handleOpenPrompt,
    closeMenu,
    isMenuOpen: menuMode || promptOpen,
    node,
  };
}
