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

// Owned by the main process, like proxy mode in networkActions.js: it decides
// whether the toggle is even available (Windows only) and persists it. The
// renderer only reads it back and asks for changes.
import { computed, ref } from 'vue';

export function installMemoryTrimActions(ctx) {
  ctx.memoryTrimEnabled = ref(false);
  ctx.memoryTrimAvailable = ref(false);
  ctx.memoryTrimIntervalSeconds = ref(15);
  ctx.memoryTrimMessage = ref('');

  function applyState(state) {
    ctx.memoryTrimEnabled.value = Boolean(state?.enabled);
    ctx.memoryTrimAvailable.value = Boolean(state?.available);
    if (Number.isFinite(Number(state?.intervalSeconds))) {
      ctx.memoryTrimIntervalSeconds.value = Number(state.intervalSeconds);
    }
    const seconds = ctx.memoryTrimIntervalSeconds.value;
    ctx.memoryTrimMessage.value = ctx.memoryTrimEnabled.value
      ? `Experimental: Orchard will trim its own processes’ memory every ${seconds} second${seconds === 1 ? '' : 's'}. `
        + 'This does not reduce how much RAM Orchard needs, only how much Windows reports while nothing is using it. '
        + 'Tell us if it makes playback less smooth.'
      : '';
  }

  ctx.loadMemoryTrimState = async function loadMemoryTrimState() {
    if (!window.orchardMemoryTrim?.getState) return;
    const state = await window.orchardMemoryTrim.getState().catch(() => null);
    if (state) applyState(state);
  };

  ctx.setMemoryTrimEnabled = async function setMemoryTrimEnabled(value) {
    if (!window.orchardMemoryTrim?.setEnabled) return;
    try {
      applyState(await window.orchardMemoryTrim.setEnabled(value));
    } catch (error) {
      ctx.memoryTrimMessage.value = `Could not change this setting. ${error?.message || error}`;
    }
  };

  ctx.setMemoryTrimIntervalSeconds = async function setMemoryTrimIntervalSeconds(seconds) {
    if (!window.orchardMemoryTrim?.setIntervalSeconds) return;
    try {
      applyState(await window.orchardMemoryTrim.setIntervalSeconds(seconds));
    } catch (error) {
      ctx.memoryTrimMessage.value = `Could not change this setting. ${error?.message || error}`;
    }
  };

  ctx.memoryTrimToggle = computed({
    get: () => ctx.memoryTrimEnabled.value,
    set: (value) => { void ctx.setMemoryTrimEnabled(value); }
  });
}
