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

// Some tracks resolve to a music video that is not just a silent audio
// fallback (musicVideoAudioFallback is false), and the Vue app starts the
// video player un-minimized for those -- a full-viewport overlay that reads
// as "it jumped into fullscreen" the instant playback begins. There is no
// setting for this; the component always starts big in that case and only
// goes small once the listener clicks "Minimize video".
//
// This clicks that same button on their behalf, every time the video player
// appears in its big state, so playback always starts with just the bottom
// bar and fullscreen stays something the listener opts into.
(function () {
  function minimizeIfShowingBig() {
    const player = document.querySelector('.video-player');
    if (!player || player.classList.contains('video-player--mini')) return;
    if (window.getComputedStyle(player).display === 'none') return;

    for (const icon of player.querySelectorAll('i, .q-icon')) {
      if (icon.textContent.trim() === 'picture_in_picture_alt') {
        icon.closest('button')?.click();
        break;
      }
    }
  }

  function boot() {
    minimizeIfShowingBig();
    new MutationObserver(minimizeIfShowingBig).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });
    // Safety net: catches state the observer above might miss (e.g. the
    // transition wrapper changing visibility without a tracked attribute).
    setInterval(minimizeIfShowingBig, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
