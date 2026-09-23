function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`)
  return v
}

export const env = {
  get groqKey() { return req('GROQ_API_KEY') },
  get geminiKey() { return req('GEMINI_API_KEY') },
  get apifyToken() { return req('APIFY_TOKEN') },
  get apifyActor() { return process.env.APIFY_INSTAGRAM_ACTOR || 'apify~instagram-scraper' },
  get googleMapsKey() { return req('GOOGLE_MAPS_API_KEY') },
  workDir: process.env.WORK_DIR || '.work',
}

/** Non-throwing check, so the CLI can report everything missing at once. */
export function missingKeys(names: string[]): string[] {
  return names.filter((n) => !process.env[n])
}
