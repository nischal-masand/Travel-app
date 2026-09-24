/**
 * One reel, one capture — however it was shared.
 *
 *   npm run smoke:urls -w @reel/server
 */
import { mediaRef } from './lib/urls.ts'
import { captureIdFor } from './lib/workdir.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}
const same = (...urls: string[]) => new Set(urls.map(captureIdFor)).size === 1

console.log('\n\x1b[1mINSTAGRAM\x1b[0m')
// These are the actual shapes that arrived from real shares.
check('two shares of one reel with different ?igsh= are one capture', same(
  'https://www.instagram.com/reel/DXaPSaMEt1s/?igsh=MWQ1ZGUxMzBkMA==',
  'https://www.instagram.com/reel/DXaPSaMEt1s/?igsh=ZmFrZWZha2U=',
))
check('the username-prefixed form is the same reel', same(
  'https://www.instagram.com/johnmarcoasks/reel/DXaPSaMEt1s/',
  'https://www.instagram.com/reel/DXaPSaMEt1s/',
))
check('/reels/ and /reel/ are the same reel', same(
  'https://www.instagram.com/reels/DXaPSaMEt1s/', 'https://instagram.com/reel/DXaPSaMEt1s',
))
check('/p/ and /reel/ with one shortcode are one media item', same(
  'https://www.instagram.com/p/DcMNSOlHGyZ/', 'https://www.instagram.com/reel/DcMNSOlHGyZ/',
))
check('different shortcodes stay different captures',
  !same('https://www.instagram.com/reel/AAA111/', 'https://www.instagram.com/reel/BBB222/'))

// The KEY ignores /p/ vs /reel/, but the URL handed to the resolver must not
// turn a carousel into a /reel/ link it was never shared as.
check('a carousel keeps its /p/ URL for the resolver',
  mediaRef('https://www.instagram.com/internetdept/p/DcMNSOlHGyZ/?img_index=2').url
    === 'https://www.instagram.com/p/DcMNSOlHGyZ/',
  mediaRef('https://www.instagram.com/internetdept/p/DcMNSOlHGyZ/?img_index=2').url)
check('the resolver URL drops tracking and the username',
  mediaRef('https://www.instagram.com/notshivam/reel/Da8lEYhxWpp/?igsh=x').url
    === 'https://www.instagram.com/reel/Da8lEYhxWpp/')

console.log('\n\x1b[1mYOUTUBE\x1b[0m')
check('watch?v=, youtu.be and the mobile site are one video', same(
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'https://youtu.be/jNQXAC9IVRw?si=tracking',
  'https://m.youtube.com/watch?v=jNQXAC9IVRw&feature=share',
  'https://www.youtube.com/watch?feature=share&v=jNQXAC9IVRw',
))
check('a Short keeps its /shorts/ URL', mediaRef('https://youtube.com/shorts/abcDEF12345?si=x').url
  === 'https://www.youtube.com/shorts/abcDEF12345')
check('a Short and a watch link for one id are one video', same(
  'https://youtube.com/shorts/abcDEF12345', 'https://www.youtube.com/watch?v=abcDEF12345',
))

console.log('\n\x1b[1mTIKTOK AND THE REST\x1b[0m')
check('a TikTok video with tracking params is one capture', same(
  'https://www.tiktok.com/@someone/video/7234567890123456789?is_from_webapp=1&sender_device=pc',
  'https://www.tiktok.com/@someone/video/7234567890123456789',
))
// A vm.tiktok.com short link only resolves by following its redirect, so it
// cannot be matched to its long form here — but tracking still comes off.
check('an unrecognised link still loses its query string', same(
  'https://vm.tiktok.com/ZMabc123/?utm_source=copy', 'https://vm.tiktok.com/ZMabc123/',
))
check('garbage input does not throw', typeof captureIdFor('not a url at all') === 'string')

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
