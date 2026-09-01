/**
 * The workspace is designed against a 1920px-wide canvas -- that is the layout
 * every screenshot and every breakpoint decision is made on. Every desktop
 * renders that same canvas, scaled to fit: a 1366 laptop draws it at 71%, a
 * 2560 monitor at 133%. Nothing reflows in between, so the view is the one on
 * the design, not a narrower rearrangement of it.
 *
 * Fluid resizing was tried first and is not the same view: at 1600 the KPI
 * captions wrapped onto a third line and the cards tightened, because the type
 * and the 252px sidebar keep their size while the columns lose theirs.
 *
 * Two limits bound it. Below `DESKTOP_FLOOR_WIDTH` the scale would push the
 * smallest type under about 6px, so it stops shrinking and the page scrolls
 * instead. Above `MAX_ZOOM` it stops growing, so an ultrawide or 4K panel gets
 * the canvas centred rather than turned into signage.
 *
 * Phones and tablets are left alone entirely -- they get the small-screen
 * stack, which is a different design, not a scaled one.
 *
 * The canvas can be switched off per browser from the profile menu. Off, the
 * page behaves like any other site: the browser's own zoom applies and the
 * layout reflows to the window. It is on by default because the fixed canvas
 * is the design; the switch exists for anyone who would rather have larger
 * type on a small laptop than the exact 1920 arrangement.
 */
export const DESIGN_WIDTH = 1920;
export const MAX_ZOOM = 1.5;

/** Below this the small-screen stack takes over and no scaling is applied. */
export const DESKTOP_MIN_WIDTH = 1024;

/** Design content width: 1920 minus the fixed sidebar and the main padding. */
export const DESIGN_CONTENT_WIDTH = 1604;

/**
 * The narrowest viewport that still gets the full canvas. Set below the 1280
 * screen it protects, because a scrollbar takes ~15px off the usable width:
 * with the floor at 1280 exactly, a 1280 screen fell short of the canvas by
 * those pixels and a KPI caption wrapped that does not wrap at 1920.
 */
export const DESKTOP_FLOOR_WIDTH = 1200;

/** The most the canvas may shrink before legibility gives way. */
export const MIN_ZOOM = DESKTOP_FLOOR_WIDTH / DESIGN_WIDTH;

/** Per-browser preference. Absent means on, so the default needs no write. */
export const CANVAS_STORAGE_KEY = 'gdm:fixed-canvas';
export const CANVAS_DISABLED_VALUE = 'off';

export function canvasEnabled() {
  try {
    return window.localStorage.getItem(CANVAS_STORAGE_KEY) !== CANVAS_DISABLED_VALUE;
  } catch {
    // Private modes and blocked site data throw on access rather than
    // returning null, and a thrown read must not cost anyone the layout.
    return true;
  }
}

export function storeCanvasEnabled(enabled: boolean) {
  try {
    if (enabled) window.localStorage.removeItem(CANVAS_STORAGE_KEY);
    else window.localStorage.setItem(CANVAS_STORAGE_KEY, CANVAS_DISABLED_VALUE);
  } catch {
    // The zoom is still applied for this page; only the memory of it is lost.
  }
}

export function viewportZoom(width: number) {
  if (!Number.isFinite(width) || width < DESKTOP_MIN_WIDTH) return 1;
  return Math.min(Math.max(width / DESIGN_WIDTH, MIN_ZOOM), MAX_ZOOM);
}

/**
 * Measuring has to un-zoom first: once a zoom is applied, the root element
 * reports the *zoomed* width, and reading that back would feed itself.
 */
/**
 * The custom property is not decoration: floating elements need the zoom as a
 * number they can divide by. See the popper rules in globals.css.
 */
export const CANVAS_ZOOM_PROPERTY = '--canvas-zoom';

export function applyViewportZoom(root: HTMLElement, enabled = true) {
  root.style.zoom = '1';
  const zoom = enabled ? viewportZoom(root.clientWidth) : 1;
  root.style.zoom = zoom === 1 ? '' : String(zoom);
  root.style.setProperty(CANVAS_ZOOM_PROPERTY, String(zoom));
  return zoom;
}

/**
 * Run before first paint so a wide screen does not show one unscaled frame.
 * Kept as a string because it has to be inlined into the document head.
 */
export const VIEWPORT_ZOOM_SCRIPT = `(function(){try{var r=document.documentElement;var off=false;try{off=window.localStorage.getItem('${CANVAS_STORAGE_KEY}')==='${CANVAS_DISABLED_VALUE}';}catch(e){}r.style.zoom='1';var w=r.clientWidth;var z=off||w<${DESKTOP_MIN_WIDTH}?1:Math.min(Math.max(w/${DESIGN_WIDTH},${MIN_ZOOM}),${MAX_ZOOM});r.style.zoom=z!==1?String(z):'';r.style.setProperty('--canvas-zoom',String(z));}catch(e){}})();`;
