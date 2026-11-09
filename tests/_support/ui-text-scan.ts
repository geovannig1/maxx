import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { listSourceFiles } from './source-scan'

// Owner-visible TEXT in screen code: JSX text and string/template literals, read through the TypeScript
// parser so comments, identifiers (`realBookings`, `total_bookings`) and code-only strings never count.
// A literal is code, not text, when it is a module path, a type, a property key, an element-access key,
// one side of an equality comparison, a `case` label, or a single lower-case token with no spaces
// (`'bookings'` as a metric key). Everything else a screen renders or passes on is text.

export interface UiTextHit {
  file: string
  line: number
  text: string
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
])

function isCodeLiteral(node: ts.Node, text: string): boolean {
  const parent = node.parent
  if (!parent) return false
  if (/^[a-z0-9_.:-]+$/.test(text)) return true
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true
  if (ts.isImportTypeNode(parent) || ts.isLiteralTypeNode(parent)) return true
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent)
    || ts.isMethodDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return true
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) return true
  if (ts.isCaseClause(parent) && parent.expression === node) return true
  if (ts.isJsxAttribute(parent) && /^(data-|key$|className$|id$|href$|htmlFor$|name$)/.test(parent.name.getText())) return true
  return false
}

/** Every owner-visible text fragment in `file` matching `pattern`. */
export function scanUiTextFile(file: string, rel: string, pattern: RegExp): UiTextHit[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: UiTextHit[] = []
  const record = (node: ts.Node, text: string) => {
    if (!pattern.test(text) || isCodeLiteral(node, text)) return
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    hits.push({ file: rel, line, text: text.replace(/\s+/g, ' ').trim() })
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) record(node, node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node, node.text)
    else if (ts.isTemplateExpression(node)) {
      record(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('${…}'))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

/** Every owner-visible text fragment under `roots` (relative to `base`), skipping `exclude` prefixes. */
export function scanUiText(base: string, roots: readonly string[], pattern: RegExp, exclude: readonly string[] = []): UiTextHit[] {
  return roots.flatMap((root) => listSourceFiles(path.join(base, root)))
    .map((file) => ({ file, rel: path.relative(base, file).split(path.sep).join('/') }))
    .filter(({ rel }) => !exclude.some((prefix) => rel.startsWith(prefix)))
    .flatMap(({ file, rel }) => scanUiTextFile(file, rel, pattern))
}
