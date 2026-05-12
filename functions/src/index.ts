import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret, defineString } from 'firebase-functions/params'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import crypto from 'node:crypto'

initializeApp()

// Structured recommendation types
export type WorkoutOption = {
  title: string
  duration: string
  intensity: string
  mainSet: string
  why: string[]
  type?: string
}

export type RecommendationResponse = {
  options: WorkoutOption[]
  safetyChecks: string[]
}

type RecommendationPreferences = {
  acceptedCount: number
  passedCount: number
  byType: { accepted: Record<string, number>; passed: Record<string, number> }
  byIntensity: { accepted: Record<string, number>; passed: Record<string, number> }
  byDuration: { accepted: Record<string, number>; passed: Record<string, number> }
}

const db = getFirestore()

const geminiApiKey = defineSecret('GEMINI_API_KEY')

const stravaClientId = defineSecret('STRAVA_CLIENT_ID')
const stravaClientSecret = defineSecret('STRAVA_CLIENT_SECRET')
const stravaStateSecret = defineSecret('STRAVA_STATE_SECRET')
const appBaseUrl = defineString('APP_BASE_URL', { default: '' })

function formatDateContext(ctx: { nowIsoUtc: string; dateUtc: string; dayOfWeekUtc: string }): string {
  return `Today is ${ctx.dayOfWeekUtc}, ${ctx.dateUtc} (UTC).`
}

function formatWorkoutsAsText(workouts: RecommendationWorkoutContext[]): string {
  if (workouts.length === 0) return '(no recent workouts)'
  return workouts
    .map((w, i) => {
      const label = w.sportType || w.type || 'Workout'
      const name = w.name ? ` "${w.name}"` : ''
      const when =
        w.workoutDateUtc && w.dayOfWeekUtc && w.daysAgo !== null
          ? ` — ${w.dayOfWeekUtc} ${w.workoutDateUtc} (${w.daysAgo === 0 ? 'today' : `${w.daysAgo}d ago`})`
          : ''
      const parts: string[] = []
      if (w.distance !== null) parts.push(`${(w.distance / 1000).toFixed(1)}km`)
      if (w.elapsedTime !== null) parts.push(`${Math.round(w.elapsedTime / 60)}min`)
      if (w.elevationGain !== null) parts.push(`+${w.elevationGain}m elev`)
      if (w.avgHR !== null) {
        const hrStr = w.maxHR !== null ? `HR ${w.avgHR}/${w.maxHR} avg/max` : `HR avg ${w.avgHR}`
        parts.push(hrStr)
      }
      if (w.avgPower !== null) parts.push(`Power avg ${w.avgPower}W`)
      if (w.weightedAvgPower !== null) parts.push(`NP ${w.weightedAvgPower}W`)
      if (w.calories !== null) parts.push(`${w.calories}kcal`)
      if (w.sufferScore !== null) parts.push(`suffer ${w.sufferScore}`)
      if (w.trainer) parts.push('indoor')
      const metrics = parts.length ? `\n   ${parts.join(' | ')}` : ''
      const tags = w.contextTags && w.contextTags.length ? ` [${w.contextTags.join(', ')}]` : ''
      const notes = w.contextText ? `\n   Notes: "${w.contextText}"${tags}` : ''
      return `${i + 1}. ${label}${name}${when}${metrics}${notes}`
    })
    .join('\n')
}

function requireGeminiKey(): string {
  const apiKey = geminiApiKey.value() || process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new HttpsError(
      'failed-precondition',
      'Missing GEMINI_API_KEY. Set it with: firebase functions:secrets:set GEMINI_API_KEY',
    )
  }
  return apiKey
}

function readContextTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const trimmed = value.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    const tag = trimmed.slice(0, 24)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags.length ? tags.slice(0, 6) : null
}

function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

function parsePreferenceMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = value
  }
  return out
}

function parseRecommendationPreferences(raw: unknown): RecommendationPreferences {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const byTypeRaw = input.byType && typeof input.byType === 'object' ? (input.byType as Record<string, unknown>) : {}
  const byIntensityRaw =
    input.byIntensity && typeof input.byIntensity === 'object'
      ? (input.byIntensity as Record<string, unknown>)
      : {}
  const byDurationRaw =
    input.byDuration && typeof input.byDuration === 'object' ? (input.byDuration as Record<string, unknown>) : {}

  return {
    acceptedCount: typeof input.acceptedCount === 'number' ? input.acceptedCount : 0,
    passedCount: typeof input.passedCount === 'number' ? input.passedCount : 0,
    byType: {
      accepted: parsePreferenceMap(byTypeRaw.accepted),
      passed: parsePreferenceMap(byTypeRaw.passed),
    },
    byIntensity: {
      accepted: parsePreferenceMap(byIntensityRaw.accepted),
      passed: parsePreferenceMap(byIntensityRaw.passed),
    },
    byDuration: {
      accepted: parsePreferenceMap(byDurationRaw.accepted),
      passed: parsePreferenceMap(byDurationRaw.passed),
    },
  }
}

function normalizePreferenceKey(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '_')
  return normalized || 'unknown'
}

function incrementCounter(map: Record<string, number>, key: string): Record<string, number> {
  return {
    ...map,
    [key]: (map[key] ?? 0) + 1,
  }
}

function parseDurationToMinutes(duration: string): number | null {
  const text = duration.toLowerCase()
  let minutes = 0

  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/)
  if (hourMatch?.[1]) {
    const hours = Number(hourMatch[1])
    if (Number.isFinite(hours) && hours > 0) {
      minutes += Math.round(hours * 60)
    }
  }

  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)\b/)
  if (minuteMatch?.[1]) {
    const directMinutes = Number(minuteMatch[1])
    if (Number.isFinite(directMinutes) && directMinutes > 0) {
      minutes += Math.round(directMinutes)
    }
  }

  if (minutes > 0) return minutes

  const genericMatch = text.match(/\d+/)
  if (!genericMatch) return null
  const fallbackMinutes = Number(genericMatch[0])
  if (!Number.isFinite(fallbackMinutes) || fallbackMinutes <= 0) return null
  return fallbackMinutes
}

