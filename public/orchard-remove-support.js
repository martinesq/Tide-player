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

// Removes the "Support" entry from the sidebar (both the full and the
// mini/compact rail), the same way orchard-marquee.js reaches into this
// build's frontend from plain DOM APIs instead of a Vue source change --
// this build's dist is deliberately not being recompiled, so UI tweaks are
// applied by script after the fact.
(function () {
  function removeSupportButtons() {
    document.querySelectorAll('button').forEach((button) => {
      const icon = button.querySelector('i, .q-icon');
      if (icon && icon.textContent.trim() === 'support_agent') {
        button.remove();
      }
    });
  }

  function boot() {
    removeSupportButtons();
    new MutationObserver(removeSupportButtons)
      .observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
