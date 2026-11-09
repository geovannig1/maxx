/**
 * A structural view of rendered email HTML for equivalence checks across renderers. Exact markup may
 * differ between renderers, so this keeps what the reader and the mail client see — element nesting,
 * attributes, inline style declarations, text and links — and drops only what cannot change either:
 * comments (React streaming markers), attribute order and whitespace runs. Inline style declarations
 * keep their order: a later shorthand (`margin`) overrides an earlier longhand (`margin-top`), so the
 * order is part of what the mail client renders.
 *
 * The input is React-generated markup (every attribute double-quoted, every element closed), which is
 * why a tokenizer is enough here; it is not a general HTML parser.
 */

/** Attributes that are deliberately not carried across renderers; each is explained where removed. */
const IGNORED_ATTRIBUTES = new Set([
  // react-email's own <Column> marker. It is not read by any mail client and named a library the
  // renderer no longer uses.
  'data-id=__react-email-column',
])

const VOID_ELEMENTS = new Set(['meta', 'br', 'link', 'img', 'hr', 'input'])

const TOKEN = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|[^<]+|</g
const ATTRIBUTE = /([^\s=>/]+)(?:="([^"]*)")?/g

export interface HtmlTag {
  name: string
  attributes: Array<[string, string]>
}

function styleDeclarations(value: string): string {
  return value.split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0)
    .map((declaration) => {
      const colon = declaration.indexOf(':')
      return `${declaration.slice(0, colon).trim().toLowerCase()}:${declaration.slice(colon + 1).trim()}`
    })
    .join('; ')
}

function attributesOf(source: string): Array<[string, string]> {
  const attributes: Array<[string, string]> = []
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? ''
    if (IGNORED_ATTRIBUTES.has(`${name}=${value}`)) continue
    attributes.push([name, name === 'style' ? styleDeclarations(value) : value])
  }
  return attributes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Every start tag in document order, attributes parsed. */
export function startTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = []
  for (const match of html.matchAll(TOKEN)) {
    if (match[2]) tags.push({ name: match[2].toLowerCase(), attributes: attributesOf(match[3] ?? '') })
  }
  return tags
}

/**
 * One line per element or text run, indented by depth. Throws on a stray `<` or an unbalanced close
 * tag, so markup that is not well formed can never compare equal by accident.
 */
export function htmlStructure(html: string): string {
  const lines: string[] = []
  const open: string[] = []
  for (const match of html.matchAll(TOKEN)) {
    const [token, closing, opening, attributeSource, selfClosing] = match
    const indent = '  '.repeat(open.length)
    if (token.startsWith('<!--')) continue
    if (token.startsWith('<!DOCTYPE')) { lines.push(token.replace(/\s+/g, ' ')); continue }
    if (closing) {
      const expected = open.pop()
      if (expected !== closing.toLowerCase()) throw new Error(`unbalanced </${closing}>, expected </${expected}>`)
      continue
    }
    if (opening) {
      const name = opening.toLowerCase()
      const attributes = attributesOf(attributeSource ?? '')
        .map(([key, value]) => (value === '' ? key : `${key}="${value}"`))
      lines.push(`${indent}<${[name, ...attributes].join(' ')}>`)
      if (!selfClosing && !VOID_ELEMENTS.has(name)) open.push(name)
      continue
    }
    if (token === '<') throw new Error('stray < in rendered HTML')
    const text = token.replace(/\s+/g, ' ').trim()
    if (text.length > 0) lines.push(`${indent}"${text}"`)
  }
  if (open.length > 0) throw new Error(`unclosed elements: ${open.join(', ')}`)
  return `${lines.join('\n')}\n`
}

/** The visible text runs only, in order, whitespace-normalised. */
export function htmlText(html: string): string[] {
  return htmlStructure(html).split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => line.slice(1, -1))
}
