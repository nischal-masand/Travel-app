import { instagramResolver } from './instagram.ts'
import { ytdlpResolver } from './ytdlp.ts'
import type { Resolver } from './types.ts'

const resolvers: Resolver[] = [instagramResolver, ytdlpResolver]

export function resolverFor(url: string): Resolver {
  const r = resolvers.find((x) => x.matches(url))
  if (!r) throw new Error(`No resolver handles ${url}. Supported: Instagram, YouTube, YouTube Shorts, TikTok.`)
  return r
}

export * from './types.ts'
