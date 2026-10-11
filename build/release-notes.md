## Tide 4.7.11

### Fixed
- The actual cause of the RAM spikes from 4.7.10: Automatic EQ's tempo analysis decoded the full track on every single track change, with no way to cancel it, regardless of crossfade mode. Switching tracks quickly piled up multiple uncancelled full-track decodes at once. It now cancels the previous track's analysis the instant a new one starts.

## Tide 4.7.10

### Fixed
- Switching tracks quickly (clicking through several in a row) could spike RAM usage up to several GB. Smart Crossfade analysis used to start a full-track decode the instant a track began playing; it now waits 1.5s and skips the decode entirely if you've already moved to another track by then. (Turned out not to be the main cause — see 4.7.11.)

## Tide 4.7.9

### Fixed
- Restored the search bar, navigation arrows, and appearance/color customization that were missing from 4.7.8 -- that build was recompiled from the current source tree, which still lags behind what 4.7.7 actually shipped in a few places. This release is built on 4.7.7's own frontend again, with only the additions below layered on top; nothing from 4.7.7 was removed.
- Some YouTube Music tracks resolve to a music video rather than a plain audio stream, and used to open full-screen the instant they started playing, with no setting to stop it. Playback now always starts with just the bottom bar; use the expand button if you want the video full-screen.

### Performance
- The beat-tracking and vocal-separation ONNX models now run in a utility process that retires itself after 2 minutes of inactivity, instead of staying loaded for the whole session.
- YouTube's PO-token minter (which needs a full JSDOM instance, ~100 MB) moved out of the main process into its own utility process, retired after 10 minutes of inactivity.
- The audio-output device menu no longer starts Chromium's video-capture service (~100 MB) on every launch; it now loads only when that menu is actually opened.
- The animated background's WebGL context is now explicitly released when turned off or navigated away from, instead of waiting on the browser to notice.
- New, off-by-default "Trim memory usage" option in Settings → Performance: periodically asks Windows to release each of Tide's own processes' idle memory, on an interval you set (1–600 seconds). This does not reduce how much memory Tide actually needs; it only affects what Task Manager reports while nothing is using that memory. Scoped entirely to Tide's own processes.
- The now-playing title marquee (and other ambient animations in the player bar) would silently stop as soon as the window lost focus, because Chromium throttles animations for unfocused windows by default. Since Tide is commonly used in the background while playing music, this is now disabled for the main window.

### Changed
- Removed the "Support" entry from the sidebar, above Settings.

Tide is an independent fork of [Orchard](https://github.com/sfg5453/orchard) by SFG545.
