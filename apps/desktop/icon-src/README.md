# App icon source

The icon is drawn, not rendered: a faceted white crystal on a graphite tile,
white light going in and a red beam fanning out. Soft gradients and gentle
depth, crisp edges, so it stays legible down to 16 px.

There are two cuts. `icon.svg` is the full one (64 px and up). `icon-small.svg`
has a bigger crystal and thicker beams for 48 px and down, which covers the
taskbar, the title bar and the 16 to 24 px spots inside the app.

To change it:

1. Edit `icon.cjs`, then `node icon-src/icon.cjs icon-src` (from `apps/desktop`;
   needs Playwright and its Chromium). This writes both SVGs and a 1024 px PNG of each.
2. `python icon-src/pack.py` (needs Pillow). This writes every PNG in
   `src-tauri/icons`, `icon.ico` (small cut up to 48 px), `icon.icns`, the NSIS
   installer header and sidebar, and the in-app marks in `src/brand`.

Inside the app the icon is drawn only through `src/brand/AppMark.tsx`, so no
screen keeps its own stand-in.