function durationBucket(minutes: number | null): string {
  if (!minutes) return 'unknown'
  if (minutes <= 30) return 'short'
  if (minutes <= 60) return 'medium'
  return 'long'
}

function intensityBucket(intensity: string): string {
  const lower = intensity.toLowerCase()
  if (/\b(1|2|3|4)\b/.test(lower) || lower.includes('easy') || lower.includes('low')) return 'easy'
  if (/\b(5|6|7)\b/.test(lower) || lower.includes('moderate')) return 'moderate'
  if (/\b(8|9|10)\b/.test(lower) || lower.includes('hard') || lower.includes('high')) return 'hard'
  return 'unknown'
}

function summarizeTopCategory(map: Record<string, number>): string | null {
  const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return null
  const top = sorted[0]
  if (!top) return null
  return `${top[0]} (${top[1]})`
}

function buildPreferenceSummary(preferences: RecommendationPreferences): string {
  const typeTop = summarizeTopCategory(preferences.byType.accepted)
  const intensityTop = summarizeTopCategory(preferences.byIntensity.accepted)
  const durationTop = summarizeTopCategory(preferences.byDuration.accepted)
  const lines = [
    `Accepted ${preferences.acceptedCount}, passed ${preferences.passedCount} recommended workouts.`,
    typeTop ? `Most accepted workout type: ${typeTop}.` : null,
    intensityTop ? `Preferred intensity profile: ${intensityTop}.` : null,
    durationTop ? `Preferred duration bucket: ${durationTop}.` : null,
  ].filter(Boolean)
  return lines.join(' ')
}

function normalizeWorkoutOption(raw: unknown): WorkoutOption {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const whyRaw = Array.isArray(data.why) ? data.why : []
  return {
    title: sanitizeText(data.title, 80),
    duration: sanitizeText(data.duration, 40),
    intensity: sanitizeText(data.intensity, 50),
    mainSet: sanitizeText(data.mainSet, 220),
    why: whyRaw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeText(item, 140))
      .filter(Boolean)
      .slice(0, 4),
    type: sanitizeText(data.type, 40) || undefined,
  }
}

function defaultWebBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT
  if (!projectId) return 'http://localhost:5173'
  return `https://${projectId}.web.app`
}

function getWebBaseUrl(): string {
  const fromParam = (appBaseUrl.value() || '').trim()
  if (fromParam) return fromParam.replace(/\/$/, '')
  return defaultWebBaseUrl().replace(/\/$/, '')
}

function scopesContainRequired(scopeValue: string): boolean {
  const granted = new Set(
    scopeValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return granted.has('read') && granted.has('activity:read_all')
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url')
}

function signState(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

function makeState(uid: string, secret: string): string {
  const payload = {
    uid,
    iat: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
  }
  const payloadB64 = base64url(JSON.stringify(payload))
  const sig = signState(payloadB64, secret)
  return `${payloadB64}.${sig}`
}

function parseAndVerifyState(state: string, secret: string): { uid: string } {
  const [payloadB64, sig] = state.split('.')
  if (!payloadB64 || !sig) throw new Error('bad state')

  const expected = signState(payloadB64, secret)
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('bad signature')
  }

  const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8')
  const payload = JSON.parse(payloadStr) as { uid?: unknown; iat?: unknown }
  if (typeof payload.uid !== 'string') throw new Error('bad payload')
  if (typeof payload.iat !== 'number') throw new Error('bad payload')

  // 10 minute expiry
  if (Date.now() - payload.iat > 10 * 60 * 1000) throw new Error('state expired')

  return { uid: payload.uid }
}

export const geminiPrompt = onCall({ secrets: [geminiApiKey], invoker: 'public' }, async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to call Gemini')
  }

  const prompt = typeof req.data?.prompt === 'string' ? req.data.prompt : ''
  if (!prompt.trim()) {
    throw new HttpsError('invalid-argument', 'Missing prompt')
  }
  if (prompt.length > 4000) {
    throw new HttpsError('invalid-argument', 'Prompt too long')
  }

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  return { text }
})

export const stravaAuthUrl = onCall(
  { secrets: [stravaClientId, stravaStateSecret], cors: true, invoker: 'public' },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to connect Strava')
    }

    const clientId = stravaClientId.value()
    const secret = stravaStateSecret.value()

    if (!clientId) {
      throw new HttpsError('failed-precondition', 'Missing STRAVA_CLIENT_ID secret')
    }
    if (!secret) {
      throw new HttpsError('failed-precondition', 'Missing STRAVA_STATE_SECRET secret')
    }

    const state = makeState(req.auth.uid, secret)
    const redirectUri = `${getWebBaseUrl()}/api/strava/callback`

    const url = new URL('https://www.strava.com/oauth/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('approval_prompt', 'auto')
    url.searchParams.set('scope', 'read,activity:read_all')
    url.searchParams.set('state', state)

    return { url: url.toString() }
  },
)

