import { z } from 'zod'

/**
 * A lossless, hash-consed encoding of one JSON value. Every distinct subtree (string, number, object,
 * array) is stored once in `values` and referred to by its position, so a claim that appears in a
 * series point, its comparison and an entity total is written once.
 *
 * `values[i]` is either a JSON primitive or a composite `[tag, ...refs]`, and every ref is an earlier
 * position (`ref < i`), so the table is acyclic and expands in one pass:
 *   tag >= 0  an object with `shapes[tag]` keys, in order; a grouped shape (`{ keys, group }`) takes
 *             the grouped keys' values from one shared tuple (an array entry), then the rest in order;
 *   tag = -1  an array;
 *   tag = -2  a string: the referenced strings joined with ':' (identifiers such as claim IDs).
 *
 * The only promise is meaning: `JSON.stringify(expandJson(compactJson(v)))` equals `JSON.stringify(v)`,
 * key order included. Expansion validates the whole document and bounds the expanded size, since one
 * shared subtree referenced twice per level would otherwise expand exponentially.
 */
export const COMPACT_JSON_ENCODING = 'maxx_compact_json.v1' as const
/** The expanded serialised length a document may reach: the stored snapshot bound (64 MB), far below
 *  V8's maximum string length, so an accepted expansion can be serialised without exhausting memory. */
export const MAX_EXPANDED_JSON_LENGTH = 64 * 1024 * 1024
const ARRAY = -1
const JOIN = -2
const MIN_JOIN_SEGMENTS = 3

type Shape = string[] | { keys: string[]; group: number[] }
type Entry = string | number | boolean | null | number[]
export interface CompactJson { encoding: typeof COMPACT_JSON_ENCODING; shapes: Shape[]; values: Entry[]; root: number }
/** Objects with exactly `keys`, in order, store the `group` keys' values as one shared tuple. */
export interface CompactShapeHint { keys: readonly string[]; group: readonly string[] }

export const CompactJsonSchema = z.object({
  encoding: z.literal(COMPACT_JSON_ENCODING), shapes: z.array(z.unknown()),
  values: z.array(z.unknown()), root: z.number().int().nonnegative(),
}).strict()

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Encodes a JSON value. Throws on anything `JSON.stringify` would not reproduce exactly. */
export function compactJson(value: unknown, hints: readonly CompactShapeHint[] = []): CompactJson {
  const values: Entry[] = [], composites = new Map<string, number>()
  const shapes: Shape[] = [], shapePositions = new Map<string, number>()
  const hinted = new Map(hints.map(hint => [JSON.stringify(hint.keys), hint]))
  // Primitives are keyed by value (0 and -0 serialise alike, as Map keys they are one), composites by
  // their children's positions; an object met again by reference is not walked again.
  const primitives = new Map<string | number | boolean | null, number>(), strings = new Map<string, number>()
  const objects = new WeakMap<object, number>()
  const intern = <K>(index: Map<K, number>, key: K, entry: Entry): number => {
    let position = index.get(key)
    if (position === undefined) {
      position = values.length
      values.push(entry)
      index.set(key, position)
    }
    return position
  }
  const put = (key: string, entry: Entry) => intern(composites, key, entry)
  const primitive = (entry: string | number | boolean | null) => intern(primitives, entry, entry)
  const shapeOf = (keys: string[]): number => {
    const signature = JSON.stringify(keys)
    let position = shapePositions.get(signature)
    if (position === undefined) {
      const hint = hinted.get(signature)
      const group = hint ? keys.flatMap((key, index) => hint.group.includes(key) ? [index] : []) : []
      position = shapes.length
      shapes.push(group.length ? { keys, group } : keys)
      shapePositions.set(signature, position)
    }
    return position
  }
  const encode = (input: unknown): number => {
    if (input === null || typeof input === 'boolean') return primitive(input)
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Compact JSON cannot encode a non-finite number.')
      return primitive(input)
    }
    if (typeof input === 'string') {
      let position = strings.get(input)
      if (position === undefined) {
        const segments = input.split(':')
        const refs = segments.length < MIN_JOIN_SEGMENTS ? [] : segments.map(primitive)
        position = refs.length ? put(`j${refs.join(',')}`, [JOIN, ...refs]) : primitive(input)
        strings.set(input, position)
      }
      return position
    }
    if (typeof input !== 'object' || input === null) throw new Error('Compact JSON accepts plain JSON values only.')
    const known = objects.get(input)
    if (known !== undefined) return known
    const position = encodeComposite(input)
    objects.set(input, position)
    return position
  }
  const encodeComposite = (input: object): number => {
    if (Array.isArray(input)) {
      const refs = input.map(item => encode(item === undefined ? null : item))
      return put(`a${refs.join(',')}`, [ARRAY, ...refs])
    }
    if (!isPlainObject(input)) throw new Error('Compact JSON accepts plain JSON values only.')
    const keys = Object.keys(input).filter(key => input[key] !== undefined)
    if (keys.includes('__proto__')) throw new Error('Compact JSON cannot encode a prototype key.')
    const shape = shapeOf(keys)
    const refs = keys.map(key => encode(input[key]))
    const descriptor = shapes[shape]
    if (Array.isArray(descriptor)) return put(`o${shape}:${refs.join(',')}`, [shape, ...refs])
    const tuple = descriptor.group.map(index => refs[index])
    const group = put(`a${tuple.join(',')}`, [ARRAY, ...tuple])
    const rest = refs.filter((_, index) => !descriptor.group.includes(index))
    return put(`o${shape}:${group}|${rest.join(',')}`, [shape, group, ...rest])
  }
  const root = encode(value)
  return { encoding: COMPACT_JSON_ENCODING, shapes, values, root }
}

