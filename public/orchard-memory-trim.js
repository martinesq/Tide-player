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

// Injects the "Trim memory usage" controls into the Settings view from plain
// DOM APIs, the same way orchard-marquee.js injects its effect -- see that
// file for why: this build's frontend is a known-good compiled bundle
// (restored from an older, working release) and is deliberately not being
// recompiled, so new controls are added by script after the fact instead of
// through a Vue source change.
//
// window.orchardMemoryTrim is exposed by the preload script regardless of
// which frontend build is running, so this works against any dist.
(function () {
  const SETTINGS_CONTENT_SELECTOR = '.settings-content';
  const SETTINGS_NAV_SELECTOR = '.settings-index';
  const SECTION_ID = 'settings-memory-trim';
  const MIN_INTERVAL_SECONDS = 1;
  const MAX_INTERVAL_SECONDS = 600;

  function alreadyInjected() {
    return Boolean(document.getElementById(SECTION_ID));
  }

  function buildNavLink() {
    const link = document.createElement('a');
    link.href = `#${SECTION_ID}`;
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'speed';
    const label = document.createElement('span');
    label.textContent = 'Performance';
    link.append(icon, label);
    return link;
  }

  // The real Settings rows use Quasar's <q-slider>, a custom element this
  // script cannot safely construct by hand. A plain number input gets the
  // same "pick an exact interval" job done without depending on Quasar's
  // internals, styled inline since the compiled Settings CSS is scoped to
  // its own component and never reaches a node this script creates.
  function styleNumberInput(input) {
    Object.assign(input.style, {
      color: '#fff',
      background: '#0000003d',
      border: '1px solid #ffffff1a',
      borderRadius: '4px',
      padding: '6px 10px',
      fontSize: '12px',
      width: '72px'
    });
  }

  function buildSection(initialState) {
    const section = document.createElement('section');
    section.id = SECTION_ID;
    section.className = 'settings-section';
    section.setAttribute('aria-labelledby', `${SECTION_ID}-title`);

    const heading = document.createElement('div');
    heading.className = 'settings-section__heading';
    const h2 = document.createElement('h2');
    h2.id = `${SECTION_ID}-title`;
    h2.textContent = 'Performance';
    const headingCopy = document.createElement('p');
    headingCopy.textContent = 'Experimental options for how Orchard uses system resources.';
    heading.append(h2, headingCopy);

    const toggleRow = document.createElement('div');
    toggleRow.className = 'settings-row';
    const toggleCopy = document.createElement('div');
    toggleCopy.className = 'settings-row__copy';
    const toggleLabel = document.createElement('label');
    toggleLabel.id = `${SECTION_ID}-label`;
    toggleLabel.textContent = 'Trim memory usage';
    const toggleDescription = document.createElement('p');
    toggleDescription.textContent = "Asks Windows to release each of Orchard's processes' idle memory back to "
      + 'the system on the interval below, the same way a RAM-cleaning utility does for a single program. This '
      + "does not reduce how much memory Orchard actually needs -- it comes back as soon as it's used again -- "
      + "so it won't help if Orchard feels slow, only if Task Manager's number bothers you.";
    toggleCopy.append(toggleLabel, toggleDescription);

    const optionGroup = document.createElement('div');
    optionGroup.className = 'settings-option-group';
    optionGroup.setAttribute('role', 'group');
    optionGroup.setAttribute('aria-labelledby', `${SECTION_ID}-label`);

    const onButton = document.createElement('button');
    onButton.type = 'button';
    onButton.className = 'settings-option';
    onButton.textContent = 'On';
    const offButton = document.createElement('button');
    offButton.type = 'button';
    offButton.className = 'settings-option';
    offButton.textContent = 'Off';
    optionGroup.append(onButton, offButton);
    toggleRow.append(toggleCopy, optionGroup);

    const intervalRow = document.createElement('div');
    intervalRow.className = 'settings-row';
    const intervalCopy = document.createElement('div');
    intervalCopy.className = 'settings-row__copy';
    const intervalLabel = document.createElement('label');
    const intervalInputId = `${SECTION_ID}-interval`;
    intervalLabel.setAttribute('for', intervalInputId);
    intervalLabel.textContent = 'Trim interval';
    const intervalDescription = document.createElement('p');
    intervalDescription.textContent = `How often to trim, in seconds (${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS}).`;
    intervalCopy.append(intervalLabel, intervalDescription);

    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.id = intervalInputId;
    intervalInput.min = String(MIN_INTERVAL_SECONDS);
    intervalInput.max = String(MAX_INTERVAL_SECONDS);
    intervalInput.step = '1';
    styleNumberInput(intervalInput);
    intervalRow.append(intervalCopy, intervalInput);

    const message = document.createElement('p');
    message.className = 'settings-connect__message';

    section.append(heading, toggleRow, intervalRow, message);

    function paintEnabled(enabled) {
      onButton.classList.toggle('settings-option--active', enabled);
      onButton.setAttribute('aria-pressed', String(enabled));
      offButton.classList.toggle('settings-option--active', !enabled);
      offButton.setAttribute('aria-pressed', String(!enabled));
    }

    function describe(state) {
      const seconds = state?.intervalSeconds ?? intervalInput.value;
      message.textContent = state?.enabled
        ? `Experimental: Orchard will trim its own processes' memory every ${seconds} second${seconds === 1 ? '' : 's'}. `
          + 'This does not reduce how much RAM Orchard needs, only how much Windows reports while nothing is using it.'
        : '';
    }

    function applyState(state) {
      if (!state) return;
      paintEnabled(Boolean(state.enabled));
      if (Number.isFinite(Number(state.intervalSeconds))) {
        intervalInput.value = String(state.intervalSeconds);
      }
      describe(state);
    }

    async function chooseEnabled(nextEnabled) {
      try {
        applyState(await window.orchardMemoryTrim.setEnabled(nextEnabled));
      } catch (error) {
        message.textContent = `Could not change this setting. ${error?.message || error}`;
      }
    }

    async function chooseInterval() {
      const value = Number(intervalInput.value);
      try {
        applyState(await window.orchardMemoryTrim.setIntervalSeconds(value));
      } catch (error) {
        message.textContent = `Could not change this setting. ${error?.message || error}`;
      }
    }

    onButton.addEventListener('click', () => chooseEnabled(true));
    offButton.addEventListener('click', () => chooseEnabled(false));
    // 'change' (not 'input') so this commits once the field is left or the
    // spinner buttons are clicked, not on every keystroke while typing.
    intervalInput.addEventListener('change', chooseInterval);
    applyState(initialState);

    return section;
  }

  async function inject() {
    if (alreadyInjected()) return;
    const content = document.querySelector(SETTINGS_CONTENT_SELECTOR);
    const nav = document.querySelector(SETTINGS_NAV_SELECTOR);
    if (!content || !nav || !window.orchardMemoryTrim?.getState) return;

    let state;
    try {
      state = await window.orchardMemoryTrim.getState();
    } catch {
      return;
    }
    if (!state?.available || alreadyInjected()) return;

    nav.appendChild(buildNavLink());
    content.appendChild(buildSection(state));
  }

  function boot() {
    void inject();
    new MutationObserver(() => void inject())
      .observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
