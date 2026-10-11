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

// Parent-side handle on the PO-token utility process. A thin wrapper over the
// shared lifecycle in modelProcessHost.js -- see that file and
// beatModelHost.js, its sibling wrapper for the beat model -- except for the
// idle timeout: reminting here costs a network round trip and a BotGuard
// challenge, several times what the ONNX models pay to warm back up, so this
// child is given a much longer quiet period before it's retired.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelProcessHost } from '../audio/modelProcessHost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolved out of the asar for the same reason as beatModelHost.js's
// ENTRY_PATH: utilityProcess.fork needs a real file on disk.
const ENTRY_PATH = path
  .join(here, 'poTokenProcess.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Minting can involve a full BotGuard challenge plus a GenerateIT round trip
// over the network, which the previous in-process implementation left
// unbounded. A generous bound here is a reliability improvement -- a wedged
// request used to hang forever -- not just a safety net for the kill path.
const DEFAULT_TIMEOUT_MS = 45_000;
// A token is valid for hours and the minter that produced it is reused for
// just as long, so the process holding it should outlast a normal gap
// between tracks. Ten minutes retires it across a pause in listening without
// paying a re-mint on every single track change.
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

export function createPoTokenHost({ log, timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, fork } = {}) {
  const host = createModelProcessHost({
    entryPath: ENTRY_PATH,
    serviceName: 'orchard-po-token',
    log,
    timeoutMs,
    idleTimeoutMs,
    fork
  });

  /**
   * Mints a PO token for one video ID in the utility process. Throws exactly
   * like the in-process minter did -- callers already treat a thrown error
   * as "no token" and fall back to legacy playback.
   */
  async function get(videoId, { rejectedToken = '' } = {}) {
    const contentBinding = String(videoId || '').trim();
    if (!contentBinding) throw new Error('A video ID is required to mint a YouTube PO token');
    const result = await host.run({ videoId: contentBinding, rejectedToken });
    if (!result?.token) throw new Error(result?.error || 'YouTube PO token minting failed');
    return result.token;
  }

  return { get, stop: host.stop };
}
