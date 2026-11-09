// AI-slop / buzzwords that must not appear in ad copy. Matched case-insensitively. Dependency-free so
// client components (the Copy studio) and the server-only prompt modules read the same list.
export const BANNED_WORDS: readonly string[] = [
  'unlock', 'elevate', 'game-changer', 'game changer', 'supercharge', 'unleash', 'revolutionize',
  'revolutionary', 'seamless', 'seamlessly', 'cutting-edge', 'cutting edge', 'world-class',
  'best-in-class', 'synergy', 'leverage', 'empower', 'unparalleled', 'harness the',
  'take it to the next level', 'level up', 'look no further', 'the power of', 'delve',
  'tapestry', 'testament to', 'realm of', 'embark', "in today's world", 'transform your',
]
