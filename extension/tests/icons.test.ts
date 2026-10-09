// Icon builder: static data checks plus the DOM it creates, against a minimal stand-in for `document` (the test
// environment is Node, which has no DOM).
import { describe, expect, it } from 'vitest';
import { createIcon, iconPaths } from '../lib/icons';
import type { IconName } from '../lib/icons';

const NAMES: IconName[] = ['crop', 'file-text', 'file-type-pdf', 'upload', 'settings', 'check', 'alert'];

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(child: FakeElement): void {
    this.children.push(child);
  }
}

const fakeDocument = {
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
} as unknown as Document;

describe('icons', () => {
  it.each(NAMES)('%s has at least one path made of SVG path commands', (name) => {
    const paths = iconPaths(name);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(d).toMatch(/^M[-\d. ,a-zA-Z]+$/);
  });

  it('builds a decorative 16px svg with one path element per path', () => {
    const svg = createIcon('upload', fakeDocument) as unknown as FakeElement;
    expect(svg.tag).toBe('svg');
    expect(svg.attributes.get('class')).toBe('icon');
    expect(svg.attributes.get('viewBox')).toBe('0 0 24 24');
    expect(svg.attributes.get('width')).toBe('16');
    expect(svg.attributes.get('height')).toBe('16');
    expect(svg.attributes.get('aria-hidden')).toBe('true');
    expect(svg.children.map((child) => child.attributes.get('d'))).toEqual(iconPaths('upload'));
  });
});