export const stravaCallback = onRequest(
  { secrets: [stravaClientId, stravaClientSecret, stravaStateSecret] },
  async (req, res) => {
    try {
      const oauthError = typeof req.query.error === 'string' ? req.query.error : ''
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      const scope = typeof req.query.scope === 'string' ? req.query.scope : ''

      if (oauthError) {
        res.redirect(302, `${getWebBaseUrl()}/onboarding?strava=denied`)
        return
      }

      if (!code || !state) {
        res.redirect(302, `${getWebBaseUrl()}/onboarding?strava=callback_error`)
        return
      }

      const stateSecret = stravaStateSecret.value()
      if (!stateSecret) {
        res.status(500).send('Missing STRAVA_STATE_SECRET secret')
        return
      }
      const { uid } = parseAndVerifyState(state, stateSecret)

      if (!scope || !scopesContainRequired(scope)) {
        res.redirect(302, `${getWebBaseUrl()}/onboarding?strava=scope_missing`)
        return
      }

      const clientId = (stravaClientId.value() || '').trim()
      const clientSecret = (stravaClientSecret.value() || '').trim()
      if (!clientId || !clientSecret) {
        res.status(500).send('Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET secret')
        return
      }

      const tokenResp = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
        }).toString(),
      })

      if (!tokenResp.ok) {
        const body = await tokenResp.text().catch(() => '')
        res.status(500).send(`Strava token exchange failed: ${tokenResp.status} ${body}`)
        return
      }

      const tokenJson = (await tokenResp.json()) as {
        access_token: string
        refresh_token: string
        expires_at: number
        athlete?: { id?: number }
      }

      const athleteId = typeof tokenJson.athlete?.id === 'number' ? tokenJson.athlete.id : null

      const privateRef = db.doc(`users/${uid}/private/strava`)
      await privateRef.set(
        {
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token,
          expiresAt: tokenJson.expires_at,
          athleteId,
          scope,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )

      const stravaProfile: Record<string, unknown> = {
        connected: true,
        lastSyncAt: null,
      }
      if (athleteId !== null) {
        stravaProfile.athleteId = athleteId
      }

      await db.doc(`users/${uid}`).set(
        { strava: stravaProfile, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )

      res.redirect(302, `${getWebBaseUrl()}/onboarding?strava=connected`)
    } catch (e) {
      res.status(500).send(`Callback error: ${(e as Error).message}`)
    }
  },
)

