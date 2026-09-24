/**
 * Offline tests for pulling the reel link out of what a share sheet hands us.
 * No device, no server, no bundler:
 *
 *   node --experimental-strip-types apps/mobile/src/share/extractUrl.smoke.ts
 */
import { extractSupportedUrl, isSupportedUrl } from './extractUrl.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

function expectUrl(label: string, shared: { webUrl?: string | null; text?: string | null }, want: string | null) {
  const got = extractSupportedUrl(shared)
  check(label, got === want, `got ${JSON.stringify(got)}${got === want ? '' : `, want ${JSON.stringify(want)}`}`)
}

console.log('\n\x1b[1mWHERE THE LINK ARRIVES\x1b[0m')

expectUrl('uses webUrl when the share library found it',
  { webUrl: 'https://www.instagram.com/reel/ABC123/', text: null },
  'https://www.instagram.com/reel/ABC123/')

expectUrl('finds a URL that is only inside the text',
  { webUrl: null, text: 'look at this https://www.youtube.com/watch?v=abc123XYZ wow' },
  'https://www.youtube.com/watch?v=abc123XYZ')

// The real shape of an Instagram share. The tracking param stays: the server
// normalises URLs, the phone doesn't guess.
expectUrl('Instagram share text keeps ?igsh',
  { text: 'Check out this reel https://www.instagram.com/reel/ABC/?igsh=xyz' },
  'https://www.instagram.com/reel/ABC/?igsh=xyz')

expectUrl('webUrl and text both present → webUrl, query intact',
  { webUrl: 'https://www.instagram.com/reel/ABC/?igsh=xyz', text: 'Check out this reel https://www.instagram.com/reel/ABC/?igsh=xyz' },
  'https://www.instagram.com/reel/ABC/?igsh=xyz')

console.log('\n\x1b[1mSUPPORTED PLATFORMS\x1b[0m')

expectUrl('youtu.be short link', { text: 'https://youtu.be/dQw4w9WgXcQ?si=abc' }, 'https://youtu.be/dQw4w9WgXcQ?si=abc')
expectUrl('YouTube Shorts', { webUrl: 'https://youtube.com/shorts/abc123def?feature=share' }, 'https://youtube.com/shorts/abc123def?feature=share')
expectUrl('mobile YouTube (m.)', { text: 'https://m.youtube.com/watch?v=abc123XYZ' }, 'https://m.youtube.com/watch?v=abc123XYZ')
expectUrl('TikTok video', { text: 'https://www.tiktok.com/@someone/video/7312345678901234567?_r=1' }, 'https://www.tiktok.com/@someone/video/7312345678901234567?_r=1')
expectUrl('TikTok vm. short link', { text: 'Watch this https://vm.tiktok.com/ZMabc123/' }, 'https://vm.tiktok.com/ZMabc123/')
expectUrl('Instagram post (/p/)', { text: 'https://instagram.com/p/XYZ789/' }, 'https://instagram.com/p/XYZ789/')

console.log('\n\x1b[1mNOTHING USABLE → null\x1b[0m')

expectUrl('text with no URL', { text: 'you have to go to Bali this summer' }, null)
expectUrl('unsupported URL (example.com)', { webUrl: 'https://example.com/reel/ABC', text: 'https://example.com/reel/ABC' }, null)
expectUrl('empty share', { webUrl: null, text: null }, null)
expectUrl('blank strings', { webUrl: '  ', text: '' }, null)
// A lookalike host must not pass just because it contains the name.
expectUrl('lookalike host instagram.com.evil.example', { text: 'https://instagram.com.evil.example/reel/x' }, null)
expectUrl('lookalike host notinstagram.com', { text: 'https://notinstagram.com/reel/x' }, null)
expectUrl('supported name only in the path', { text: 'https://example.com/?next=youtube.com/watch' }, null)

console.log('\n\x1b[1mMESSY TEXT\x1b[0m')

expectUrl('several URLs → the first SUPPORTED one',
  { text: 'see https://example.com/x then https://www.instagram.com/p/XYZ/ and https://youtu.be/abc12345' },
  'https://www.instagram.com/p/XYZ/')

// expo-share-intent sets webUrl to the first link in the text, whatever it is.
expectUrl('unsupported webUrl but a supported link in text',
  { webUrl: 'https://linktr.ee/someone', text: 'https://linktr.ee/someone https://www.tiktok.com/@a/video/123' },
  'https://www.tiktok.com/@a/video/123')

expectUrl('strips wrapping punctuation, not the query',
  { text: 'this one (https://youtu.be/abc12345?t=42).' },
  'https://youtu.be/abc12345?t=42')

expectUrl('link glued to a word', { text: 'Watch:https://youtu.be/abc12345' }, 'https://youtu.be/abc12345')
expectUrl('link on its own line', { text: 'Bali guide\nhttps://www.instagram.com/reel/DEF/\n#bali' }, 'https://www.instagram.com/reel/DEF/')
expectUrl('typed without a scheme', { text: 'instagram.com/reel/ABC' }, 'https://instagram.com/reel/ABC')
expectUrl('typed with www. and no scheme', { text: 'www.youtube.com/shorts/abc123def' }, 'https://www.youtube.com/shorts/abc123def')

console.log('\n\x1b[1misSupportedUrl\x1b[0m')
check('http (not https) is accepted', isSupportedUrl('http://youtu.be/abc'))
check('upper-case host is accepted', isSupportedUrl('https://WWW.INSTAGRAM.COM/reel/A/'))
check('a non-URL is rejected', !isSupportedUrl('instagram'))
check('ftp is rejected', !isSupportedUrl('ftp://instagram.com/x'))

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
