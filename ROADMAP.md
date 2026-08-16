# Midia Applet Roadmap

New applets planned from easiest to hardest. Mockups pending from user for the
YouTube applet and the messaging applet.

## Shared infrastructure (build first)

- **Background / wallpaper engine** — reused by the YouTube and Mirra applets:
  - Two-color gradient background (user-pickable colors)
  - MP4 video background option
  - Fullscreen mode with no wallpaper (UI only)
  - Toggleable per-applet (default on, can be turned off)
- **Onboarding slideshow system** — reusable first-run walkthrough for applets
  (Mirra ships one; DVD applet already has one).

## Applet 1 — YouTube (Android TV client) — EASIEST

- YouTube client built into Midia as an applet (Android TV style UI).
- **Approach (resolved):** mirror [marticliment/Youtube-TV-Client](https://github.com/marticliment/Youtube-TV-Client)
  (MIT) — it is simply a WebView frame that loads `youtube.com/tv` with a
  Smart-TV user-agent. In Electron: a `<webview>` / `WebContentsView` with
  `session.setUserAgent()` spoofing a Smart TV. No yt-dlp, no scraping.
- Gets the background/wallpaper engine.
- "A few touches" from the standard YouTube TV experience.
- UI mockup: pending from user.

## Applet 2 — Mirra (Android screen mirroring) — MEDIUM

- Powered by **scrcpy**; wired USB connection to an Android device.
- Onboarding slideshow of capabilities:
  - Change the phone's screen orientation
  - Turn the phone's display off
  - Sound only coming out of the phone
  - etc.
- UI: the phone screen shown slightly zoomed out, over the dot-grid gradient
  background.
- Background options (shared engine):
  1. Two-color gradient
  2. MP4 video background
  3. No wallpaper — phone at fullscreen with UI overlay
- Open questions:
  - Bundling scrcpy binaries (server jar + adb) with the installer
  - Electron/Node bindings for streaming frames into the applet

## Applet 3 — Messaging (Discord-linked, friends only) — HARDEST

- Needs a unique name (like "Mirra") — TBD.
- Linked to Discord; shows **only your friends**.
- Profile picture at the top of the screen; clicking it opens **pinned friends**.
- Friends who are currently playing a game in the **xora / IISU**
  home-game-launcher automatically pin below the user's pinned-friends
  section.
- UI mockup: pending from user.
- **Discord access (resolved):** personal project, not public, so user-token /
  self-bot approach is acceptable. The IISU launcher already implements
  Discord friends messaging — reuse its approach/learnings.
- Open questions:
  - How Midia learns which friends are playing a game (xora/IISU
    integration point)