async function getStravaAccessToken(uid: string): Promise<string> {
  const ref = db.doc(`users/${uid}/private/strava`)
  const snap = await ref.get()
  const data = snap.data() as
    | {
        accessToken?: unknown
        refreshToken?: unknown
        expiresAt?: unknown
      }
    | undefined

  if (!data) throw new HttpsError('failed-precondition', 'Strava not connected')

  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
  const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken : ''
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0

  if (!refreshToken) throw new HttpsError('failed-precondition', 'Missing Strava refresh token')

  // refresh if expiring soon
  if (Date.now() / 1000 < expiresAt - 60 && accessToken) return accessToken

  const clientId = (stravaClientId.value() || '').trim()
  const clientSecret = (stravaClientSecret.value() || '').trim()
  if (!clientId || !clientSecret) {
    throw new HttpsError(
      'failed-precondition',
      'Missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET. Set them with firebase functions:secrets:set … then redeploy functions.',
    )
  }

  const resp = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new HttpsError('unavailable', 'Strava token refresh failed', {
      status: resp.status,
      body,
      step: 'token_refresh',
    })
  }

  const json = (await resp.json()) as {
    access_token: string
    refresh_token: string
    expires_at: number
  }

  await ref.set(
    {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_at,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return json.access_token
}

async function buildFitnessPersonaText(uid: string): Promise<string> {
  const userSnap = await db.doc(`users/${uid}`).get()
  const userData = (userSnap.data() ?? {}) as { goalText?: unknown; fitnessPersonaText?: unknown }
  const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''
  const previousPersona = typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''

  const workoutsSnap = await db
    .collection(`users/${uid}/workouts`)
    .orderBy('strava.startDate', 'desc')
    .limit(50)
    .get()

  const workouts = workoutsSnap.docs.map((d) => {
    // Mapping Strava workout data
    const data = (d.data() ?? {}) as {
      strava?: Record<string, unknown>
      context?: { text?: unknown; tags?: unknown }
    }

    return {
      type: typeof data.strava?.type === 'string' ? data.strava.type : null,
      sportType: typeof data.strava?.sportType === 'string' ? data.strava.sportType : null,
      name: typeof data.strava?.name === 'string' ? data.strava.name : null,
      startDate: typeof data.strava?.startDate === 'string' ? data.strava.startDate : null,
      distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
      elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
      movingTime: typeof data.strava?.movingTime === 'number' ? data.strava.movingTime : null,
      elevationGain: typeof data.strava?.elevationGain === 'number' ? data.strava.elevationGain : null,
      avgSpeed: typeof data.strava?.avgSpeed === 'number' ? data.strava.avgSpeed : null,
      maxSpeed: typeof data.strava?.maxSpeed === 'number' ? data.strava.maxSpeed : null,
      avgCadence: typeof data.strava?.avgCadence === 'number' ? data.strava.avgCadence : null,
      avgHR: typeof data.strava?.avgHR === 'number' ? data.strava.avgHR : null,
      maxHR: typeof data.strava?.maxHR === 'number' ? data.strava.maxHR : null,
      avgPower: typeof data.strava?.avgPower === 'number' ? data.strava.avgPower : null,
      weightedAvgPower: typeof data.strava?.weightedAvgPower === 'number' ? data.strava.weightedAvgPower : null,
      kilojoules: typeof data.strava?.kilojoules === 'number' ? data.strava.kilojoules : null,
      sufferScore: typeof data.strava?.sufferScore === 'number' ? data.strava.sufferScore : null,
      trainer: typeof data.strava?.trainer === 'boolean' ? data.strava.trainer : null,
      manual: typeof data.strava?.manual === 'boolean' ? data.strava.manual : null,
      deviceName: typeof data.strava?.deviceName === 'string' ? data.strava.deviceName : null,
      contextText: typeof data.context?.text === 'string' ? data.context.text : null,
      contextTags: readContextTags(data.context?.tags),
    }
  })

  // Compute patterns by modality
  const patterns = computeWorkoutPatterns(workouts)

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

  const prompt =
    `You are Flux, a calm personal trainer evolving a user's fitness persona.\n` +
    `Your goal is to INCREMENTALLY UPDATE, APPEND, and OVERRIDE the existing persona based on new data.\n` +
    `Keep output under 200 words. Be concrete, specific, and actionable.\n\n` +
    `PREVIOUS PERSONA (to be updated/refined):\n${previousPersona || '(no previous persona)'}\n\n` +
    `NEW CONTEXT:\n` +
    `- Goal: ${goalText || '(not set)'}\n` +
    `- Recent patterns: ${patterns}\n` +
    `- Recent workouts (JSON): ${JSON.stringify(workouts.slice(0, 10), null, 2)}\n\n` +
    `INSTRUCTIONS:\n` +
    `1. Maintain long-term insights from the previous persona that are still relevant.\n` +
    `2. Override sections if new data shows a shift in behavior, modality, or fatigue levels.\n` +
    `3. Append new observations from recent notes (contextText/contextTags) or trends.\n` +
    `4. Output three sections (Athlete Profile, Constraints & Risks, Next 14 Days Focus).\n\n` +
    `Output the final updated persona.`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

function computeWorkoutPatterns(workouts: Array<Record<string, unknown>>): string {
  const byType: Record<string, { count: number; totalTime: number; totalDist: number; avgPower: number[]; avgHR: number[]; sufferScores: number[] }> = {}

  for (const w of workouts) {
    const type = (w.type as string | null) || (w.sportType as string | null) || 'Unknown'
    if (!byType[type]) {
      byType[type] = { count: 0, totalTime: 0, totalDist: 0, avgPower: [], avgHR: [], sufferScores: [] }
    }

    byType[type].count++
    byType[type].totalTime += (w.movingTime as number | null) || 0
    byType[type].totalDist += ((w.distance as number | null) || 0) / 1000 // convert to km

    if (typeof w.avgPower === 'number' && w.avgPower > 0) byType[type].avgPower.push(w.avgPower as number)
    if (typeof w.avgHR === 'number' && w.avgHR > 0) byType[type].avgHR.push(w.avgHR as number)
    if (typeof w.sufferScore === 'number' && w.sufferScore > 0) byType[type].sufferScores.push(w.sufferScore as number)
  }

  const lines: string[] = []
  for (const [type, stats] of Object.entries(byType).sort((a, b) => b[1].count - a[1].count)) {
    const avgTime = Math.round(stats.totalTime / stats.count / 60)
    const avgDist = (stats.totalDist / stats.count).toFixed(1)
    const avgPwr = stats.avgPower.length > 0 ? Math.round(stats.avgPower.reduce((a, b) => a + b) / stats.avgPower.length) : null
    const avgHR = stats.avgHR.length > 0 ? Math.round(stats.avgHR.reduce((a, b) => a + b) / stats.avgHR.length) : null
    const avgSufferScore = stats.sufferScores.length > 0 ? Math.round(stats.sufferScores.reduce((a, b) => a + b) / stats.sufferScores.length) : null

    const parts = [
      `${type}:`,
      `${stats.count}x`,
      `avg ${avgTime}min`,
      `${avgDist}km`,
      avgPwr ? `${avgPwr}W` : null,
      avgHR ? `${avgHR}bpm` : null,
      avgSufferScore ? `suffer ${avgSufferScore}` : null,
    ]
      .filter(Boolean)
      .join(' ')

    lines.push(parts)
  }

  return lines.join('\n')
}

type RecommendationWorkoutContext = {
  id: string
  type: string | null
  sportType: string | null
  name: string | null
  startDate: string | null
  workoutDateUtc: string | null
  dayOfWeekUtc: string | null
  daysAgo: number | null
  elapsedTime: number | null
  movingTime: number | null
  distance: number | null
  elevationGain: number | null
  avgSpeed: number | null
  maxSpeed: number | null
  avgCadence: number | null
  avgHR: number | null
  maxHR: number | null
  avgPower: number | null
  weightedAvgPower: number | null
  maxPower: number | null
  kilojoules: number | null
  calories: number | null
  sufferScore: number | null
  trainer: boolean | null
  commute: boolean | null
  manual: boolean | null
  private: boolean | null
  hasHeartrate: boolean | null
  deviceName: string | null
  contextText: string | null
  contextTags: string[] | null
}

type CurrentDateContext = {
  nowIsoUtc: string
  dateUtc: string
  dayOfWeekUtc: string
}

const dayNamesUtc = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function utcMidnightMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function workoutDateDetails(startDate: string | null, now: Date): {
  workoutDateUtc: string | null
  dayOfWeekUtc: string | null
  daysAgo: number | null
} {
  if (!startDate) {
    return { workoutDateUtc: null, dayOfWeekUtc: null, daysAgo: null }
  }
  const parsed = new Date(startDate)
  if (Number.isNaN(parsed.getTime())) {
    return { workoutDateUtc: null, dayOfWeekUtc: null, daysAgo: null }
  }
  const msInDay = 24 * 60 * 60 * 1000
  const daysAgo = Math.max(0, Math.floor((utcMidnightMs(now) - utcMidnightMs(parsed)) / msInDay))
  return {
    workoutDateUtc: parsed.toISOString().slice(0, 10),
    dayOfWeekUtc: dayNamesUtc[parsed.getUTCDay()],
    daysAgo,
  }
}

async function getRecentRecommendationContext(uid: string): Promise<{
  currentDateContext: CurrentDateContext
  workouts: RecommendationWorkoutContext[]
  contextCount: number
}> {
  const now = new Date()
  const workoutsSnap = await db
    .collection(`users/${uid}/workouts`)
    .orderBy('strava.startDate', 'desc')
    .limit(10)
    .get()

  const workouts = workoutsSnap.docs.map((d) => {
    const data = (d.data() ?? {}) as {
      strava?: {
        type?: unknown
        sportType?: unknown
        name?: unknown
        startDate?: unknown
        distance?: unknown
        elapsedTime?: unknown
        movingTime?: unknown
        elevationGain?: unknown
        avgSpeed?: unknown
        maxSpeed?: unknown
        avgCadence?: unknown
        avgHR?: unknown
        maxHR?: unknown
        avgPower?: unknown
        weightedAvgPower?: unknown
        maxPower?: unknown
        kilojoules?: unknown
        calories?: unknown
        sufferScore?: unknown
        trainer?: unknown
        commute?: unknown
        manual?: unknown
        private?: unknown
        hasHeartrate?: unknown
        deviceName?: unknown
      }
      context?: { text?: unknown; tags?: unknown }
    }

    const startDate = typeof data.strava?.startDate === 'string' ? data.strava.startDate : null
    const dateDetails = workoutDateDetails(startDate, now)

    return {
      id: d.id,
      type: typeof data.strava?.type === 'string' ? data.strava.type : null,
      sportType: typeof data.strava?.sportType === 'string' ? data.strava.sportType : null,
      name: typeof data.strava?.name === 'string' ? data.strava.name : null,
      startDate,
      workoutDateUtc: dateDetails.workoutDateUtc,
      dayOfWeekUtc: dateDetails.dayOfWeekUtc,
      daysAgo: dateDetails.daysAgo,
      distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
      elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
      movingTime: typeof data.strava?.movingTime === 'number' ? data.strava.movingTime : null,
      elevationGain: typeof data.strava?.elevationGain === 'number' ? data.strava.elevationGain : null,
      avgSpeed: typeof data.strava?.avgSpeed === 'number' ? data.strava.avgSpeed : null,
      maxSpeed: typeof data.strava?.maxSpeed === 'number' ? data.strava.maxSpeed : null,
      avgCadence: typeof data.strava?.avgCadence === 'number' ? data.strava.avgCadence : null,
      avgHR: typeof data.strava?.avgHR === 'number' ? data.strava.avgHR : null,
      maxHR: typeof data.strava?.maxHR === 'number' ? data.strava.maxHR : null,
      avgPower: typeof data.strava?.avgPower === 'number' ? data.strava.avgPower : null,
      weightedAvgPower: typeof data.strava?.weightedAvgPower === 'number' ? data.strava.weightedAvgPower : null,
      maxPower: typeof data.strava?.maxPower === 'number' ? data.strava.maxPower : null,
      kilojoules: typeof data.strava?.kilojoules === 'number' ? data.strava.kilojoules : null,
      calories: typeof data.strava?.calories === 'number' ? data.strava.calories : null,
      sufferScore: typeof data.strava?.sufferScore === 'number' ? data.strava.sufferScore : null,
      trainer: typeof data.strava?.trainer === 'boolean' ? data.strava.trainer : null,
      commute: typeof data.strava?.commute === 'boolean' ? data.strava.commute : null,
      manual: typeof data.strava?.manual === 'boolean' ? data.strava.manual : null,
      private: typeof data.strava?.private === 'boolean' ? data.strava.private : null,
      hasHeartrate: typeof data.strava?.hasHeartrate === 'boolean' ? data.strava.hasHeartrate : null,
      deviceName: typeof data.strava?.deviceName === 'string' ? data.strava.deviceName : null,
      contextText: typeof data.context?.text === 'string' ? data.context.text : null,
      contextTags: readContextTags(data.context?.tags),
    }
  })

  const contextCount = workouts.filter((w) => Boolean(w.contextText)).length
  const currentDateContext: CurrentDateContext = {
    nowIsoUtc: now.toISOString(),
    dateUtc: now.toISOString().slice(0, 10),
    dayOfWeekUtc: dayNamesUtc[now.getUTCDay()],
  }

  return { currentDateContext, workouts, contextCount }
}

export const buildFitnessPersona = onCall(
  { secrets: [geminiApiKey], invoker: 'public' },
  async (req) => {
  try {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in')
    const text = await buildFitnessPersonaText(req.auth.uid)
    await db.doc(`users/${req.auth.uid}`).set(
      {
        fitnessPersonaText: text,
        fitnessPersonaUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    return { text }
  } catch (e) {
    console.error('buildFitnessPersona failed', e)
    if (e instanceof HttpsError) throw e
    throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
  }
  },
)

export const recommendNextWorkout = onCall(
  { secrets: [geminiApiKey], invoker: 'public' },
  async (req) => {
  try {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in')

    const uid = req.auth.uid

    const userSnap = await db.doc(`users/${uid}`).get()
    const userData = (userSnap.data() ?? {}) as {
      goalText?: unknown
      fitnessPersonaText?: unknown
      fitnessPersonaPreferenceText?: unknown
    }

    const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''
    const persona =
      typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''
    const preferencePersona =
      typeof userData.fitnessPersonaPreferenceText === 'string'
        ? userData.fitnessPersonaPreferenceText.trim()
        : ''

    const { currentDateContext, workouts, contextCount } = await getRecentRecommendationContext(uid)

    const apiKey = requireGeminiKey()

    const prompt =
      `You are Flux, an evidence-based personal trainer. Be calm, modern, and concise — no hype.\n\n` +
      `TRAINING PRINCIPLES:\n` +
      `- Safety first: prioritise injury prevention, sleep, and consistency\n` +
      `- RPE (1-10): easy 5-6, moderate 6-7, challenging 7-8+; target 1-3 RIR for strength\n` +
      `- Use Heart Rate zones and Power (where available) alongside RPE\n` +
      `- Progressive overload: increase load, volume, or complexity systematically (+5-10% when appropriate)\n` +
      `- Polarised training (80/20 easy/hard); avoid jumps >10% in volume or intensity week-to-week\n` +
      `- Periodization & autoregulation: vary intensity/volume weekly; adjust to daily readiness and recent load\n` +
      `- Fatigue management: after heavy/long sessions reduce next load; watch for soreness, poor sleep, low energy\n` +
      `- Recovery: structured rest, sleep, nutrition (1.6-2.2g protein/kg), periodic deloads (~every 5-6 weeks)\n` +
      `- Volume anchoring: use past workout durations/distances as baseline; respect historical modality patterns\n` +
      `- No scheduling: do not reference specific days (e.g. "tomorrow") or times of day\n` +
      `- Explain the "why" briefly in 1-2 short bullets; recommend 1-3 options picking the best default from recent load\n` +
      `- Concise copy for mobile: title ≤6 words, duration/intensity ≤10 words, mainSet ≤22 words, each why ≤14 words\n\n` +
      `GOAL:\n${goalText || '(not set)'}\n\n` +
      `FITNESS PERSONA:\n${persona || '(not built yet)'}\n\n` +
      `PREFERENCE FEEDBACK PERSONA:\n${preferencePersona || '(no recommendation feedback yet)'}\n\n` +
      `DATE: ${formatDateContext(currentDateContext)}\n\n` +
      `RECENT WORKOUTS (last ${workouts.length}, ${contextCount} with notes):\n` +
      `${formatWorkoutsAsText(workouts)}\n\n` +
      `Return ONLY valid JSON (no markdown) matching this schema:\n` +
      `{\n` +
      `  "options": [\n` +
      `    {\n` +
      `      "title": "Short energizing title",\n` +
      `      "type": "run",\n` +
      `      "duration": "45 minutes",\n` +
      `      "intensity": "RPE 6-7 (Moderate)",\n` +
      `      "mainSet": "4x2min at 85% max pace, 90sec jog recovery",\n` +
      `      "why": ["Builds aerobic base without excessive fatigue", "Volume matches recent training load"]\n` +
      `    }\n` +
      `  ],\n` +
      `  "safetyChecks": ["Reduce RPE by 1 if feeling fatigued", "Stop if HR stays elevated after effort"]\n` +
      `}\n\n` +
      `Generate 1-3 options balancing progressive overload and recovery. Safety checks must reflect the user's recent history.`

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })
    const result = await model.generateContent(prompt)
    const responseText = result.response.text()
    
    // Parse the JSON response
    let parsed: RecommendationResponse
    try {
      parsed = JSON.parse(responseText)
    } catch {
      // If parsing fails, return error with context
      throw new HttpsError(
        'internal',
        `Failed to parse recommendation. Raw: ${responseText.substring(0, 200)}`
      )
    }
    
    // Validate the response structure
    if (!parsed.options || !Array.isArray(parsed.options) || parsed.options.length === 0) {
      throw new HttpsError('internal', 'Invalid recommendation structure: missing options')
    }
    
    if (!parsed.safetyChecks || !Array.isArray(parsed.safetyChecks)) {
      throw new HttpsError('internal', 'Invalid recommendation structure: missing safetyChecks')
    }

    return parsed
  } catch (e) {
    console.error('recommendNextWorkout failed', e)
    if (e instanceof HttpsError) throw e
    throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
  }
  },
)

export const refineRecommendation = onCall({ secrets: [geminiApiKey] }, async (req) => {
  try {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in')

    const { userMessage, conversationHistory } = req.data as {
      userMessage?: unknown
      conversationHistory?: unknown
    }

    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      throw new HttpsError('invalid-argument', 'User message required')
    }

    if (!Array.isArray(conversationHistory)) {
      throw new HttpsError('invalid-argument', 'Conversation history must be an array')
    }

    // Validate conversation history format
    const validHistory = conversationHistory.filter((msg) => {
      return (
        typeof msg === 'object' &&
        msg !== null &&
        typeof (msg as Record<string, unknown>).role === 'string' &&
        typeof (msg as Record<string, unknown>).content === 'string'
      )
    })

    const uid = req.auth.uid
    const userSnap = await db.doc(`users/${uid}`).get()
    const userData = (userSnap.data() ?? {}) as {
      goalText?: unknown
      fitnessPersonaText?: unknown
      fitnessPersonaPreferenceText?: unknown
    }
    const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''
    const persona =
      typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''
    const preferencePersona =
      typeof userData.fitnessPersonaPreferenceText === 'string'
        ? userData.fitnessPersonaPreferenceText.trim()
        : ''
    const { currentDateContext, workouts, contextCount } = await getRecentRecommendationContext(uid)
    const apiKey = requireGeminiKey()

    // Build conversation context for the model
    const conversationContext = validHistory
      .map((msg: Record<string, unknown>) => `${msg.role}: ${msg.content}`)
      .join('\n')

    const prompt =
      `You are Flux, an evidence-based personal trainer refining a recommendation based on user feedback. Be calm, modern, and concise — no hype.\n\n` +
      `TRAINING PRINCIPLES:\n` +
      `- Safety first: prioritise injury prevention, sleep, and consistency\n` +
      `- RPE (1-10): easy 5-6, moderate 6-7, challenging 7-8+; target 1-3 RIR for strength\n` +
      `- Use Heart Rate zones and Power (where available) alongside RPE\n` +
      `- Progressive overload: increase load, volume, or complexity systematically\n` +
      `- Polarised training (80/20 easy/hard); avoid jumps >10% in volume or intensity\n` +
      `- Periodization & autoregulation: vary intensity/volume; adjust to daily readiness and recent load\n` +
      `- Fatigue signals: soreness/tiredness → suggest active recovery or reduced intensity\n` +
      `- Time constraints: focus quality over volume if user is time-limited\n` +
      `- Equipment: adapt to available tools (no equipment, dumbbells, gym, outdoor)\n` +
      `- Volume anchoring: reference historical durations/distances; stay within user's typical range unless asked otherwise\n` +
      `- No scheduling: do not reference specific days or times of day\n` +
      `- Encourage context: if gym session type unknown, ask user to "Add context" to that workout\n` +
      `- Explain the "why" briefly in 1-2 short bullets\n` +
      `- Concise copy for mobile: title ≤6 words, duration/intensity ≤10 words, mainSet ≤22 words, each why ≤14 words\n\n` +
      `GOAL:\n${goalText || '(not set)'}\n\n` +
      `FITNESS PERSONA:\n${persona || '(not built yet)'}\n\n` +
      `PREFERENCE FEEDBACK PERSONA:\n${preferencePersona || '(no recommendation feedback yet)'}\n\n` +
      `DATE: ${formatDateContext(currentDateContext)}\n\n` +
      `RECENT WORKOUTS (last ${workouts.length}, ${contextCount} with notes):\n` +
      `${formatWorkoutsAsText(workouts)}\n\n` +
      `Conversation history:\n${conversationContext}\n\n` +
      `New constraint/question from user: ${userMessage}\n\n` +
      `Adjust the recommendation to honour the user's input while maintaining training principles.\n\n` +
      `Return ONLY valid JSON (no markdown) matching this schema:\n` +
      `{\n` +
      `  "options": [\n` +
      `    {\n` +
      `      "title": "Short energizing title",\n` +
      `      "type": "run",\n` +
      `      "duration": "30 minutes",\n` +
      `      "intensity": "RPE 6 (Moderate)",\n` +
      `      "mainSet": "Specific workout with reps/duration and RPE target",\n` +
      `      "why": ["Respects time constraint while maintaining stimulus", "Matches user's stated preference"]\n` +
      `    }\n` +
      `  ],\n` +
      `  "safetyChecks": ["Safety note specific to their situation", "Adherence tip relevant to their constraint"]\n` +
      `}\n\n` +
      `If user wants harder, increase RPE 1-2 levels. If easier/shorter, reduce volume or intensity. Always include workout type.`

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })
    const result = await model.generateContent(prompt)
    const responseText = result.response.text()

    // Parse the JSON response
    let parsed: RecommendationResponse
    try {
      parsed = JSON.parse(responseText)
    } catch {
      throw new HttpsError(
        'internal',
        `Failed to parse refined recommendation. Raw: ${responseText.substring(0, 200)}`
      )
    }

    // Validate the response structure
    if (!parsed.options || !Array.isArray(parsed.options) || parsed.options.length === 0) {
      throw new HttpsError('internal', 'Invalid recommendation structure: missing options')
    }

    if (!parsed.safetyChecks || !Array.isArray(parsed.safetyChecks)) {
      throw new HttpsError('internal', 'Invalid recommendation structure: missing safetyChecks')
    }

    return parsed
  } catch (e) {
    console.error('refineRecommendation failed', e)
    if (e instanceof HttpsError) throw e
    throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
  }
})

