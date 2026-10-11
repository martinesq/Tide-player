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

// Generic parent-side handle on a one-request-at-a-time utility process.
//
// The ONNX models and the YouTube PO token minter all need the exact same
// lifecycle: fork lazily on first use, re-fork after any exit, bound the wait
// on a wedged request and kill the child if it's exceeded, resolve every
// failure path (fork failure, crash, timeout, send failure) to null rather
// than throwing, and retire an idle child so its memory isn't held for the
// rest of the session. A broken request and a silent one are the same thing
// to the caller -- a routing decision back to whatever fallback that feature
// has -- so this is extracted once rather than kept as several copies of the
// same ~150 lines that would need to stay in sync. `beatModelHost.js`,
// `vocalMaskHost.js` and `poTokenHost.js` are thin wrappers over this that
// only supply their own entry point, service name, and payload validation.
//
// The wire protocol is one message per request: {id, payload, modelPath} in,
// {id, result} out. `payload` is deliberately generic -- it is whatever the
// target process's entry point expects (a spectrogram, a video ID), and
// `modelPath` is ignored by entry points that don't need one.

// Bounds the wait, not the work: a wedged inference cannot be interrupted, so
// on expiry the child is killed and the request resolves null. Generous
// because the first request also pays session construction over the model.
const DEFAULT_TIMEOUT_MS = 30_000;
// A loaded ONNX session is real resident memory (the runtime plus the model's
// weights and arena buffers) that does nothing for every second nothing is
// analysing or rendering a transition. Retiring the child after a quiet spell
// trades that for a re-fork -- paid again next time, exactly like the
// first-ever request -- the next time there's real work.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000;

export function createModelProcessHost({
  entryPath,
  serviceName,
  modelPath = '',
  log = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  // Injectable so tests can stand in a fake child; the default forks the real
  // utility process. Imported lazily because this module is also loaded by
  // plain-node tests, where 'electron' does not resolve.
  fork = async () => {
    const { utilityProcess } = await import('electron');
    return utilityProcess.fork(entryPath, [], { serviceName });
  }
} = {}) {
  let child = null;
  let spawning = null;
  let nextId = 0;
  const inFlight = new Map();
  let idleTimer = null;

  function clearIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // Arms a retirement timer for the child that is current right now. The
  // closure pins that exact child, so if it has already been replaced (a
  // crash and re-fork, or an earlier retirement) by the time this fires, it
  // is a no-op rather than killing whatever happens to be running later.
  function armIdleTimer() {
    clearIdleTimer();
    const target = child;
    if (!target || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight.size > 0 || child !== target) return;
      child = null;
      log(`${serviceName}-process-idle-retired`, { idleTimeoutMs });
      try {
        target.kill();
      } catch {}
    }, idleTimeoutMs);
  }

  function settle(id, result) {
    const pending = inFlight.get(id);
    if (!pending) return;
    inFlight.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result ?? null);
    if (inFlight.size === 0) armIdleTimer();
  }

  function settleAll(result) {
    for (const id of [...inFlight.keys()]) settle(id, result);
  }

  async function spawn() {
    if (child) return child;
    // One fork at a time: concurrent first requests share the same child.
    if (!spawning) {
      spawning = (async () => {
        const spawned = await fork();
        spawned.on('message', (message) => settle(Number(message?.id), message?.result));
        spawned.on('exit', (code) => {
          // Every in-flight request dies with the process. Resolving null
          // routes each one to the caller's fallback; the next request forks
          // a fresh child.
          if (child === spawned) {
            child = null;
            clearIdleTimer();
          }
          settleAll(null);
          log(`${serviceName}-process-exit`, { code: Number(code) || 0 });
        });
        child = spawned;
        log(`${serviceName}-process-forked`, {});
        return spawned;
      })().finally(() => {
        spawning = null;
      });
    }
    return spawning;
  }

  /**
   * Runs one payload through the utility process. Resolves to the process's
   * verdict, or null whenever the child cannot answer. Callers validate their
   * own payload shape before calling this -- an empty one still pays for a
   * fork here.
   */
  async function run(payload) {
    // Cancel any pending retirement before (re)using the child: a request
    // arriving the instant idleTimeoutMs elapses must win the race, not have
    // its child pulled out from under it.
    clearIdleTimer();
    let target;
    try {
      target = await spawn();
    } catch (error) {
      log(`${serviceName}-process-fork-failed`, {
        errorMessage: String(error?.message || error || 'fork failed').slice(0, 500)
      });
      return null;
    }
    // The fork is awaited, so the child can already have died in the gap --
    // its exit handler ran before this request was ever registered, and
    // settleAll could not see it. Without this check the request would sit in
    // `inFlight` addressed to a dead process until the timeout expired.
    if (target !== child) {
      log(`${serviceName}-process-died-before-send`, {});
      return null;
    }
    const id = ++nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A request this late means the child is wedged (an ONNX run or a
        // BotGuard challenge cannot be cancelled once entered), so killing
        // the process is the only way to reclaim it. The exit handler
        // settles everything else.
        log(`${serviceName}-process-timeout`, { timeoutMs });
        inFlight.delete(id);
        resolve(null);
        try {
          target.kill();
        } catch {}
      }, timeoutMs);
      inFlight.set(id, { resolve, timer });
      try {
        target.postMessage({ id, payload, modelPath });
      } catch (error) {
        clearTimeout(timer);
        inFlight.delete(id);
        log(`${serviceName}-process-send-failed`, {
          errorMessage: String(error?.message || error || 'send failed').slice(0, 500)
        });
        resolve(null);
      }
    });
  }

  function stop() {
    // `child` must be null before settling: settle() re-arms the idle timer
    // once in-flight drains to zero, and armIdleTimer() only skips doing that
    // when it finds no current child. Clearing the timer first and nulling
    // the child after left a 2-minute timer armed against a process this
    // call was about to kill anyway.
    const stopping = child;
    child = null;
    clearIdleTimer();
    settleAll(null);
    try {
      stopping?.kill();
    } catch {}
  }

  return { run, stop };
}
