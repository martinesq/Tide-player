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

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerMemoryTrim } from '../electron/platform/memoryTrim.js';
import { IPC_CHANNELS } from '../shared/ipcChannels.js';

function harness(userDataPath, { available = true, pids = [111, 222], addon } = {}) {
  const handlers = new Map();
  const trimmed = [];
  const fakeAddon = addon ?? {
    trimWorkingSet: (pid) => {
      trimmed.push(pid);
      return true;
    }
  };
  return {
    trimmed,
    invoke: (channel, ...args) => handlers.get(channel)(null, ...args),
    deps: {
      app: {
        getPath: () => userDataPath,
        getAppMetrics: () => pids.map((pid) => ({ pid, type: 'utility' }))
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      modulePath: '/fake/orchard_memory_trim.node',
      available,
      loadNativeAddon: () => fakeAddon
    }
  };
}

test('unavailable platforms report false and the toggle is a no-op', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, invoke, trimmed } = harness(userData, { available: false });
  const memoryTrim = registerMemoryTrim(deps);

  assert.deepEqual(await memoryTrim.restore(), { available: false, enabled: false, intervalSeconds: 15 });
  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true), {
    available: false,
    enabled: false,
    intervalSeconds: 15
  });
  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 30), {
    available: false,
    enabled: false,
    intervalSeconds: 15
  });
  assert.deepEqual(trimmed, []);
  memoryTrim.stop();
});

test('a fresh install starts disabled, defaults to a 15-second interval, and trims nothing until enabled', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, trimmed } = harness(userData);
  const memoryTrim = registerMemoryTrim(deps);

  assert.deepEqual(await memoryTrim.restore(), { available: true, enabled: false, intervalSeconds: 15 });
  assert.deepEqual(trimmed, []);
  memoryTrim.stop();
});

test('enabling trims every one of this app\'s own processes immediately, and persists', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, invoke, trimmed } = harness(userData, { pids: [111, 222, 333] });
  const memoryTrim = registerMemoryTrim(deps);
  await memoryTrim.restore();

  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true), {
    available: true,
    enabled: true,
    intervalSeconds: 15
  });
  assert.deepEqual(trimmed, [111, 222, 333]);

  const stored = JSON.parse(await readFile(path.join(userData, 'memory-trim-preferences.json'), 'utf8'));
  assert.deepEqual(stored, { enabled: true, intervalSeconds: 15 });
  memoryTrim.stop();
});

test('the next launch restores a stored "enabled" and starts trimming again', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const first = harness(userData);
  const firstTrim = registerMemoryTrim(first.deps);
  await firstTrim.restore();
  await first.invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true);
  firstTrim.stop();

  const second = harness(userData);
  const secondTrim = registerMemoryTrim(second.deps);
  assert.deepEqual(await secondTrim.restore(), { available: true, enabled: true, intervalSeconds: 15 });
  assert.deepEqual(second.trimmed, [111, 222]);
  secondTrim.stop();
});

test('repeats on the configured interval until disabled', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, invoke, trimmed } = harness(userData, { pids: [111] });
  const memoryTrim = registerMemoryTrim({ ...deps, intervalMs: 15 });
  await memoryTrim.restore();
  await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true);
  assert.deepEqual(trimmed, [111], 'enabling trims once immediately');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(trimmed.length >= 2, 'the interval must have fired at least once more');

  await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, false);
  const countAfterDisable = trimmed.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(trimmed.length, countAfterDisable, 'disabling must stop the interval');
  memoryTrim.stop();
});

test('the interval is user-settable, clamped to 1-600 seconds, and persists', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, invoke } = harness(userData);
  const memoryTrim = registerMemoryTrim(deps);
  await memoryTrim.restore();

  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 30), {
    available: true,
    enabled: false,
    intervalSeconds: 30
  });
  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 0), {
    available: true,
    enabled: false,
    intervalSeconds: 1
  }, 'below the floor clamps to 1 second');
  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 9999), {
    available: true,
    enabled: false,
    intervalSeconds: 600
  }, 'above the ceiling clamps to 600 seconds');
  assert.deepEqual(await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 12.4), {
    available: true,
    enabled: false,
    intervalSeconds: 12
  }, 'a fractional value rounds to the nearest whole second');

  const stored = JSON.parse(await readFile(path.join(userData, 'memory-trim-preferences.json'), 'utf8'));
  assert.deepEqual(stored, { enabled: false, intervalSeconds: 12 });
  memoryTrim.stop();
});

test('the next launch restores a stored interval', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const first = harness(userData);
  const firstTrim = registerMemoryTrim(first.deps);
  await firstTrim.restore();
  await first.invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 45);
  firstTrim.stop();

  const second = harness(userData);
  const secondTrim = registerMemoryTrim(second.deps);
  assert.deepEqual(await secondTrim.restore(), { available: true, enabled: false, intervalSeconds: 45 });
  secondTrim.stop();
});

test('changing the interval while enabled restarts the timer on the new cadence', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps, invoke, trimmed } = harness(userData, { pids: [111] });
  const memoryTrim = registerMemoryTrim(deps);
  await memoryTrim.restore();
  await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true);
  assert.deepEqual(trimmed, [111], 'enabling trims once immediately');

  // Seconds-based by default (no intervalMs override here), so switching the
  // interval only needs to prove it ran again right away, not wait out a
  // real interval for the timer itself.
  await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_INTERVAL_SECONDS, 30);
  assert.deepEqual(trimmed, [111, 111], 'changing the interval while enabled trims again immediately');
  memoryTrim.stop();
});

test('one process refusing to trim does not skip the rest', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const trimmed = [];
  const addon = {
    trimWorkingSet: (pid) => {
      if (pid === 222) throw new Error('access denied');
      trimmed.push(pid);
      return true;
    }
  };
  const { deps, invoke } = harness(userData, { pids: [111, 222, 333], addon });
  const memoryTrim = registerMemoryTrim(deps);
  await memoryTrim.restore();

  await invoke(IPC_CHANNELS.MEMORY_TRIM.SET_ENABLED, true);
  assert.deepEqual(trimmed, [111, 333]);
  memoryTrim.stop();
});

test('a native addon that fails to load degrades to a silent no-op', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'orchard-memtrim-'));
  const { deps } = harness(userData, {
    addon: null
  });
  deps.loadNativeAddon = () => {
    throw new Error('module not found');
  };
  const memoryTrim = registerMemoryTrim(deps);
  await memoryTrim.restore();

  // Must not throw, and must report the feature as off even though nothing
  // can actually run -- the caller asked for a state that persists the same
  // way regardless of whether this machine's build has the addon.
  const state = await memoryTrim.restore();
  assert.deepEqual(state, { available: true, enabled: false, intervalSeconds: 15 });
  memoryTrim.stop();
});
