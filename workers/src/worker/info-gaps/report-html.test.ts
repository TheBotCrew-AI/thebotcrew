import { describe, it, expect } from 'vitest';
import { markdownToHtml, renderReportPage } from './report-html.js';
import { buildReport } from './report.js';

describe('markdownToHtml — the subset report.ts emits', () => {
  it('renders headings, lists, quotes, a table and inline marks', () => {
    const html = markdownToHtml([
      '# Título',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '## Sección',
      '### tema · 3× · `precio` → `offering`',
      'Cómo lo preguntan:',
      '  - "uno"',
      '  - "dos"',
      'Texto propuesto:',
      '> línea 1',
      '> línea 2',
      '_Nada nuevo en esta ventana._',
    ].join('\n'));
    expect(html).toContain('<h1>Título</h1>');
    expect(html).toContain('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
    expect(html).toContain('<h3>tema · 3× · <code>precio</code> → <code>offering</code></h3>');
    expect(html).toContain('<ul><li>&quot;uno&quot;</li><li>&quot;dos&quot;</li></ul>');
    expect(html).toContain('<blockquote>línea 1<br>línea 2</blockquote>');
    expect(html).toContain('<p><em>Nada nuevo en esta ventana.</em></p>');
  });

  it('escapes what leads typed', () => {
    const html = markdownToHtml('  - "<script>alert(1)</script> & co"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; co');
  });

  it('round-trips a real report without dropping sections', () => {
    const { markdown } = buildReport({
      businessName: 'MADI Skin Care', runId: 'run-1', windowFrom: '2026-07-29T00:00:00Z', windowTo: '2026-08-25T00:00:00Z',
      candidates: 3, extracted: 3, failed: 0, gaps: [], touched: new Set(), unanswered: [], configChangedAt: null,
    });
    const page = renderReportPage(markdown, { runId: 'run-1', createdAt: '2026-08-25T20:41:00Z', mdUrl: '?format=md' });
    for (const h of ['1. Listo para cargar', '2. Preguntar al cliente', '3. El bot lo tenía', '4. Sin respuesta de nadie']) {
      expect(page).toContain(h);
    }
    expect(page).toContain('<title>MADI Skin Care — huecos de información</title>');
    expect(page).toContain('href="?format=md"');
  });

  it('lists the other runs as links and the current one as text', () => {
    const page = renderReportPage('# X', {
      runId: 'run-2', createdAt: '2026-09-01T13:00:00Z', mdUrl: '?format=md',
      runs: [
        { runId: 'run-2', createdAt: '2026-09-01T13:00:00Z', url: '?run=run-2&key=k' },
        { runId: 'run-1', createdAt: '2026-08-25T20:41:00Z', url: '?run=run-1&key=k' },
      ],
    });
    expect(page).toContain('Corridas: <strong>2026-09-01</strong> · <a href="?run=run-1&amp;key=k">2026-08-25</a>');
  });
});
