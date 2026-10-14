/**
 * Bound original request headers before rendering or escaping them. A HAR can
 * contain very large header values; building their full joined string would
 * copy private input and block the main thread even in a collapsed inspector.
 * The returned text is still untrusted and must be escaped by its renderer.
 */
export function formatHeaderPreview(headers, options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const limit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const maxChars = limit(settings.maxChars, 65_536);
  const maxHeaders = limit(settings.maxHeaders, 200);
  if (!Array.isArray(headers)) return { text: '', truncated: false };

  const chunks = [];
  let remaining = maxChars;
  let count = 0;
  const result = (truncated) => ({ text: chunks.join(''), truncated });
  const append = (value) => {
    const length = Math.min(remaining, value.length);
    if (length) chunks.push(length === value.length ? value : value.slice(0, length));
    remaining -= length;
    return length === value.length;
  };

  for (const header of headers) {
    if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
    if (count >= maxHeaders) return result(true);
    const name = typeof header.name === 'string' ? header.name : '?';
    const value = typeof header.value === 'string' ? header.value : '?';
    // Append each piece individually so an oversized name or value is never
    // concatenated into a full header before the character budget is applied.
    if ((count && !append('\n')) || !append(name) || !append(': ') || !append(value)) {
      return result(true);
    }
    count += 1;
  }
  return result(false);
}
