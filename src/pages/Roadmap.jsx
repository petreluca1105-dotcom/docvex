import React from 'react';
import PageMasthead from '../components/PageMasthead';

// Roadmap — what is being built next, and what shipped.
//
// Header only, for now: the page exists so the destination is real and the
// header language is settled, and the content lands here once there is a
// roadmap to show. Deliberately not a placeholder card saying "coming soon" —
// an empty page under a finished header reads as unwritten, which is true.
export default function Roadmap() {
  return (
    <div className="page-frame">
      <PageMasthead
        eyebrow="DocVex"
        eyebrowMuted="What's next"
        title="Roadmap"
      >
        What we are building, in the order we mean to build it — the features
        under way, the ones queued behind them, and what has already shipped.
      </PageMasthead>
    </div>
  );
}
