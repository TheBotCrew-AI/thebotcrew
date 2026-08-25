/**
 * The report as a page a browser can open. Pure.
 *
 * Renders only the markdown subset `report.ts` emits — headings, bullet lists,
 * blockquotes, a pipe table, bold/italic/inline code — so it stays a hundred lines
 * instead of a dependency. Everything is escaped first; the markdown is ours, but
 * the quotes inside it are leads' messages.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
}

export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  let i = 0;
  const flushList = (items: string[]) => {
    if (items.length > 0) out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
    items.length = 0;
  };
  const list: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flushList(list);
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*- /.test(line)) {
      list.push(line.replace(/^\s*- /, ''));
      i++;
      continue;
    }
    flushList(list);
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('> ')) quote.push(lines[i]!.slice(2)), i++;
      out.push(`<blockquote>${inline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!.slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<table><thead><tr>${(head ?? []).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  flushList(list);
  return out.join('\n');
}

export function renderReportPage(markdown: string, meta: { runId: string; createdAt: string; mdUrl: string }): string {
  const title = /^# (.*)$/m.exec(markdown)?.[1] ?? 'Reporte';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;background:#fff;color:#2a2226;font:16px/1.55 system-ui,-apple-system,sans-serif}
  main{max-width:72ch;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:2rem;line-height:1.15;margin:0 0 8px}h2{font-size:1.4rem;margin:44px 0 12px;padding-top:16px;border-top:1px solid #e5dadf}
  h3{font-size:1.05rem;margin:22px 0 6px}p{margin:6px 0}ul{margin:4px 0 8px;padding-left:20px}li{margin:2px 0}
  blockquote{margin:6px 0;padding:8px 14px;background:#f0f4f1;border-left:3px solid #bfd3c4;border-radius:0 4px 4px 0}
  table{border-collapse:collapse;margin:12px 0;font-size:.9rem}th,td{padding:8px 12px;border:1px solid #e5dadf;text-align:left}th{background:#f7f2f4;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;background:#f7f2f4;padding:1px 5px;border-radius:3px}
  em{color:#6e5f67}.meta{color:#6e5f67;font-size:.8rem;margin-bottom:24px}.meta a{color:#7a2e4a}
  @media(prefers-color-scheme:dark){body{background:#1b1619;color:#f1e9ec}h2{border-color:#3a2f34}blockquote{background:#1e2622;border-color:#34493b}th,td{border-color:#3a2f34}th,code{background:#241d21}em,.meta{color:#a8969e}.meta a{color:#d98ba6}}
</style></head><body><main>
<div class="meta">Generado ${escapeHtml(meta.createdAt.slice(0, 16).replace('T', ' '))} UTC · corrida <code>${escapeHtml(meta.runId.slice(0, 8))}</code> · <a href="${escapeHtml(meta.mdUrl)}">markdown</a></div>
${markdownToHtml(markdown)}
</main></body></html>`;
}
