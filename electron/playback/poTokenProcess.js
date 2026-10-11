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

// Entry point of the PO-token utility process.
//
// Minting a token means standing up a JSDOM document (BotGuard's VM needs
// browser globals) and running YouTube's downloaded interpreter inside it --
// a full DOM implementation that costs on the order of 100 MB of resident
// memory once constructed, held for as long as this process lives. Isolating
// it here means that cost sits in a process poTokenHost.js can kill the
// instant the quiet-period timer decides nothing needs a token for a while,
// instead of in the main process for the app's entire lifetime. It also keeps
// the BotGuard VM -- interpreter JavaScript downloaded from YouTube at
// runtime -- out of the process that hosts IPC for playback.
//
// One minter is kept for the life of this process: creating it pays a
// network round trip (the BotGuard challenge and GenerateIT) that is wasted
// if paid per request, and the minter already caches video-bound tokens
// itself. The protocol is one message per request: {id, payload, modelPath}
// in (modelPath is unused here; it's part of the shared wire shape), {id,
// result} out, where result is {token} or {error}.
import { createYouTubePoTokenService } from './youtubePoToken.js';

const service = createYouTubePoTokenService();

process.parentPort.on('message', (event) => {
  const { id, payload } = event?.data || {};
  if (!Number.isFinite(Number(id))) return;
  void (async () => {
    let result;
    try {
      const token = await service.get(payload?.videoId, { rejectedToken: payload?.rejectedToken || '' });
      result = { token };
    } catch (error) {
      result = { error: String(error?.message || error || 'PO token minting failed').slice(0, 500) };
    }
    try {
      process.parentPort.postMessage({ id, result });
    } catch {
      // The parent is gone; exit quietly rather than linger orphaned.
      process.exit(0);
    }
  })();
});
