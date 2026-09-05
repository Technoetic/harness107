// Checks the final deliverable boundary; browser behavior is verified separately.
export function validateHtmlBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
    throw new Error('HTML must contain between 1 byte and 8 MiB');
  }
  let html;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('HTML must be valid UTF-8'); }
  // Tokenize markup so quoted attributes, comments and raw text cannot stand in
  // for actual document elements. This is a boundary check, not an HTML linter.
  const tokens = /<!--[^]*?(?:-->|$)|<![^>]*>|<\/?[a-z][a-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let opened = false, closed = false, rawText = null;
  for (const match of html.matchAll(tokens)) {
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)(?:\s|\/?>)/i.exec(match[0]);
    if (!tag) continue;
    const closing = tag[1] === '/', name = tag[2].toLowerCase();
    if (rawText) { if (closing && name === rawText) rawText = null; continue; }
    if (!closing && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'].includes(name)) rawText = name;
    if (name === 'html') {
      if (!closing) opened = true;
      else if (opened) closed = true;
    }
  }
  if (html.includes('\0') || !opened || !closed) {
    throw new Error('HTML requires opening and closing html elements and no binary bytes');
  }
  return html;
}
