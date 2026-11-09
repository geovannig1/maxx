import { describe, expect, it, vi } from 'vitest'
import { compactJson, compactJsonTokens, expandJson, COMPACT_JSON_ENCODING, MAX_EXPANDED_JSON_LENGTH, type CompactJson } from '@/lib/reporting/compact-json'

// The compact encoding stores every distinct JSON subtree once and refers to it by position. Its only
// promise is meaning: the expansion serialises to exactly the bytes of the original value.
const roundTrip = (value: unknown, hints = []) => JSON.stringify(expandJson(JSON.parse(JSON.stringify(compactJson(value, hints)))))
const doc = (values: unknown[], shapes: unknown[] = [], root = values.length - 1) =>
  ({ encoding: COMPACT_JSON_ENCODING, shapes, values, root })

describe('compact JSON round trip', () => {
  it('reproduces the exact serialised bytes of varied JSON values', () => {
    const samples: unknown[] = [
      null, true, false, 0, -0, 1.5e-7, 123456789.125, 'plain', '', 'a:b', 'report:meta:campaign:101:spend:2026-08-01:2026-08-01:daily',
      '::', 'x:', ':x:', 'é × 😀', '\ud800 lone', [], {}, [[], [{}]],
      { b: 1, a: 2, 10: 'ten', 2: 'two', nested: { z: [1, 'a:b:c', null], y: { '': 'empty key' } } },
      { dropped: undefined, kept: [undefined, 1] },
    ]
    for (const sample of samples) expect(roundTrip(sample)).toBe(JSON.stringify(sample))
  })

  it('stores a repeated subtree once and still expands every occurrence', () => {
    const claim = { claimId: 'report:meta:account:1:spend:2026-08-01:2026-08-01:daily', value: 12.5, window: { start: '2026-08-01' } }
    const value = { series: Array.from({ length: 50 }, () => ({ metrics: { spend: claim } })) }
    const compact = compactJson(value)
    expect(JSON.stringify(expandJson(compact))).toBe(JSON.stringify(value))
    // Control: the same 50 points with distinct claims need far more entries.
    const distinct = compactJson({ series: Array.from({ length: 50 }, (_, day) => ({ metrics: { spend: { ...claim, value: day } } })) })
    expect(compact.values.length).toBeLessThan(20)
    expect(distinct.values.length).toBeGreaterThan(compact.values.length + 90)
  })

  it('groups hinted keys into one shared tuple without changing key order', () => {
    const hint = { keys: ['id', 'label', 'unit', 'value'], group: ['label', 'unit'] }
    const rows = Array.from({ length: 4 }, (_, index) => ({ id: `r${index}`, label: 'Spend', unit: 'money', value: index }))
    const compact = compactJson(rows, [hint])
    expect(compact.shapes).toEqual([{ keys: ['id', 'label', 'unit', 'value'], group: [1, 2] }])
    expect(JSON.stringify(expandJson(compact))).toBe(JSON.stringify(rows))
    // Objects whose keys differ from the hint keep the plain shape.
    const other = compactJson([{ label: 'Spend', id: 'r', unit: 'money', value: 1 }], [hint])
    expect(other.shapes).toEqual([['label', 'id', 'unit', 'value']])
  })

  it('refuses values that JSON cannot represent exactly', () => {
    for (const value of [Number.NaN, Infinity, new Date(0), new Map(), { at: new Date(0) }, () => 1, undefined, BigInt(10)]) {
      expect(() => compactJson(value)).toThrow()
    }
    expect(() => compactJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow()
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => compactJson(cyclic)).toThrow()
  })
})

