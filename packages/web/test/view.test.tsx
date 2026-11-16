import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProps } from '../src/view-types.js';
import { ImportWorkbench } from '../src/ImportWorkbench.js';

const props = (): WorkbenchProps => ({
  connected: false, projectId: '', projects: [], sources: null, page: null, format: 'novel', busy: null,
  progress: null, error: null, message: null, canImport: false,
  onConnect: vi.fn(), onDisconnect: vi.fn(), onProject: vi.fn(), onFormat: vi.fn(), onFile: vi.fn(),
  onOpen: vi.fn(), onRead: vi.fn(), onPrevious: vi.fn(), onCheckpoint: vi.fn(), onMore: vi.fn(),
});
describe('source workbench rendering boundary', () => {
  it('offers a credential connection without embedding source or persistent credential state', () => {
    const html = renderToStaticMarkup(<ImportWorkbench {...props()} />);
    expect(html).toContain('type="password"'); expect(html).toContain('访问凭证');
    expect(html).not.toContain('Bearer'); expect(html).not.toContain('localStorage');
  });
  it('renders untrusted source title and body as text, never as markup', () => {
    const base = props();
    const html = renderToStaticMarkup(<ImportWorkbench {...base} connected projectId="p1" projects={[{ id: 'p1', canImport: true }]} canImport
      page={{ documentId: 'doc', title: '<script>bad()</script>', kind: 'novel', format: 'novel', revision: 1,
        sourceDigest: 'a'.repeat(64), originalDigest: 'a'.repeat(64), totalCharacters: 32, unitCount: 1, warnings: [],
        excerpt: { start: 0, end: 32, text: '<img src=x onerror="bad()">原文' }, units: [], checkpoint: null }} />);
    expect(html).not.toContain('<script>bad()'); expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
    expect(html).toContain('保存阅读位置');
  });
  it('keeps viewer reading available and never offers script reading-progress writes', () => {
    const base = props();
    const html = renderToStaticMarkup(<ImportWorkbench {...base} connected projectId="p1" projects={[{ id: 'p1', canImport: false }]}
      page={{ documentId: 'script', title: '剧本', kind: 'script', format: 'fountain', revision: 1,
        sourceDigest: 'a'.repeat(64), originalDigest: 'a'.repeat(64), totalCharacters: 20, unitCount: 1, warnings: [],
        excerpt: { start: 0, end: 10, text: '原文' }, units: [], checkpoint: null }} />);
    expect(html).toContain('当前角色可阅读'); expect(html).not.toContain('保存阅读位置');
    expect(html).toContain('下一段'); expect(html).toMatch(/type="file"[^>]*disabled/);
  });
  it('hides stale project and source data as soon as the connection is absent', () => {
    const html = renderToStaticMarkup(<ImportWorkbench {...props()} projectId="private-project" projects={[{ id: 'private-project', canImport: true }]}
      sources={{ items: [{ documentId: 'private-source', title: 'private-title', kind: 'novel', format: 'novel', revision: 1 }], nextCursor: 'private-cursor' }} message="private-title imported" />);
    expect(html).not.toContain('private-project'); expect(html).not.toContain('private-title'); expect(html).not.toContain('private-source');
    expect(html).toContain('连接后选择项目');
  });
});