export const respondToWorkoutRecommendation = onCall({ invoker: 'public' }, async (req) => {
  try {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in')

    const decision = req.data?.decision
    if (decision !== 'pass' && decision !== 'accept') {
      throw new HttpsError('invalid-argument', 'Decision must be "pass" or "accept"')
    }

    const option = normalizeWorkoutOption(req.data?.option)
    if (!option.title || !option.duration || !option.intensity || !option.mainSet) {
      throw new HttpsError('invalid-argument', 'Recommendation option is incomplete')
    }

    const uid = req.auth.uid
    const userRef = db.doc(`users/${uid}`)

    const result = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef)
      const userData = (userSnap.data() ?? {}) as { recommendationPreferences?: unknown }
      const previous = parseRecommendationPreferences(userData.recommendationPreferences)

      const typeKey = normalizePreferenceKey(option.type || 'unknown')
      const intensityKey = intensityBucket(option.intensity)
      const durationKey = durationBucket(parseDurationToMinutes(option.duration))
      const countKey: 'acceptedCount' | 'passedCount' = decision === 'accept' ? 'acceptedCount' : 'passedCount'
      const bucketKey: 'accepted' | 'passed' = decision === 'accept' ? 'accepted' : 'passed'

      const next: RecommendationPreferences = {
        ...previous,
        [countKey]: previous[countKey] + 1,
        byType: {
          ...previous.byType,
          [bucketKey]: incrementCounter(previous.byType[bucketKey], typeKey),
        },
        byIntensity: {
          ...previous.byIntensity,
          [bucketKey]: incrementCounter(previous.byIntensity[bucketKey], intensityKey),
        },
        byDuration: {
          ...previous.byDuration,
          [bucketKey]: incrementCounter(previous.byDuration[bucketKey], durationKey),
        },
      }

      const preferenceSummary = buildPreferenceSummary(next)

      tx.set(
        userRef,
        {
          recommendationPreferences: next,
          fitnessPersonaPreferenceText: preferenceSummary,
          fitnessPersonaUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )

      let saved = false
      if (decision === 'accept') {
        saved = true
        const savedWorkoutRef = db.collection(`users/${uid}/savedWorkouts`).doc()
        tx.set(savedWorkoutRef, {
          option,
          source: 'recommendNextWorkout',
          savedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        })
      }

      return { saved, preferenceSummary }
    })

    return result
  } catch (e) {
    console.error('respondToWorkoutRecommendation failed', e)
    if (e instanceof HttpsError) throw e
    throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
  }
})

