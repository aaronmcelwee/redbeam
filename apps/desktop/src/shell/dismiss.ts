import { useEffect, useRef } from 'react'

/**
 * Close on Escape or a click outside. Both, because either alone is a trap:
 * Escape alone strands a menu when the pointer has already moved on, and
 * outside-click alone strands it for anyone driving from the keyboard.
 *
 * The listeners go on once per opening and read `close` through a ref. They
 * used to re-register whenever `close` changed, which is every render, and
 * Escape re-renders the workspace in the middle of the key press: the old
 * listener came off before its turn and the new one went on too late, so
 * Escape never closed the app menu, the dock menus or the Takeoff menus.
 * Three copies of this hook had the same flaw; this is the one copy.
 */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [open])
  return ref
}
