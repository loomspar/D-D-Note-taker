// Turn a Markdown reply into text worth reading aloud.

/** Strips code blocks, raw URLs, tables and Markdown punctuation; keeps the prose. */
export function toSpeakable(md: string): string {
  let s = md.replace(/\r/g, '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' (There is a code block in the panel.) ');
  s = s.replace(/^\s*\|.*\|\s*$/gm, '');                       // table rows
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                   // images
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1');            // links → label
  s = s.replace(/<?https?:\/\/[^\s>)]+>?/g, 'a link in the panel');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s*(.+)$/gm, '$1.');            // headings become sentences
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*([-*+•]|\d+[.)])\s+/gm, '');               // list markers
  s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2'); // emphasis
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');
  s = s.replace(/[*_#|~]/g, '');
  s = s.replace(/\.{2,}\s*/g, '. ').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ');
  s = s.replace(/([.!?:])\./g, '$1');
  return s.trim();
}

/**
 * The part of a reply that is spoken by default: the opening, cut at a sentence boundary. Long
 * scripts and research stay in the panel, with Read aloud available on demand.
 */
export function shortSpoken(md: string, maxChars = 420): string {
  const full = toSpeakable(md);
  if (full.length <= maxChars) return full;
  const sentences = full.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [full];
  let out = '';
  for (const s of sentences) {
    if (out.length + s.length > maxChars) break;
    out += s;
  }
  if (!out) out = full.slice(0, maxChars).replace(/\s+\S*$/, '') + '.';
  return out.trim() + ' The rest is in the panel.';
}

/** Split into utterances short enough that Windows voices do not cut off mid-speech. */
export function chunkForSpeech(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    let rest = s.trim();
    while (rest.length > max) {
      let cut = rest.lastIndexOf(',', max);
      if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