describe('compact JSON expansion rejects malformed documents', () => {
  it('accepts a minimal well-formed document (control)', () => {
    expect(expandJson(doc(['a', 1, [0, 0, 1]], [['k', 'v']]))).toEqual({ k: 'a', v: 1 })
  })

  const malformed: Array<[string, unknown]> = [
    ['an unknown encoding', { ...doc(['a']), encoding: 'other' }],
    ['a root outside the table', doc(['a'], [], 1)],
    ['a forward reference', doc([[-1, 1], 'a'], [], 0)],
    ['a self reference', doc([[-1, 0]])],
    ['a negative or fractional reference', doc(['a', [-1, 0.5]])],
    ['an unknown tag', doc(['a', [-3, 0]])],
    ['an object with too few values', doc(['a', [0, 0]], [['k', 'v']])],
    ['an object with too many values', doc(['a', [0, 0, 0, 0]], [['k', 'v']])],
    ['a shape with a duplicate key', doc(['a', [0, 0, 0]], [['k', 'k']])],
    ['a prototype key', doc(['a', [0, 0]], [['__proto__']])],
    ['a group that is not a tuple', doc(['a', 'b', [0, 0, 1]], [{ keys: ['k', 'v'], group: [0] }])],
    ['a group tuple of the wrong length', doc(['a', [-1, 0, 0], [0, 1, 0]], [{ keys: ['k', 'v'], group: [0] }])],
    ['an unordered group', doc(['a', [-1, 0, 0], [0, 1]], [{ keys: ['k', 'v'], group: [1, 0] }])],
    ['a join of a non-string', doc([1, 'a', [-2, 0, 1]])],
    ['a join of one segment', doc(['a', [-2, 0]])],
    ['a non-finite number', doc([Infinity])],
    ['an object entry', doc([{ k: 'v' }])],
    ['an empty composite', doc([[]])],
  ]
  for (const [name, value] of malformed) {
    it(`rejects ${name}`, () => expect(() => expandJson(value)).toThrow())
  }

  it('bounds the expanded size, so a shared subtree cannot expand without limit', () => {
    // Each level doubles the expansion: 40 levels would serialise to terabytes from 41 entries.
    const values: unknown[] = ['x']
    for (let level = 1; level <= 40; level += 1) values.push([-1, level - 1, level - 1])
    expect(() => expandJson(doc(values))).toThrow(/expanded/)
    // Control: a small expansion under an explicit limit passes, and one byte less is refused.
    const small = doc(values.slice(0, 4))
    const length = JSON.stringify(expandJson(small)).length
    expect(() => expandJson(small, { maxLength: length })).not.toThrow()
    expect(() => expandJson(small, { maxLength: length - 1 })).toThrow(/expanded/)
  })

  it('checks a join length before allocating it, per entry and across the document', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join')
    try {
      // One 1 KB string joined 2,000 times would allocate ~2 MB; with a 1 MB bound it must be refused
      // before Array.prototype.join runs on it.
      const refs = Array.from({ length: 2_000 }, () => 0)
      expect(() => expandJson(doc(['x'.repeat(1024), [-2, ...refs]]), { maxLength: 1024 * 1024 })).toThrow(/too large/)
      expect(joinSpy.mock.calls.some(([separator]) => separator === ':')).toBe(false)
      // Many joins, each under the bound, are refused once their total passes it.
      const many = ['x'.repeat(1024), ...Array.from({ length: 40 }, () => [-2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]
      expect(() => expandJson(doc(many), { maxLength: 1024 * 1024 })).toThrow(/too large/)
      // Control: the same join under a sufficient bound expands.
      expect(expandJson(doc(['ab', [-2, 0, 0, 0]]))).toBe('ab:ab:ab')
    } finally {
      joinSpy.mockRestore()
    }
  })

  it('caps the default expanded size at 64 MB', () => {
    expect(MAX_EXPANDED_JSON_LENGTH).toBe(64 * 1024 * 1024)
  })

  it('returns frozen shared nodes, so one occurrence cannot alter another', () => {
    const shared = { a: 1 }
    const expanded = expandJson(compactJson([shared, shared])) as Array<{ a: number }>
    expect(expanded[0]).toBe(expanded[1])
    expect(Object.isFrozen(expanded[0])).toBe(true)
    expect(() => { expanded[0].a = 2 }).toThrow()
  })

  it('lists every distinct string and key, joined strings included, without expanding', () => {
    const { strings, keys } = compactJsonTokens(compactJson({ id: 'report:meta:campaign', nested: [{ label: 'Spend' }], n: 1 }))
    expect([...strings].sort()).toEqual(['Spend', 'campaign', 'meta', 'report', 'report:meta:campaign'])
    expect([...keys].sort()).toEqual(['id', 'label', 'n', 'nested'])
  })

  it('types the encoding name into the document', () => {
    const compact: CompactJson = compactJson({ a: 1 })
    expect(compact.encoding).toBe('maxx_compact_json.v1')
  })
})
