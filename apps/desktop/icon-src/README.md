# App icon source

The icon is rendered in Blender (Cycles), then composited into a rounded tile.

1. `blender -b --python prism.py -- out.png <samples> <res> <OPTIX|CUDA|CPU> Standard [small] [nofloor]`
   - full icon: `prism_2048.png 512 2048 OPTIX Standard`
   - 32 to 44 px cut: `small.png 96 512 CPU Standard small`
   - 16 to 24 px cut: `tiny.png 96 512 CPU Standard small nofloor`
2. `python comp.py render.png art.png` adds the background gradient, bloom and dither.
3. `node tile.js art.png icon.png` (full) or `node tile-small.js art.png icon.png` (small cuts, tighter margin) puts it in the tile (needs Playwright).
4. `npx @tauri-apps/cli icon icon.png -o src-tauri/icons`, then rebuild `icon.ico`, `32x32.png`, `Square30x30Logo.png` and `Square44x44Logo.png` from the small cuts (16 to 24 px from `nofloor`, 30 to 44 px from `small`).
