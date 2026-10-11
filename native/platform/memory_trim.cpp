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

// N-API boundary for trimming one OS process's own working set.
//
// This is deliberately the only operation exposed here. EmptyWorkingSet asks
// Windows to evict the *calling-supplied process's* resident pages onto that
// page's own standby list -- it takes a process handle and only ever touches
// the process behind that handle. There is no system-wide equivalent in this
// file: the global standby list (and its "low priority" partition), which an
// external RAM-cleaning utility also purges, is a structure every process on
// the machine shares, and emptying it needs a privilege unrelated to owning
// a process handle. electron/platform/memoryTrim.js, the only caller, only
// ever passes PIDs from this app's own `app.getAppMetrics()`.
//
// On every other platform this resolves to false; the JS side already treats
// the feature as unavailable there.

#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
#endif

namespace {

Napi::Value TrimWorkingSet(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "trimWorkingSet expects a process ID").ThrowAsJavaScriptException();
    return env.Undefined();
  }

#ifdef _WIN32
  const auto pid = static_cast<DWORD>(info[0].As<Napi::Number>().Uint32Value());
  // EmptyWorkingSet calls into SetProcessWorkingSetSizeEx under the hood,
  // which is documented as needing PROCESS_SET_QUOTA alongside
  // PROCESS_QUERY_INFORMATION; PROCESS_VM_OPERATION is not sufficient and
  // leaves the call failing silently (returning false, never throwing).
  HANDLE process_handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, FALSE, pid);
  if (process_handle == nullptr) return Napi::Boolean::New(env, false);
  const BOOL trimmed = EmptyWorkingSet(process_handle);
  CloseHandle(process_handle);
  return Napi::Boolean::New(env, trimmed != 0);
#else
  (void)info;
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("trimWorkingSet", Napi::Function::New(env, TrimWorkingSet));
  return exports;
}

}  // namespace

NODE_API_MODULE(orchard_memory_trim, Initialize)
