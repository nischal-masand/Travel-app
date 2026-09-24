import type {
  ApiCaptureDetail, ApiCaptureSummary, ApiError, ApiMapPlace, ApiPlace, ApiTrayItem,
  CreateCaptureResponse,
} from '@reel/shared'
import { API_URL } from './config'

/**
 * Typed client for the reel-trip server. Every screen goes through this file;
 * none of them should call fetch directly.
 *
 * Types are imported with `import type` only, so @reel/shared (and zod behind
 * it) never enters the app bundle — the contract is checked at compile time and
 * costs nothing at run time.
 */

export class ApiRequestError extends Error {
  readonly status: number
  readonly detail: string | undefined

  constructor(status: number, body: Partial<ApiError> | null, fallback: string) {
    super(body?.error ?? fallback)
    this.name = 'ApiRequestError'
    this.status = status
    this.detail = body?.detail
  }
}

/** Thrown when the server can't be reached at all — distinct from it saying no. */
export class ServerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Can't reach the server at ${API_URL}. Is it running (npm run api -w @reel/server), and is this device on the same network?`)
    this.name = 'ServerUnreachableError'
    this.cause = cause
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new ServerUnreachableError(err)
  }

  if (res.status === 204) return undefined as T
  const text = await res.text()
  const json = text ? safeJson(text) : null
  if (!res.ok) throw new ApiRequestError(res.status, json as Partial<ApiError> | null, `HTTP ${res.status}`)
  return json as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 200) }
  }
}

export const api = {
  /** Share a link. Returns immediately; poll getCapture for progress. */
  createCapture: (url: string) =>
    request<CreateCaptureResponse>('POST', '/captures', { url }),

  listCaptures: () =>
    request<{ captures: ApiCaptureSummary[] }>('GET', '/captures').then((r) => r.captures),

  getCapture: (id: string) =>
    request<ApiCaptureDetail>('GET', `/captures/${encodeURIComponent(id)}`),

  deleteCapture: (id: string) =>
    request<void>('DELETE', `/captures/${encodeURIComponent(id)}`),

  /** The tray: every place the pipeline would not vouch for on its own. */
  listNeedsCheck: () =>
    request<{ places: ApiTrayItem[] }>('GET', '/needs-check').then((r) => r.places),

  listMapPlaces: () =>
    request<{ places: ApiMapPlace[] }>('GET', '/map').then((r) => r.places),

  confirmPlace: (id: string) =>
    request<ApiPlace>('POST', `/places/${encodeURIComponent(id)}/confirm`),

  dismissPlace: (id: string) =>
    request<ApiPlace>('POST', `/places/${encodeURIComponent(id)}/dismiss`),

  /** 422 when Google finds nothing for the name — show that to the user as-is. */
  correctPlace: (id: string, name: string) =>
    request<ApiPlace>('POST', `/places/${encodeURIComponent(id)}/correct`, { name }),
}

/**
 * URLs for the evidence cut from the stored video. Plain URLs rather than
 * fetches, because <Image> and the audio player load them directly — and the
 * server marks them immutable, so each second is downloaded once.
 */
export const evidence = {
  frameUrl: (captureId: string, atSeconds: number) =>
    `${API_URL}/captures/${encodeURIComponent(captureId)}/frame?at=${atSeconds.toFixed(2)}`,
  clipUrl: (captureId: string, atSeconds: number) =>
    `${API_URL}/captures/${encodeURIComponent(captureId)}/clip?at=${atSeconds.toFixed(2)}`,
}
