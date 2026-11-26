# REDBEAM "page drawn larger than its window": diagnosis, AARON-SLS, 2026-11-26 ~19:40Z

**Read of the cause: (c), the capture tool, not REDBEAM.** The window, its WebView2 children and the page are all consistent at 150%. The cropped captures came from my test tool's PrintWindow running DPI-unaware: it sizes its bitmap from the virtualized (logical) window rect, 1455×909, while the window paints at its physical size, 2182×1363. So only the top-left two-thirds land in the image. There is no leftover WebView2 page zoom (a) and no DPI mismatch between the Tauri window and the WebView2 child (b).

**Build:** installed REDBEAM 0.3.100 (c4a8c61), launched by me on C:\temp\rb-100\OwnViews.pdf with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`. The env var reached WebView2: `--remote-debugging-port=9333` is on msedgewebview2's command line.

## 1. Displays
- One monitor: `\\.\DISPLAY1`, 2400×1600 physical, effective DPI 144 (150%), raw DPI 201, primary.
- Console session, not RDP: SM_REMOTESESSION=0. The machine is reached through Chrome Remote Desktop on the console.

## 2. Window tree (per-monitor-v2 aware reader, physical px)
| HWND class | Window rect | Client | DPI | Awareness |
|---|---|---|---|---|
| Tauri Window (top level) | 120,89 – 2302,1452 (2182×1363) | 2160×1350 | 144 | 2 (per-monitor) |
| TAURI_DRAG_RESIZE_BORDERS | 2160×1350 | 2160×1350 | 144 | 2 |
| WRY_WEBVIEW | 2160×1350 | 2160×1350 | 144 | 2 |
| Chrome_WidgetWin_0 | 2160×1350 | 2160×1350 | 144 | 2 |
| Chrome_WidgetWin_1 | 2160×1350 | 2160×1350 | 144 | 2 |
| Chrome_RenderWidgetHostHWND | 2160×1350 | 2160×1350 | 144 | 2 |
| Intermediate D3D Window | 2160×1350 | 2160×1350 | 144 | 2 |

No child is bigger than the parent's client area, and none has a different DPI.

## 3. Page metrics (DevTools Runtime.evaluate / Page.getLayoutMetrics)
- devicePixelRatio 1.5; innerWidth 1440, innerHeight 900 (= 2160×1350 / 1.5); outerWidth 1441, outerHeight 901.
- visualViewport.scale 1, width 1440; documentElement.clientWidth 1440, scrollWidth 1440.
- computed zoom on html and body: 1.
- Layout viewport 2160×1350 device px; CSS layout viewport 1440×900; content size 1440×900.
- screen 1600×1067 (CSS px).

## 4. Ctrl+0
Not delivered. Windows' foreground lock left ShellExperienceHost in front, so the keystroke did not reach REDBEAM. The metrics were the same afterwards, and there was no zoom to reset. In REDBEAM, Ctrl+0 is also the app's own "Fit sheet" shortcut, not a WebView zoom reset.

## 5. Fresh start
This measurement *was* a fresh start: no REDBEAM was running, then I launched it once, and it was already consistent. There is only one monitor, so I could not move the window to another.

## 6. WebView2 user data
`%LOCALAPPDATA%\com.redbeam.app\EBWebView\Default\Preferences` (written 13:34:43) has no `per_host_zoom_levels` and no `zoom` key.

## Captures
- A-printwindow-dpi-unaware.png: 1455×909, cropped. This is how earlier captures were made.
- B-printwindow-dpi-aware.png: 2182×1363, the whole window, sidebar included.
- C-screen-grab-dpi-aware.png: the real screen pixels of the window rect.
- D/E: screen grabs before and after the attempted Ctrl+0.

Earlier "oversize" findings (the 40c19fb S9 attempt and the 0.3.100 own-views captures) should be read as capture cropping. However, my real clicks in those runs used DPI-unaware coordinates too, which is why they missed.
