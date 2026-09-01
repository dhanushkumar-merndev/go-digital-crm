import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyViewportZoom,
  CANVAS_DISABLED_VALUE,
  CANVAS_ZOOM_CHANGED_EVENT,
  CANVAS_ZOOM_PROPERTY,
  CANVAS_STORAGE_KEY,
  DESIGN_CONTENT_WIDTH,
  DESIGN_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  VIEWPORT_ZOOM_SCRIPT,
  viewportZoom,
} from '../../src/lib/layout/viewport-scale';

const shell = readFileSync('src/components/shared/crm-shell.tsx', 'utf8');
const layout = readFileSync('src/app/layout.tsx', 'utf8');

/** Enough of an element for `applyViewportZoom`, plus a record of what it set. */
function fakeRoot(physicalWidth: number, reportsZoomedWidth = false) {
  const properties = new Map<string, string>();
  const element = {
    style: {
      zoom: '',
      setProperty: (name: string, value: string) => properties.set(name, value),
    },
    get clientWidth() {
      const zoom = Number(element.style.zoom || '1') || 1;
      return reportsZoomedWidth ? Math.round(physicalWidth / zoom) : physicalWidth;
    },
  };
  return { element: element as unknown as HTMLElement, properties };
}

describe('One desktop view across every screen size', () => {
  it('draws the same 1920 canvas on every laptop width', () => {
    for (const width of [1280, 1360, 1366, 1440, 1536, 1600, 1680, 1920]) {
      const zoom = viewportZoom(width);
      expect(zoom).toBeCloseTo(width / DESIGN_WIDTH, 5);
      // The whole point: the canvas the layout is built on is always 1920.
      expect(width / zoom).toBeCloseTo(DESIGN_WIDTH, 3);
    }
  });

  it('still fills the canvas on a 1280 screen once its scrollbar is taken off', () => {
    expect(1265 / viewportZoom(1265)).toBeCloseTo(DESIGN_WIDTH, 3);
  });

  it('stops shrinking below the floor rather than making the type unreadable', () => {
    for (const width of [1024, 1100, 1199]) {
      expect(viewportZoom(width)).toBe(MIN_ZOOM);
    }
  });

  it('leaves phones and tablets on their own stack', () => {
    for (const width of [360, 414, 768, 1023]) {
      expect(viewportZoom(width)).toBe(1);
    }
  });

  it('scales the same view up rather than reflowing it on a wider screen', () => {
    expect(viewportZoom(2048)).toBeCloseTo(2048 / DESIGN_WIDTH, 5);
    expect(viewportZoom(2240)).toBeCloseTo(2240 / DESIGN_WIDTH, 5);
    expect(viewportZoom(2560)).toBeCloseTo(2560 / DESIGN_WIDTH, 5);
  });

  it('stops growing at the cap so an ultrawide or 4K panel centres instead', () => {
    for (const width of [2880, 3440, 3840, 5120, 7680]) {
      expect(viewportZoom(width)).toBe(MAX_ZOOM);
    }
  });

  it('survives a viewport it cannot measure', () => {
    expect(viewportZoom(Number.NaN)).toBe(1);
    expect(viewportZoom(0)).toBe(1);
  });

  it('has no breakpoint-gated layout left that the canvas cannot reach', () => {
    // Media queries resolve against the physical width, not the canvas, so a
    // 1920-only arrangement gated at 2xl would never apply on a 1366 laptop.
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' });
    const gated = files
      .filter((file) => file.endsWith('.tsx'))
      .filter((file) => readFileSync(`src/${file}`, 'utf8').includes('2xl:'));
    expect(gated).toEqual([]);
  });

  it('measures un-zoomed, so a resize cannot feed its own zoom back in', () => {
    // A browser that reports the *zoomed* width would drift a little further
    // on every resize if the zoom were not cleared before measuring.
    const { element } = fakeRoot(1366, true);
    applyViewportZoom(element);
    const settled = element.style.zoom;
    applyViewportZoom(element);
    applyViewportZoom(element);
    expect(element.style.zoom).toBe(settled);
    expect(1366 / Number(settled)).toBeCloseTo(DESIGN_WIDTH, 3);
  });

  it('can be switched off, and then behaves like an ordinary page', () => {
    const { element } = fakeRoot(1366);
    expect(applyViewportZoom(element, false)).toBe(1);
    expect(element.style.zoom).toBe('');
    expect(applyViewportZoom(element, true)).toBeCloseTo(1366 / DESIGN_WIDTH, 5);
  });

  it('reads the preference before first paint, so switching it off never flashes', () => {
    expect(VIEWPORT_ZOOM_SCRIPT).toContain(CANVAS_STORAGE_KEY);
    expect(VIEWPORT_ZOOM_SCRIPT).toContain(CANVAS_DISABLED_VALUE);
    // A blocked localStorage throws on read; the layout must survive that.
    expect(VIEWPORT_ZOOM_SCRIPT).toContain('catch(e){}');
  });

  it('offers the switch in the profile menu, on by default', () => {
    const header = readFileSync('src/components/shared/app-header.tsx', 'utf8');
    expect(header).toContain('useFixedCanvas()');
    expect(header).toContain('role="switch"');
    expect(header).toContain('aria-checked={fixedCanvas.enabled}');
    expect(header).toContain('Fixed layout');
    const store = readFileSync('src/components/shared/viewport-scale.tsx', 'utf8');
    // The server snapshot is the default, so hydration cannot disagree.
    expect(store).toContain('() => true');
  });

  it('keeps floating elements attached to what opened them', () => {
    // Radix measures the trigger in physical pixels but writes the offset into
    // the zoomed space, so without this every menu opened short by the zoom
    // factor -- 270px at 1600. Floating UI cannot see CSS zoom on its own.
    const css = readFileSync('src/app/globals.css', 'utf8');
    expect(css).toContain(
      '[data-radix-popper-content-wrapper] {\n  zoom: calc(1 / var(--canvas-zoom, 1));',
    );
    expect(css).toContain(
      '[data-radix-popper-content-wrapper] > * {\n  zoom: var(--canvas-zoom, 1);',
    );
  });

  it('publishes the zoom for those rules to divide by', () => {
    const { element, properties } = fakeRoot(1600);
    applyViewportZoom(element, true);
    expect(Number(properties.get(CANVAS_ZOOM_PROPERTY))).toBeCloseTo(1600 / DESIGN_WIDTH, 5);
    applyViewportZoom(element, false);
    // Off-canvas the rules have to cancel out, not divide by nothing.
    expect(properties.get(CANVAS_ZOOM_PROPERTY)).toBe('1');
    expect(VIEWPORT_ZOOM_SCRIPT).toContain(CANVAS_ZOOM_PROPERTY);
  });

  it('lets charts map the pointer to the right data point', () => {
    // ECharts converts pointer coordinates without accounting for CSS zoom, so
    // hovering 27 Aug reported 25 Aug. It draws in physical pixels instead.
    const chart = readFileSync('src/components/charts/e-chart.tsx', 'utf8');
    expect(chart).toContain("canvas.style.zoom = zoom === 1 ? '' : String(1 / zoom)");
    expect(chart).toContain('Math.round(width * zoom)');
    // Drawing in physical pixels means every size has to come back down.
    expect(chart).toContain('const px = (value: number) => value * scale;');
    expect(chart).toContain(
      CANVAS_ZOOM_CHANGED_EVENT.length > 0 ? 'CANVAS_ZOOM_CHANGED_EVENT' : '',
    );
    const store = readFileSync('src/components/shared/viewport-scale.tsx', 'utf8');
    // A zoom change moves no layout box, so nothing else would notice it.
    expect(store).toContain('new Event(CANVAS_ZOOM_CHANGED_EVENT)');
  });

  it('holds the desktop layout between its floor and its canvas', () => {
    expect(shell).toContain('lg:min-w-[1280px]');
    expect(shell).toContain(`max-w-[${DESIGN_CONTENT_WIDTH}px]`);
    expect(layout).toContain('VIEWPORT_ZOOM_SCRIPT');
    expect(layout).toContain('<ViewportScale />');
  });
});