export const transcribeWorkoutVoice = onCall({ secrets: [geminiApiKey] }, async (req) => {
  if (!req.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to transcribe')
  }

  const audioBase64 = typeof req.data?.audio === 'string' ? req.data.audio : ''
  if (!audioBase64) {
    throw new HttpsError('invalid-argument', 'Missing audio data')
  }
  const requestedMimeType = typeof req.data?.mimeType === 'string' ? req.data.mimeType.trim().toLowerCase() : ''
  const normalizedMimeType = requestedMimeType.split(';')[0]
  const allowedMimeTypes = new Set([
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/mp3',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
  ])
  const mimeType = allowedMimeTypes.has(normalizedMimeType) ? normalizedMimeType : 'audio/webm'

  try {
    const apiKey = requireGeminiKey()
    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: audioBase64,
        },
      },
      { text: 'Transcribe this workout voice note exactly. If there is no speech, return an empty string. Do not add any commentary.' },
    ])

    const transcription = result.response.text().trim()
    return { transcription }
  } catch (e) {
    const message = (e as Error)?.message || String(e)
    const messageLower = message.toLowerCase()
    console.error('transcribeWorkoutVoice failed', {
      mimeType,
      message,
    })
    if (e instanceof HttpsError) throw e
    if (
      messageLower.includes('mime') ||
      messageLower.includes('format') ||
      messageLower.includes('invalid audio') ||
      messageLower.includes('unsupported')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Unsupported audio format. Please try recording again.',
      )
    }
    if (
      messageLower.includes('too large') ||
      messageLower.includes('payload') ||
      messageLower.includes('request too large')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'Voice note is too large to transcribe. Please record a shorter note and try again.',
      )
    }
    throw new HttpsError('unavailable', 'Transcription service is temporarily unavailable. Please try again.')
  }
})

