## Tide 4.7.8

### Performance
- The beat-tracking and vocal-separation ONNX models now run in a utility process that retires itself after 2 minutes of inactivity, instead of staying loaded for the whole session.
- YouTube's PO-token minter (which needs a full JSDOM instance, ~100 MB) moved out of the main process into its own utility process, retired after 10 minutes of inactivity.
- The audio-output device menu no longer starts Chromium's video-capture service (~100 MB) on every launch; it now loads only when that menu is actually opened.
- The animated background's WebGL context is now explicitly released when turned off or navigated away from, instead of waiting on the browser to notice.
- New, off-by-default "Trim memory usage" option in Settings → Performance: periodically asks Windows to release each of Tide's own processes' idle memory, on an interval you set (1–600 seconds). This does not reduce how much memory Tide actually needs; it only affects what Task Manager reports while nothing is using that memory. Scoped entirely to Tide's own processes.

### Fixed
- The now-playing title marquee (and other ambient animations in the player bar) would silently stop as soon as the window lost focus, because Chromium throttles animations for unfocused windows by default. Since Tide is commonly used in the background while playing music, this is now disabled for the main window.
- Removed the "Support" entry from the sidebar, above Settings.

Tide is an independent fork of [Orchard](https://github.com/sfg5453/orchard) by SFG545.
