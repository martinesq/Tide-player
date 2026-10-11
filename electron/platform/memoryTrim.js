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

// Periodically trims the resident memory of this app's own OS processes --
// never anything else running on the machine, and never the system-wide
// standby list an external RAM-cleaning utility also offers to purge.
//
// Scope, precisely: `app.getAppMetrics()` only ever lists processes Electron
// itself spawned for this app (its renderers, its GPU process, its own
// utility children), so the PIDs handed to the native addon are always
// Orchard's own. `EmptyWorkingSet` (native/platform/memory_trim.cpp) only
// ever evicts the pages belonging to the one process handle it's given, back
// onto that page's own standby list. The *global* standby list and its "low
// priority" partition are a different, shared structure every process on the
// machine has pages in, and purging those deliberately needs a privilege
// unrelated to owning a single process handle and would reach far past
// Orchard's own processes -- so that part of what the listener's external
// tool does is intentionally left to that tool, not reimplemented here.
//
// None of this reduces how much memory Orchard actually needs: a trimmed
// page comes right back the moment something touches it again. It only asks
// Windows to stop counting it against this app's working set until then --
// the same trade-off the external tool's own "Working Set" pass makes. This
// is why it ships behind an off-by-default Settings toggle rather than
// always on.
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IPC_CHANNELS } from '../../shared/ipcChannels.js';

const require = createRequire(import.meta.url);
const { MEMORY_TRIM } = IPC_CHANNELS;

export const MEMORY_TRIM_PREFERENCES_FILENAME = 'memory-trim-preferences.json';
export const DEFAULT_INTERVAL_SECONDS = 15;
// A floor, not just a default: calling EmptyWorkingSet for every one of this
// app's processes has a real (if small) cost, and Windows needs a moment to
// actually walk and evict a process's pages -- going much below this would
// pay that cost more often than it could possibly matter.
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 600;

export function clampIntervalSeconds(value) {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, seconds));
}

async function readStoredPreferences(filePath) {
  try {
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      enabled: Boolean(stored?.enabled),
      intervalSeconds: clampIntervalSeconds(stored?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
    };
  } catch {
    return { enabled: false, intervalSeconds: DEFAULT_INTERVAL_SECONDS };
  }
}

async function writeStoredPreferences(filePath, preferences) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function registerMemoryTrim({
  app,
  ipcMain,
  modulePath,
  log = () => {},
  // Injectable for tests; the real default is Windows-only because the
  // native addon resolves to a no-op everywhere else.
  available = process.platform === 'win32',
  // Test-only override, in milliseconds: bypasses the seconds-granularity
  // preference entirely so tests don't have to wait on real seconds. Real
  // callers never pass this -- the cadence they get is whatever is stored
  // (or the default), always in whole seconds.
  intervalMs,
  loadNativeAddon = require
}) {
  const preferencesPath = path.join(app.getPath('userData'), MEMORY_TRIM_PREFERENCES_FILENAME);
  let enabled = false;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let timer = null;
  let addon = null;
  let addonLoadFailed = false;

  function loadAddon() {
    if (addon || addonLoadFailed) return addon;
    try {
      addon = loadNativeAddon(modulePath);
    } catch (error) {
      addonLoadFailed = true;
      log('memory-trim-unavailable', {
        errorMessage: String(error?.message || error || 'load failed').slice(0, 300)
      });
    }
    return addon;
  }

  function trimOnce() {
    const native = loadAddon();
    if (typeof native?.trimWorkingSet !== 'function') return;
    for (const { pid } of app.getAppMetrics()) {
      try {
        native.trimWorkingSet(pid);
      } catch {
        // One process refusing (already exited, access denied) must not stop
        // the rest of this app's processes from being trimmed.
      }
    }
  }

  function effectiveIntervalMs() {
    return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : intervalSeconds * 1000;
  }

  function applyTimer() {
    clearInterval(timer);
    timer = null;
    if (!available || !enabled) return;
    trimOnce();
    timer = setInterval(trimOnce, effectiveIntervalMs());
  }

  function state() {
    return { available, enabled, intervalSeconds };
  }

  async function persist() {
    await writeStoredPreferences(preferencesPath, { enabled, intervalSeconds }).catch((error) => {
      log('memory-trim-preference-write-failed', {
        errorMessage: String(error?.message || error || 'write failed').slice(0, 300)
      });
    });
  }

  ipcMain.handle(MEMORY_TRIM.GET_STATE, () => state());
  ipcMain.handle(MEMORY_TRIM.SET_ENABLED, async (_event, value) => {
    if (!available) return state();
    const next = Boolean(value);
    if (next !== enabled) {
      enabled = next;
      await persist();
      applyTimer();
    }
    return state();
  });
  ipcMain.handle(MEMORY_TRIM.SET_INTERVAL_SECONDS, async (_event, value) => {
    if (!available) return state();
    const next = clampIntervalSeconds(value);
    if (next !== intervalSeconds) {
      intervalSeconds = next;
      await persist();
      // Restarts the running interval on the new cadence immediately,
      // instead of waiting out whatever was left of the old one.
      applyTimer();
    }
    return state();
  });

  return {
    /** Applies the stored preferences. Safe to call even when unavailable. */
    async restore() {
      if (available) {
        const stored = await readStoredPreferences(preferencesPath);
        enabled = stored.enabled;
        intervalSeconds = stored.intervalSeconds;
      }
      applyTimer();
      return state();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}
