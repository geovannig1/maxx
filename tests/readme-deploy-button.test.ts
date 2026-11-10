import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ENV_VARS } from '@/config/env'

// the README's "Deploy to Vercel" button prompts for exactly the variables a deployment needs:
// every schema variable required always, in production, or before the dashboard shows data.

const README = readFileSync(path.resolve(__dirname, '../README.md'), 'utf8')

function deployButtonUrl(markdown: string): URL | null {
  const match = /\[!\[Deploy with Vercel\]\(https:\/\/vercel\.com\/button\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)\s]+)\)/.exec(markdown)
  return match ? new URL(match[1]) : null
}

describe('README Deploy to Vercel button', () => {
  it('control: a README without the button is detected', () => {
    expect(deployButtonUrl('# Maxx\n')).toBeNull()
  })

  it('uses the documented clone URL and asks for every required variable, and only those', () => {
    const url = deployButtonUrl(README)
    expect(url, 'README must contain the Deploy with Vercel button').not.toBeNull()
    expect(url!.origin + url!.pathname).toBe('https://vercel.com/new/clone')
    expect(url!.searchParams.get('repository-url')).toBe('https://github.com/geovannig1/maxx-ai-media-buyer')
    const required = ENV_VARS.filter((s) => ['required', 'production', 'dashboard'].includes(s.required.kind)).map((s) => s.name)
    expect(url!.searchParams.get('env')?.split(',')).toEqual(required)
    expect(url!.searchParams.get('envLink')).toBe('https://github.com/geovannig1/maxx-ai-media-buyer/blob/main/docs/configuration.md')
  })
})
