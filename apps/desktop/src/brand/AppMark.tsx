import full from './mark.png'
import small from './mark-small.png'

/**
 * The app icon, wherever the UI shows the app itself: the title bar, the start
 * screen, the command palette, Settings › About, the favicon. One component so
 * no screen draws its own stand-in (the red "RB" squares this replaced).
 *
 * Sizes are the WinUI icon roles: 16 (row), 20 (title bar), 40 (start screen
 * header). At 24 px and down the small cut is used: a bigger crystal and
 * thicker beams, drawn to read at taskbar sizes. Source: icon-src/.
 */
export function AppMark({ size, className }: { size: 16 | 20 | 24 | 40 | 48; className?: string }) {
  return (
    <img
      className={className === undefined ? 'appmark' : `appmark ${className}`}
      src={size <= 24 ? small : full}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
