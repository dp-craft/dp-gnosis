/**
 * XML escaping — five characters, no dependency.
 *
 * Entity escaping, not CDATA, and deliberately so: atom bodies are markdown that
 * routinely carries `<`, `&`, quotes and code fences, and a body containing the
 * literal `]]>` terminates a CDATA section early, producing malformed output for
 * exactly the documents most worth retrieving. Entities have no such escape
 * hatch to lose, and the SAME function is safe in text and in an attribute
 * value, so a caller cannot pick the wrong one.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&apos;',
};

/** Escape a value for use as XML character data OR as an attribute value. */
export const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, character => ENTITIES[character] ?? character);

/** One `name="value"` attribute with its value escaped. */
export const xmlAttribute = (name: string, value: string): string =>
  `${name}="${escapeXml(value)}"`;
