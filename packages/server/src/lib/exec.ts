import { spawn } from 'node:child_process'

export class ExecError extends Error {
  // Written out longhand rather than as constructor parameter properties:
  // node --experimental-strip-types removes types without rewriting code, so
  // parameter properties (which need real codegen) are a hard parse error.
  readonly cmd: string
  readonly code: number | null
  readonly stderr: string

  constructor(cmd: string, code: number | null, stderr: string) {
    super(`${cmd} exited ${code}\n${stderr.trim().split('\n').slice(-12).join('\n')}`)
    this.name = 'ExecError'
    this.cmd = cmd
    this.code = code
    this.stderr = stderr
  }
}

/** Run a binary and capture stdout. Throws ExecError with the tail of stderr. */
export function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => reject(new Error(`Cannot run "${cmd}": ${e.message}. Is it installed and on PATH?`)))
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new ExecError(cmd, code, err))))
  })
}

export const ffmpeg = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
export const ffprobe = (args: string[]) => run('ffprobe', ['-hide_banner', '-loglevel', 'error', ...args])
export const ytdlp = (args: string[]) => run('yt-dlp', args)
