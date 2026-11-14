export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Keep a window reachable: if its saved position is no longer (mostly) on any connected display —
 * a monitor was unplugged, or scaling/resolution changed — move it to the bottom-right of the primary.
 */
export function clampToDisplays(win: Rect, displays: Rect[], primary: Rect, margin = 24): { x: number; y: number } {
  const visibleOn = (d: Rect) => {
    const w = Math.min(win.x + win.width, d.x + d.width) - Math.max(win.x, d.x);
    const h = Math.min(win.y + win.height, d.y + d.height) - Math.max(win.y, d.y);
    return w >= win.width * 0.5 && h >= win.height * 0.5;
  };
  if (displays.some(visibleOn)) return { x: win.x, y: win.y };
  return { x: primary.x + primary.width - win.width - margin, y: primary.y + primary.height - win.height - margin };
}