function invalid(message: string): never {
  throw new Error(`Invalid compact JSON: ${message}`)
}

function readShape(raw: unknown): { keys: string[]; group: number[] } {
  const keys = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' && Object.keys(raw).length === 2 ? (raw as { keys?: unknown }).keys : undefined
  const group = Array.isArray(raw) ? [] : (raw as { group?: unknown } | null)?.group
  if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string') || new Set(keys).size !== keys.length) invalid('shape keys')
  if (keys.includes('__proto__')) invalid('prototype key')
  if (!Array.isArray(group) || (!Array.isArray(raw) && group.length === 0)
    || !group.every((index, position) => Number.isInteger(index) && index >= 0 && index < keys.length && (position === 0 || index > group[position - 1]))) {
    invalid('shape group')
  }
  return { keys, group }
}

/** JSON-serialised length of a primitive entry (the same unit as `MAX_EXPANDED_JSON_LENGTH`). */
const primitiveLength = (value: string | number | boolean | null) => JSON.stringify(value).length

/** Validates the whole document and expands it into frozen, shared nodes. */
export function expandJson(raw: unknown, options: { maxLength?: number } = {}): unknown {
  const maxLength = options.maxLength ?? MAX_EXPANDED_JSON_LENGTH
  const document = CompactJsonSchema.parse(raw)
  const shapes = document.shapes.map(readShape)
  const keyLengths = shapes.map(shape => shape.keys.map(key => JSON.stringify(key).length + 1))
  const count = document.values.length
  const decoded: unknown[] = new Array(count), lengths: number[] = new Array(count), tuples: boolean[] = new Array(count)
  // Joined strings are the only entries that allocate new text; their raw length is summed and checked
  // BEFORE joining, per entry and across the document, so a join cannot amplify memory past the bound.
  let joinedChars = 0
  for (let position = 0; position < count; position += 1) {
    const entry = document.values[position]
    let length: number
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' || typeof entry === 'number') {
      if (typeof entry === 'number' && !Number.isFinite(entry)) invalid('non-finite number')
      decoded[position] = entry
      length = primitiveLength(entry)
    } else {
      if (!Array.isArray(entry) || entry.length === 0) invalid('entry')
      const [tag, ...refs] = entry as unknown[]
      if (!refs.every(ref => Number.isInteger(ref) && (ref as number) >= 0 && (ref as number) < position)) invalid('reference')
      const children = refs as number[]
      if (tag === ARRAY) {
        decoded[position] = Object.freeze(children.map(ref => decoded[ref]))
        tuples[position] = true
        length = 2 + Math.max(children.length - 1, 0) + children.reduce((sum, ref) => sum + lengths[ref], 0)
      } else if (tag === JOIN) {
        if (children.length < 2 || !children.every(ref => typeof decoded[ref] === 'string')) invalid('join')
        const rawLength = children.reduce((sum, ref) => sum + (decoded[ref] as string).length, children.length - 1)
        joinedChars += rawLength
        if (rawLength > maxLength || joinedChars > maxLength) throw new Error('Invalid compact JSON: the expanded value is too large.')
        const text = children.map(ref => decoded[ref] as string).join(':')
        decoded[position] = text
        length = primitiveLength(text)
      } else if (Number.isInteger(tag) && (tag as number) >= 0 && (tag as number) < shapes.length) {
        const { keys, group } = shapes[tag as number]
        let slots = children
        if (group.length) {
          const [tuple, ...rest] = children
          if (tuple === undefined || !tuples[tuple] || (decoded[tuple] as unknown[]).length !== group.length) invalid('group tuple')
          if (rest.length !== keys.length - group.length) invalid('object arity')
          const grouped = document.values[tuple] as number[]
          slots = []
          for (let index = 0, next = 0; index < keys.length; index += 1) {
            const member = group.indexOf(index)
            slots.push(member >= 0 ? grouped[member + 1] : rest[next++])
          }
        }
        if (slots.length !== keys.length) invalid('object arity')
        const object: Record<string, unknown> = {}
        length = 2 + Math.max(keys.length - 1, 0)
        keys.forEach((key, index) => {
          object[key] = decoded[slots[index]]
          length += keyLengths[tag as number][index] + lengths[slots[index]]
        })
        decoded[position] = Object.freeze(object)
      } else invalid('tag')
    }
    if (length > maxLength) throw new Error('Invalid compact JSON: the expanded value is too large.')
    lengths[position] = length
  }
  if (document.root >= count) invalid('root')
  return decoded[document.root]
}

/** Every distinct string value and object key of a document that `expandJson` accepted, without expanding it. */
export function compactJsonTokens(document: z.infer<typeof CompactJsonSchema>): { strings: Set<string>; keys: Set<string> } {
  const strings = new Set<string>(), keys = new Set<string>()
  for (const shape of document.shapes as Shape[]) for (const key of Array.isArray(shape) ? shape : shape.keys) keys.add(key)
  for (const entry of document.values as Entry[]) {
    if (typeof entry === 'string') strings.add(entry)
    else if (Array.isArray(entry) && entry[0] === JOIN) strings.add(entry.slice(1).map(ref => document.values[ref] as string).join(':'))
  }
  return { strings, keys }
}
