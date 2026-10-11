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
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const native = require('../native/build/Release/orchard_memory_trim.node');

test('trimWorkingSet rejects a non-numeric process ID', () => {
  assert.throws(() => native.trimWorkingSet('not-a-pid'), /process ID/);
  assert.throws(() => native.trimWorkingSet(), /process ID/);
});

test('trimWorkingSet reports false for a process ID that cannot exist', () => {
  // Windows PIDs are multiples of 4 and bounded well under this; every
  // platform this addon runs on real logic for (win32) must refuse it.
  assert.equal(native.trimWorkingSet(0x7fffffff), false);
});

test('trimWorkingSet can trim this very process\'s own working set', () => {
  // A no-op everywhere but win32 -- the assertion only pins "never throws,
  // always a boolean," which holds on every platform.
  const result = native.trimWorkingSet(process.pid);
  assert.equal(typeof result, 'boolean');
  if (process.platform === 'win32') {
    assert.equal(result, true, 'trimming our own, freshly-started process should succeed on Windows');
  } else {
    assert.equal(result, false);
  }
});
