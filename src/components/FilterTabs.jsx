import React, { useLayoutEffect, useRef } from 'react';
import './FilterTabs.css';

// ── Filter tab strip ──────────────────────────────────────────────────────
// Flat tabs with ONE shared underline element that SLIDES to the active tab
// (transform + width transition in CSS). Built for the Activity feed's mini
// header, then lifted here when the project Settings tab needed the same
// treatment — sharing the component rather than copying it is what keeps the
// two literally identical instead of merely similar.
//
// Hosted inside a sticky mini header, the chain stretches to the bar's height
// so the underline straddles the bar's bottom edge. Standalone (the Settings
// strip), the host gives it a height and the underline rides its own bottom.
//
// `tabs` is [{ id, label }]. `underlineCat` tints the bar via data-cat — the
// Activity feed passes the active category so the line takes that category's
// colour; callers with no categories leave it out and get the accent.
export default function FilterTabs({ tabs, active, onSelect, className = '', underlineCat, ariaLabel = 'Filter' }) {
  const stripRef = useRef(null);
  const underlineRef = useRef(null);
  // False until the underline has been positioned once. The very first
  // placement (entering the tab) SNAPS into place — the bar starts at the CSS
  // initial width:0 / no transform, so letting the transition run would show
  // it sliding in from the strip's top-left corner on every mount.
  const placedRef = useRef(false);

  // Place the underline under the active tab. Re-runs when the active tab or
  // the tab set changes; a ResizeObserver re-places on width shifts (count
  // digits changing, the bar resizing).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const bar = underlineRef.current;
    if (!strip || !bar) return undefined;
    const place = () => {
      const btn = strip.querySelector(`[data-tab-id="${active}"]`);
      if (!btn) { bar.style.width = '0px'; return; }
      const snap = !placedRef.current;
      if (snap) bar.style.transition = 'none';
      // Wrap the label text with a symmetric overhang on each side so the
      // bar reads wider than the word and stays centred under it. No clamp
      // to the button's box: the first tab has no leading padding, so its
      // underline deliberately pokes past the tab's left edge (the strip's
      // overflow is visible). Offsets are relative to the button
      // (position: relative).
      const EXT = 8;
      const label = btn.querySelector('.activity-filter-label');
      const start = (label ? label.offsetLeft : 0) - EXT;
      const end = (label ? label.offsetLeft + label.offsetWidth : btn.offsetWidth) + EXT;
      const x = btn.offsetLeft + start;
      // Ride the host bar's bottom edge like the chat toolbar's tab line
      // (.dvx-tab.is-active::after): the tabs stretch to the bar's full
      // height, so the button's bottom IS the bar's bottom border — place the
      // line straddling it, nudged the same 40% past the midpoint as chat
      // (line half-height 1.6px − 40%-of-height 1.28px = 0.32px above the
      // edge for the line's top).
      const y = btn.offsetTop + btn.offsetHeight - 0.32;
      bar.style.width = `${Math.max(end - start, 0)}px`;
      bar.style.transform = `translate(${x}px, ${y}px)`;
      if (snap) {
        // Commit the untransitioned placement, then hand movement back to the
        // stylesheet transition for subsequent tab changes.
        void bar.offsetWidth;
        bar.style.transition = '';
      }
      placedRef.current = true;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [active, tabs]);

  return (
    <div
      className={`activity-filters${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      ref={stripRef}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-cat={tab.id}
            data-tab-id={tab.id}
            className={`activity-filter${isActive ? ' is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <span className="activity-filter-label">{tab.label}</span>
          </button>
        );
      })}
      <span
        className="activity-filter-underline"
        data-cat={underlineCat ?? active}
        ref={underlineRef}
        aria-hidden="true"
      />
    </div>
  );
}
