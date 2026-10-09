// Icons for every extension page. Paths are copied from Tabler Icons (https://tabler.io/icons, MIT license, outline
// style, 24x24 grid), so no icon package is installed. The look (16px, currentColor stroke, width 1.75) comes from the
// `.icon` class in assets/components.css. Add an icon here only when a screen uses it.

export type IconName = 'crop' | 'file-text' | 'file-type-pdf' | 'upload' | 'settings' | 'check' | 'alert';

/** One entry per Tabler icon; "alert" is Tabler's `alert-circle`. Each string is the `d` attribute of one path. */
const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  crop: ['M8 5v10a1 1 0 0 0 1 1h10', 'M5 8h10a1 1 0 0 1 1 1v10'],
  'file-text': [
    'M14 3v4a1 1 0 0 0 1 1h4',
    'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2',
    'M9 9l1 0',
    'M9 13l6 0',
    'M9 17l6 0',
  ],
  'file-type-pdf': [
    'M14 3v4a1 1 0 0 0 1 1h4',
    'M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4',
    'M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6',
    'M17 18h2',
    'M20 15h-3v6',
    'M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1',
  ],
  upload: ['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2', 'M7 9l5 -5l5 5', 'M12 4l0 12'],
  settings: [
    'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065',
    'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
  ],
  check: ['M5 12l5 5l10 -10'],
  alert: ['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M12 8v4', 'M12 16h.01'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The `d` attribute of each path of an icon (exported so tests can check the data). */
export function iconPaths(name: IconName): readonly string[] {
  return ICON_PATHS[name];
}

/**
 * A decorative 16px icon: hidden from assistive technology, so put the meaning in a visible label or an aria-label on
 * the control around it. The `document` parameter lets code inside a shadow root or another frame pass its own.
 */
export function createIcon(name: IconName, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  // Sized here as well as in CSS, so an icon is never 300px wide while a stylesheet is still loading.
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICON_PATHS[name]) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
