/** Native dimension tuples; callers remove query strings before constructing public page rows. */
export function websiteRowKey(row: { landingPage: string; device: string; channel: string }): string {
  return JSON.stringify([row.landingPage, row.device, row.channel])
}
export function websiteEventKey(row: { name: string; device: string; channel: string }): string {
  return JSON.stringify([row.name, row.device, row.channel])
}
export function websiteRowAnchor(row: Parameters<typeof websiteRowKey>[0]): string {
  return `website-row-${anchorToken(websiteRowKey(row))}`
}
export function websiteEventAnchor(row: Parameters<typeof websiteEventKey>[0]): string {
  return `website-event-${anchorToken(websiteEventKey(row))}`
}
// Fixed-width UTF-16 hex is collision-free and survives native fragment decoding unchanged.
function anchorToken(key: string): string {
  return key.split('').map(unit => unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')
}
