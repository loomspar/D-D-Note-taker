// Small, safe Markdown renderer: builds React elements directly, never injects HTML.
import type { ReactNode } from 'react';
import { call } from '../bridge';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*([^*\s][^*]*)\*)|(_([^_\s][^_]*)_)|(https?:\/\/[^\s<>)]+)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  const link = (url: string, label: string) => <a key={`${key}-${i++}`} href={url} title={url} onClick={(e) => { e.preventDefault(); void call('external:open', url); }}>{label}</a>;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${i++}`}>{m[2]}</strong>);
    else if (m[3]) out.push(<code key={`${key}-${i++}`}>{m[4]}</code>);
    else if (m[5]) out.push(link(m[7], m[6]));
    else if (m[8]) out.push(<em key={`${key}-${i++}`}>{m[9]}</em>);
    else if (m[10]) out.push(<em key={`${key}-${i++}`}>{m[11]}</em>);
    else if (m[12]) out.push(link(m[12], m[12].replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++; blocks.push(<pre key={k++}><code>{code.join('\n')}</code></pre>); continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const Tag = (`h${Math.min(4, h[1].length + 1)}`) as 'h2'; blocks.push(<Tag key={k++}>{inline(h[2], `h${k}`)}</Tag>); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2; const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      blocks.push(<div className="tablewrap" key={k++}><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `th${j}`)}</th>)}</tr></thead><tbody>{body.map((r, a) => <tr key={a}>{r.map((c, j) => <td key={j}>{inline(c, `td${a}-${j}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const isUl = (l: string) => /^\s*[-*+]\s+/.test(l), isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line); const items: string[] = [];
      while (i < lines.length && (isUl(lines[i]) || isOl(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isUl(lines[i]) || isOl(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const lis = items.map((t, j) => { const cb = /^\[( |x)\]\s+(.*)$/i.exec(t); return <li key={j} className={cb ? 'check' : undefined}>{cb ? <><input type="checkbox" defaultChecked={cb[1].toLowerCase() === 'x'} /> {inline(cb[2], `li${j}`)}</> : inline(t, `li${j}`)}</li>; });
      blocks.push(ordered ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>); continue;
    }
    if (/^\s*>/.test(line)) { const q: string[] = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); blocks.push(<blockquote key={k++}>{inline(q.join(' '), `q${k}`)}</blockquote>); continue; }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { blocks.push(<hr key={k++} />); i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={k++}>{inline(para.join(' '), `p${k}`)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
