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

// Persists "Start at login" / "Start in tray" so the main process can read them
// before the renderer exists -- unlike closeToTray, these decide whether the
// window is shown at all during the very first tick of startup.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

export const LAUNCH_PREFERENCES_FILENAME = 'launch-preferences.json';

function readStoredLaunchPreferences(filePath) {
  try {
    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      startAtLogin: Boolean(stored?.startAtLogin),
      startInTray: Boolean(stored?.startInTray)
    };
  } catch {
    return { startAtLogin: false, startInTray: false };
  }
}

function writeStoredLaunchPreferences(filePath, preferences) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function createLaunchPreferencesController({ app, filePath }) {
  let preferences = readStoredLaunchPreferences(filePath);

  function applyLoginItemSettings() {
    // No-op on platforms without a login-item store (e.g. most Linux desktops);
    // Electron handles that silently.
    app.setLoginItemSettings({ openAtLogin: preferences.startAtLogin });
  }

  applyLoginItemSettings();

  return {
    get: () => ({ ...preferences }),
    set(next = {}) {
      const merged = {
        startAtLogin: typeof next.startAtLogin === 'boolean' ? next.startAtLogin : preferences.startAtLogin,
        startInTray: typeof next.startInTray === 'boolean' ? next.startInTray : preferences.startInTray
      };
      if (merged.startAtLogin === preferences.startAtLogin && merged.startInTray === preferences.startInTray) {
        return { ...preferences };
      }

      writeStoredLaunchPreferences(filePath, merged);
      const loginChanged = merged.startAtLogin !== preferences.startAtLogin;
      preferences = merged;
      if (loginChanged) applyLoginItemSettings();
      return { ...preferences };
    }
  };
}