export const stravaSyncRecent = onCall(
  { secrets: [stravaClientId, stravaClientSecret, geminiApiKey], cors: true, invoker: 'public' },
  async (req) => {
    try {
      if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in')

      const token = await getStravaAccessToken(req.auth.uid)

      const resp = await fetch(
        'https://www.strava.com/api/v3/athlete/activities?per_page=30',
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      )

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new HttpsError('unavailable', 'Strava activities request failed', {
          status: resp.status,
          body,
          step: 'activities_fetch',
        })
      }

      const activitiesJson = (await resp.json()) as unknown
      if (!Array.isArray(activitiesJson)) {
        throw new HttpsError('data-loss', 'Strava activities response had invalid shape')
      }
      const activities = activitiesJson as Array<Record<string, unknown>>
      let upserted = 0

      const batch = db.batch()
      for (const a of activities) {
        const id = typeof a.id === 'number' ? a.id : null
        if (!id) continue

        const workoutRef = db.doc(`users/${req.auth.uid}/workouts/${id}`)
        batch.set(
          workoutRef,
          {
            source: 'strava',
            strava: {
              id,
              type: typeof a.type === 'string' ? a.type : null,
              sportType: typeof a.sport_type === 'string' ? a.sport_type : null,
              name: typeof a.name === 'string' ? a.name : null,
              startDate: typeof a.start_date === 'string' ? a.start_date : null,
              elapsedTime: typeof a.elapsed_time === 'number' ? a.elapsed_time : null,
              movingTime: typeof a.moving_time === 'number' ? a.moving_time : null,
              distance: typeof a.distance === 'number' ? a.distance : null,
              elevationGain: typeof a.total_elevation_gain === 'number' ? a.total_elevation_gain : null,
              avgSpeed: typeof a.average_speed === 'number' ? a.average_speed : null,
              maxSpeed: typeof a.max_speed === 'number' ? a.max_speed : null,
              avgCadence: typeof a.average_cadence === 'number' ? a.average_cadence : null,
              avgHR: typeof a.average_heartrate === 'number' ? a.average_heartrate : null,
              maxHR: typeof a.max_heartrate === 'number' ? a.max_heartrate : null,
              avgPower: typeof a.average_watts === 'number' ? a.average_watts : null,
              weightedAvgPower: typeof a.weighted_average_watts === 'number' ? a.weighted_average_watts : null,
              maxPower: typeof a.max_watts === 'number' ? a.max_watts : null,
              kilojoules: typeof a.kilojoules === 'number' ? a.kilojoules : null,
              sufferScore: typeof a.suffer_score === 'number' ? a.suffer_score : null,
              calories: typeof a.calories === 'number' ? a.calories : null,
              trainer: typeof a.trainer === 'boolean' ? a.trainer : null,
              commute: typeof a.commute === 'boolean' ? a.commute : null,
              manual: typeof a.manual === 'boolean' ? a.manual : null,
              private: typeof a.private === 'boolean' ? a.private : null,
              deviceName: typeof a.device_name === 'string' ? a.device_name : null,
              hasHeartrate: typeof a.has_heartrate === 'boolean' ? a.has_heartrate : null,
              prCount: typeof a.pr_count === 'number' ? a.pr_count : null,
              achievementCount: typeof a.achievement_count === 'number' ? a.achievement_count : null,
              kudosCount: typeof a.kudos_count === 'number' ? a.kudos_count : null,
              commentCount: typeof a.comment_count === 'number' ? a.comment_count : null,
            },
            updatedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        )
        upserted++
      }

      await batch.commit()

      await db.doc(`users/${req.auth.uid}`).set(
        { strava: { lastSyncAt: FieldValue.serverTimestamp() } },
        { merge: true },
      )

      const buildPersona = Boolean((req.data as { buildPersona?: unknown } | undefined)?.buildPersona)

      let personaBuilt = false
      let personaError: string | null = null
      if (buildPersona) {
        try {
          const personaText = await buildFitnessPersonaText(req.auth.uid)
          await db.doc(`users/${req.auth.uid}`).set(
            {
              fitnessPersonaText: personaText,
              fitnessPersonaUpdatedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          )
          personaBuilt = true
        } catch (e) {
          console.error('buildFitnessPersona during stravaSyncRecent failed', e)
          personaError = (e as Error)?.message || 'Failed to build persona'
        }
      }

      return { upserted, personaBuilt, personaError }
    } catch (e) {
      console.error('stravaSyncRecent failed', e)
      if (e instanceof HttpsError) throw e
      throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
    }
  },
)
