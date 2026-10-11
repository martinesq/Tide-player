/*
 * Copyright (C) 2026 SFG545
 *
 * This file is part of Orchard.
 *
 * Orchard is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * Orchard is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Orchard. If not, see <https://www.gnu.org/licenses/>.
 */

// Makes the now-playing title scroll one-way (never bounces back) whenever
// it's too long to fit, in both the bottom player bar and the fullscreen
// player. Implemented without touching the title element's own text node --
// only a class, a data attribute and a CSS variable are added -- so Vue keeps
// patching the real (now invisibly-colored) text normally on track changes.
// A pure CSS @keyframes animation does the scrolling; this script only
// decides whether it should run and how fast. Disabled while Performance
// mode is on.
(function () {
  const PIXELS_PER_SECOND = 32;
  const PIXELS_PER_SECOND_FULLSCREEN = 52;
  const SPEED_MULTIPLIERS = { slow: 0.65, normal: 1, fast: 1.6 };
  const MIN_OVERFLOW_PX = 4;
  const TITLE_SELECTOR = '.player-bar .mini-title, .fullscreen-player__track-copy > div > strong';
  const CONTAINER_SELECTOR = '.player-bar, .fullscreen-player__track-copy';

  function performanceModeActive() {
    return document.documentElement.dataset.performanceMode === 'true';
  }

  function speedSetting() {
    try {
      return localStorage.getItem('orchard:marqueeSpeed') || 'normal';
    } catch {
      return 'normal';
    }
  }

  function clear(el) {
    el.classList.remove('orchard-marquee-host');
    el.style.removeProperty('--orchard-marquee-duration');
    delete el.dataset.orchardMarqueeText;
    delete el.dataset.orchardMarqueeSpeed;
  }

  function evaluate(el) {
    const text = (el.textContent || '').trim();
    const isHost = el.classList.contains('orchard-marquee-host');

    if (!text || performanceModeActive()) {
      if (isHost) clear(el);
      return;
    }

    // Measured with the host class' own layout rules already in effect (not
    // toggled off first), so the box being measured is the exact box that
    // will be clipped -- flipping the class before measuring made the width
    // (and therefore the overflow verdict) unstable and caused flicker.
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= MIN_OVERFLOW_PX) {
      if (isHost) clear(el);
      return;
    }

    const speedKey = speedSetting();
    if (isHost && el.dataset.orchardMarqueeText === text && el.dataset.orchardMarqueeSpeed === speedKey) return;

    const inFullscreen = Boolean(el.closest('.fullscreen-player__track-copy'));
    const base = inFullscreen ? PIXELS_PER_SECOND_FULLSCREEN : PIXELS_PER_SECOND;
    const speed = base * (SPEED_MULTIPLIERS[speedKey] || 1);
    const duration = Math.max(4, (2 * el.scrollWidth) / speed);
    el.dataset.orchardMarqueeText = text;
    el.dataset.orchardMarqueeSpeed = speedKey;
    el.style.setProperty('--orchard-marquee-duration', `${duration}s`);
    el.classList.add('orchard-marquee-host');
  }

  function scanAll() {
    document.querySelectorAll(TITLE_SELECTOR).forEach(evaluate);
  }

  function boot() {
    const resizeObserver = new ResizeObserver(scanAll);
    const watchedContainers = new WeakSet();
    const watchContainers = () => {
      document.querySelectorAll(CONTAINER_SELECTOR).forEach((container) => {
        if (watchedContainers.has(container)) return;
        watchedContainers.add(container);
        resizeObserver.observe(container);
      });
    };

    const attributeObserver = new MutationObserver(scanAll);
    attributeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-performance-mode']
    });

    const bodyObserver = new MutationObserver(() => {
      watchContainers();
      scanAll();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

    watchContainers();
    window.addEventListener('resize', scanAll);
    // Safety net: catches state the observers above might miss (e.g. a font
    // finishing its load and reflowing the title's width).
    setInterval(scanAll, 2000);
    scanAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
