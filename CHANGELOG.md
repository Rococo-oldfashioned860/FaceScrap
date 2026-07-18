# Changelog

All notable changes to FaceScrap are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0] - 2026-07-18

Initial public release.

### Added

- Capture of Facebook **reels, stories and highlights** from the media the tab
  is already playing: passive GraphQL read (MAIN-world hook), non-blocking
  `webRequest` observation of `*.fbcdn.net`, and a DOM-scan fallback.
- **Side panel UI** with three views — Now Playing, Library, Saved — plus
  quality picker, multi-select download tray, filename templates, EN|ES
  language toggle and per-tab retention cap.
- **HD (DASH) downloads with audio**: the video and audio tracks are fetched
  and remuxed with `ffmpeg.wasm` (`-c copy`, no re-encode) in an offscreen
  document. DRM streams are detected and excluded. Track downloads abort on
  stall (idle gap), not on total time, so large videos survive slow links.
- **Now Playing provenance**: story-card marks distinguish DOM-proven ids
  (durable) from the tray-pinned URL fallback (provisional), so a provisional
  signal can never pin the wrong video; per-load video marks are epoch-scoped
  so a page reload cannot recycle them.
- **Unit suite** (`npm test`): esbuild-bundled `node --test` covering the
  now-playing binding/rescue logic, mark minting and bounding, against a
  faithful `chrome.storage` fake.
- Graceful degradation across Chromium browsers: popup fallback without
  `sidePanel`, video-only downloads without `offscreen` (feature-detected
  across both required APIs), and a readable startup message when an API the
  panel needs is missing entirely.
- Environment fit: `color-scheme` so native scrollbars and selects match the
  dark UI on light-themed systems, `prefers-reduced-motion` support, a
  one-column card grid on narrow panels, and download failures surfaced with
  their real reason. The extension version is shown in Settings.
