# Fonts (multi-script rendering)

> Moved verbatim from CLAUDE.md (origin/main 3c5eca0) §"Fonts" on 2026-11-25 (CLAUDE.md trim).

Headless Chrome renders with the **container's** fonts — the host OS/locale is
irrelevant. The image bakes in `fonts-noto-core` (Hebrew, Arabic, Cyrillic, …),
`fonts-noto-cjk` (Chinese/Japanese/Korean), `fonts-noto-color-emoji`, and
`fontconfig`, so non-Latin text renders out of the box instead of tofu (□□□).

- **Custom fonts without rebuilding:** mount `.ttf`/`.otf`/`.woff2` files into
  `/home/mcp/.fonts` (commented example in `docker-compose.yml`). The daemon
  **font-watch** (piggybacked on the reaper) detects changes in that dir and
  auto-restarts itself once the dir is stable across two ticks (~2 min worst
  case) — Docker's `restart: unless-stopped` revives the container and the
  entrypoint's `fc-cache -f` loads the fonts before Chrome launches. Note: the
  auto-restart kills active sessions' browser state (captured history survives
  in SQLite). `docker restart` forces it immediately;
  `LEAN_CHRONOSCOPE_FONT_WATCH=0` (or a disabled reaper) turns font-watch off.
  Chrome builds its font list at startup; fonts added while it's running are
  never picked up without that relaunch.
- **`fonts_list` tool** (read-only, wraps `fc-list`): lists installed families;
  `{lang: "he"}` filters to families covering a language — an empty result means
  that script will render as tofu. Lets the model check coverage before
  screenshotting and tell the operator what to mount.
- Web fonts (`@font-face`) served by a site render regardless of container
  fonts, but only cover what the site ships — they're not a substitute.
