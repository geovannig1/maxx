import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Static inventory of environment reads: literal (`process.env.X`), element (`process.env['X']`),
// aliased (`const vars = process.env; vars.X`, and the conventional injected record `env.X`) and
// destructured (`const { X } = process.env`) reads, plus the reads that cannot be resolved statically:
// `process.env[expression]`. The one detector behind tests/env-schema-population.test.ts (envReads)
// and tests/client-server-boundary.test.ts (envReadsOf(...).all).

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs']
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

export function listSources(dir: string): string[] {
  if (!existsSync(dir)) return []
  if (statSync(dir).isFile()) return [dir]
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : listSources(full)
    return EXTENSIONS.includes(path.extname(full)) && !full.endsWith('.d.ts') ? [full] : []
  })
}

/** The key a destructuring element reads: `{ X }`, `{ X: y }`, `{ 'X': y }` or `{ ['X']: y }`. */
export function bindingKey(element: ts.BindingElement): string | null {
  const key = element.propertyName ?? element.name
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text
  if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)) return key.expression.text
  return null
}

/** `process.env[k] = v` writes; it reads nothing. */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent
  return ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
}

export interface EnvReads {
  /** Statically known names (upper-snake only, so `env.ok` on an unrelated `env` is ignored). */
  names: Set<string>
  /** Lines with `process.env[expr]` (or an explicit alias of process.env) where expr is not a literal. */
  dynamic: number[]
}

export function envReads(file: string): EnvReads {
  const { all, dynamic } = envReadsOf(file)
  return { names: new Set([...all].filter((name) => ENV_NAME.test(name))), dynamic }
}

/** Every statically known name read from the environment record (unfiltered), and the dynamic reads. */
export function envReadsOf(file: string): { all: Set<string>; dynamic: number[] } {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const explicitAliases = new Set<string>()
  const collect = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)
      && node.initializer?.getText() === 'process.env') explicitAliases.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  // `env` is the conventional name of an injected environment record (readAiConfig(env), …).
  const isEnv = (e: ts.Expression) => e.getText() === 'process.env' || e.getText() === 'env' || explicitAliases.has(e.getText())
  const isRealEnv = (e: ts.Expression) => e.getText() === 'process.env' || explicitAliases.has(e.getText())
  const all = new Set<string>()
  const dynamic: number[] = []
  const add = (name: string) => { all.add(name) }
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isEnv(node.expression)) add(node.name.text)
    else if (ts.isElementAccessExpression(node) && isEnv(node.expression)) {
      if (ts.isStringLiteralLike(node.argumentExpression)) add(node.argumentExpression.text)
      else if (isRealEnv(node.expression) && !isAssignmentTarget(node)) dynamic.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isObjectBindingPattern(node.name)
      && node.initializer && isEnv(node.initializer)) {
      for (const element of node.name.elements) {
        const key = bindingKey(element)
        if (key) add(key)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { all, dynamic }
}

/** Upper-snake string literals in a file: the candidate names behind its dynamic reads. */
export function upperSnakeLiterals(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && ENV_NAME.test(node.text) && node.text.includes('_')) found.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
