import type { CSSProperties, ReactElement, ReactNode } from 'react'

/**
 * Gmail-safe email building blocks, rendered by React's own server renderer. They reproduce the
 * table markup the owner emails were first built with (@react-email/components 1.0.12), which was
 * deprecated upstream and pulled `html-to-text` → `deepmerge` into production. Every element here is
 * a plain table, cell or paragraph with inline styles: no <style> block, no class, no script.
 *
 * Untrusted values reach the output only as React text children or attribute values, so React's
 * escaping applies to every one of them; nothing here uses dangerouslySetInnerHTML.
 */

type Props = { children?: ReactNode; style?: CSSProperties }

/** Layout tables are presentation-only: screen readers skip them, mail clients add no spacing. */
const LAYOUT_TABLE = { align: 'center', width: '100%', border: 0, cellPadding: '0', cellSpacing: '0', role: 'presentation' } as const

export function Html({ children, lang = 'en' }: { children: ReactNode; lang?: string }) {
  return <html dir="ltr" lang={lang}>{children}</html>
}

export function Head({ children }: { children?: ReactNode }) {
  return (
    // eslint-disable-next-line @next/next/no-head-element -- an email document rendered to a string, not a Next.js page
    <head>
      <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
      <meta name="x-apple-disable-message-reformatting" />
      {children}
    </head>
  )
}

const BOX_PROPERTIES = ['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const

/**
 * Some clients drop <body> styles, so the full style goes on a wrapping cell. The body keeps only the
 * background, and any margin or padding the caller set is zeroed there so it is not applied twice.
 */
export function Body({ children, style }: Props) {
  const bodyStyle: Record<string, unknown> = { background: style?.background, backgroundColor: style?.backgroundColor }
  if (style) for (const property of BOX_PROPERTIES) bodyStyle[property] = style[property] !== undefined ? 0 : undefined
  return (
    <body style={bodyStyle as CSSProperties}>
      <table {...LAYOUT_TABLE}>
        <tbody><tr><td style={style}>{children}</td></tr></tbody>
      </table>
    </body>
  )
}

export function Container({ children, style }: Props) {
  return (
    <table {...LAYOUT_TABLE} style={{ maxWidth: '37.5em', ...style }}>
      <tbody><tr style={{ width: '100%' }}><td>{children}</td></tr></tbody>
    </table>
  )
}

export function Section({ children, style }: Props) {
  return (
    <table {...LAYOUT_TABLE} style={style}>
      <tbody><tr><td>{children}</td></tr></tbody>
    </table>
  )
}

export function Row({ children, style }: Props) {
  return (
    <table {...LAYOUT_TABLE} style={style}>
      <tbody style={{ width: '100%' }}><tr style={{ width: '100%' }}>{children}</tr></tbody>
    </table>
  )
}

export function Column({ children, style }: Props) {
  return <td style={style}>{children}</td>
}

type Margins = Pick<CSSProperties, 'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft'>
const MARGIN_SIDES = new Set(['marginTop', 'marginRight', 'marginBottom', 'marginLeft'])

/** CSS `margin` shorthand → longhands, so a paragraph's default margins never survive an override. */
function marginLonghands(value: CSSProperties['margin']): Margins {
  const sides = typeof value === 'number' ? [value] : typeof value === 'string' ? value.trim().split(/\s+/) : []
  if (sides.length === 1) return { marginTop: sides[0], marginBottom: sides[0], marginLeft: sides[0], marginRight: sides[0] }
  if (sides.length < 2 || sides.length > 4) return { marginTop: undefined, marginBottom: undefined, marginLeft: undefined, marginRight: undefined }
  const [top, right, bottom = top, left = right] = sides
  return { marginTop: top, marginRight: right, marginBottom: bottom, marginLeft: left }
}

/**
 * Paragraphs default to 16px top and bottom margins; the caller's margins, shorthand or longhand,
 * apply over them in the order the caller wrote them, and every side is emitted as a longhand.
 */
function paragraphMargins(style: CSSProperties | undefined): Margins {
  const merged: CSSProperties = {
    ...(style?.marginTop === undefined ? { marginTop: '16px' } : {}),
    ...(style?.marginBottom === undefined ? { marginBottom: '16px' } : {}),
    ...style,
  }
  let margins: Margins = { marginTop: undefined, marginRight: undefined, marginBottom: undefined, marginLeft: undefined }
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'margin') margins = marginLonghands(value as CSSProperties['margin'])
    else if (MARGIN_SIDES.has(key)) margins = { ...margins, [key]: value }
  }
  return margins
}

export function Text({ children, style }: Props) {
  return <p style={{ fontSize: '14px', lineHeight: '24px', ...style, ...paragraphMargins(style) }}>{children}</p>
}

export function Link({ children, href, style }: Props & { href: string }) {
  return (
    <a href={href} style={{ color: '#067df7', textDecorationLine: 'none', ...style }} target="_blank">{children}</a>
  )
}

/**
 * The whole document as a string, with an HTML5 doctype. React streams a document whose root is
 * <html> with `<!DOCTYPE html>` already; `allReady` waits for the complete tree, so a partial
 * document can never be returned.
 */
export async function renderEmailDocument(email: ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server')
  let failure: unknown = null
  const stream = await renderToReadableStream(email, { onError: (error) => { failure = error } })
  await stream.allReady
  const html = await new Response(stream).text()
  if (failure !== null) throw failure
  return html.startsWith('<!DOCTYPE html>') ? html : `<!DOCTYPE html>${html}`
}
