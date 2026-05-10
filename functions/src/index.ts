import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret, defineString } from 'firebase-functions/params'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

initializeApp()

// Structured recommendation types
export type WorkoutOption = {
  title: string
  duration: string
  intensity: string
  warmup: string
  mainSet: string
  cooldown: string
  why: string[]
  type?: string
}

export type RecommendationResponse = {
  options: WorkoutOption[]
  safetyChecks: string[]
}

const db = getFirestore()

const geminiApiKey = defineSecret('GEMINI_API_KEY')

const stravaClientId = defineSecret('STRAVA_CLIENT_ID')
const stravaClientSecret = defineSecret('STRAVA_CLIENT_SECRET')
const stravaStateSecret = defineSecret('STRAVA_STATE_SECRET')
const appBaseUrl = defineString('APP_BASE_URL', { default: '' })

function readGuidanceText(): string {
  try {
    const p = path.resolve(__dirname, '..', 'workout_guidance.txt')
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
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
  const userData = (userSnap.data() ?? {}) as { goalText?: unknown }
  const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''

  const workoutsSnap = await db
    .collection(`users/${uid}/workouts`)
    .orderBy('strava.startDate', 'desc')
    .limit(50)
    .get()

  const workouts = workoutsSnap.docs.map((d) => {
    // Mapping Strava workout data
    const data = (d.data() ?? {}) as {
      strava?: Record<string, unknown>
      context?: { text?: unknown }
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
    }
  })

  // Compute patterns by modality
  const patterns = computeWorkoutPatterns(workouts)

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

  const prompt =
    `You are Flux, a calm personal trainer analyzing a user's fitness profile.\n` +
    `Synthesize a concise fitness persona from their goal, workout patterns, and current state.\n` +
    `Keep output under 200 words. Be concrete, specific, and actionable.\n\n` +
    `Goal:\n${goalText || '(not set)'}\n\n` +
    `Workout patterns (compressed):\n${patterns}\n\n` +
    `Recent workouts (JSON):\n${JSON.stringify(workouts.slice(0, 15), null, 2)}\n\n` +
    `Output three sections:\n` +
    `1. Athlete Profile: Current modalities, typical effort zones, key stats (3 bullets)\n` +
    `2. Constraints & Risks: Recovery patterns, high-fatigue indicators, equipment/time limits (2-3 bullets)\n` +
    `3. Next 14 Days Focus: Progressive priorities, underutilized systems, intensity/volume balance (3 bullets)`

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
    }

    const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''
    const persona =
      typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''

    const workoutsSnap = await db
      .collection(`users/${uid}/workouts`)
      .orderBy('strava.startDate', 'desc')
      .limit(30)
      .get()

    const workouts = workoutsSnap.docs.map((d) => {
      const data = (d.data() ?? {}) as {
        strava?: {
          type?: unknown
          name?: unknown
          startDate?: unknown
          distance?: unknown
          elapsedTime?: unknown
          movingTime?: unknown
          avgHR?: unknown
          avgPower?: unknown
          trainer?: unknown
          manual?: unknown
        }
        context?: { text?: unknown }
      }

      return {
        type: typeof data.strava?.type === 'string' ? data.strava.type : null,
        name: typeof data.strava?.name === 'string' ? data.strava.name : null,
        startDate: typeof data.strava?.startDate === 'string' ? data.strava.startDate : null,
        distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
        elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
        movingTime: typeof data.strava?.movingTime === 'number' ? data.strava.movingTime : null,
        avgHR: typeof data.strava?.avgHR === 'number' ? data.strava.avgHR : null,
        avgPower: typeof data.strava?.avgPower === 'number' ? data.strava.avgPower : null,
        trainer: typeof data.strava?.trainer === 'boolean' ? data.strava.trainer : null,
        manual: typeof data.strava?.manual === 'boolean' ? data.strava.manual : null,
        contextText: typeof data.context?.text === 'string' ? data.context.text : null,
      }
    })

    const guidance = readGuidanceText()
    const apiKey = requireGeminiKey()
    const contextCount = workouts.filter((w) => Boolean(w.contextText)).length

    const prompt =
      `You are Flux, a evidence-based personal trainer providing professional guidance.\n` +
      `Core principles: progressive overload, periodization, autoregulation (RPE), fatigue management, recovery prioritization.\n\n` +
      `TRAINING PRINCIPLES:\n` +
      `- Use RPE (Rate of Perceived Exertion 1-10) to guide intensity; target 1-3 RIR (reps in reserve)\n` +
      `- Apply progressive overload: increase load, volume (sets x reps), or complexity systematically\n` +
      `- Periodization: vary intensity/volume weekly to prevent plateaus and manage fatigue\n` +
      `- Autoregulation: adjust based on daily readiness and recent load patterns\n` +
      `- Fatigue management: monitor recent load (duration, intensity, frequency). After heavy/long sessions, reduce next load\n` +
      `- Recovery: prioritize sleep, nutrition (1.6-2.2g protein/kg), structured rest days, and periodic deloads (~5-6 weeks)\n` +
      `- Safety first: avoid overprescribing intensity when fatigue signals detected; use proper form over heavy weight\n\n` +
      `WORKOUT_GUIDANCE.TXT:\n${guidance || '(missing guidance)'}\n\n` +
      `Goal:\n${goalText || '(not set)'}\n\n` +
      `Fitness persona (if any):\n${persona || '(not built yet)'}\n\n` +
      `Context coverage: ${contextCount} workouts include user notes.\n\n` +
      `Recent workouts (JSON):\n${JSON.stringify(workouts, null, 2)}\n\n` +
      `RECOMMENDATION STRATEGY:\n` +
      `1. Assess recent load: sum duration/intensity of last 3-5 workouts\n` +
      `2. Check for fatigue signals: user notes mentioning soreness, fatigue, or reduced energy\n` +
      `3. Apply periodization: if recent intensity high, recommend moderate/recovery; if recent load light, recommend challenging session\n` +
      `4. Use RPE guidance: specify intensity as "RPE X/10" (easier sessions RPE 5-6, moderate 6-7, challenging 7-8+)\n` +
      `5. Include warm-up/cool-down appropriate to intensity\n` +
      `6. Provide reasoning: why this workout now (progressive vs recovery, modality, energy system)\n` +
      `7. Safety emphasis: highlight any cautions based on recent history (e.g., "reduce intensity if soreness high")\n` +
      `8. Set workout type: choose from "run", "ride", "swim", or other appropriate activity\n` +
      `9. TIE TIMINGS TO PATTERNS: Analyze historical data by modality (runs vs rides vs swims vs weights):\n` +
      `   - If user has logged multiple runs: check avg duration, typical effort patterns, recovery needs between runs\n` +
      `   - If user has logged multiple swims: infer pool/open water preference, stroke preferences, typical distances\n` +
      `   - If user has logged strength: identify primary lifts, typical session duration, volume/intensity patterns\n` +
      `   - Use past workout durations as anchors (e.g., "last 5K run was 28min, recommend pace based on this")\n` +
      `   - Suggest timings that fit their historical patterns AND progressive overload (e.g., +5-10% if appropriate)\n\n` +
      `Return ONLY valid JSON (no markdown, no extra text) matching this schema:\n` +
      `{\n` +
      `  "options": [\n` +
      `    {\n` +
      `      "title": "Clear, energizing title",\n` +
      `      "type": "run",\n` +
      `      "duration": "45 minutes",\n` +
      `      "intensity": "RPE 6-7 (Moderate) - sustainable effort",\n` +
      `      "warmup": "10 min easy jogging + dynamic stretches",\n` +
      `      "mainSet": "4x2min at 85% max pace with 90sec jog recovery (RPE 7)",\n` +
      `      "cooldown": "5 min easy walk + 2 min static stretching",\n` +
      `      "why": ["Builds aerobic capacity without excessive fatigue", "Allows recovery if recent volume was high"]\n` +
      `    }\n` +
      `  ],\n` +
      `  "safetyChecks": ["Reduce intensity by 1 RPE level if feeling fatigued", "Monitor heart rate; end if HR doesn't drop post-effort"]\n` +
      `}\n\n` +
      `Generate 1-3 workout options balancing progressive overload and recovery. Include workout type. Safety checks must be specific to their recent history.`

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

    const apiKey = requireGeminiKey()

    // Build conversation context for the model
    const conversationContext = validHistory
      .map((msg: Record<string, unknown>) => `${msg.role}: ${msg.content}`)
      .join('\n')

    const prompt =
      `You are Flux, a professional personal trainer refining recommendations based on user feedback.\n` +
      `Apply evidence-based principles: progressive overload, periodization, RPE-based autoregulation, fatigue management.\n\n` +
      `KEY GUIDANCE:\n` +
      `- RPE scale: 1-3 (very easy), 4-5 (easy), 6-7 (moderate), 8-9 (hard), 10 (max effort)\n` +
      `- Time constraints: if user says "30 min", focus quality over volume; respect their availability\n` +
      `- Equipment: adapt exercises to available tools (no equipment, dumbbells, gym, outdoor)\n` +
      `- Fatigue signals: if user mentions soreness/tiredness, suggest active recovery or reduced intensity\n` +
      `- Progressive: if user wants harder, increase load/volume/intensity; if easier, reduce RPE by 1-2 levels\n` +
      `- Recovery: emphasize sleep, nutrition, form over ego-lifting\n` +
      `- Timing patterns: reference historical workout durations and modality-specific patterns to anchor recommendations\n` +
      `  (e.g., if they typically run 30-40min, suggest within that range unless they explicitly ask differently)\n\n` +
      `Conversation history:\n${conversationContext}\n\n` +
      `New constraint/question from user: ${userMessage}\n\n` +
      `Adjust the recommendation to honor the user's input while maintaining training principles.\n` +
      `Be specific about RPE levels, durations, and why the adjustment makes sense for their goals, current state, and historical patterns.\n\n` +
      `Return ONLY valid JSON (no markdown, no extra text) matching this schema:\n` +
      `{\n` +
      `  "options": [\n` +
      `    {\n` +
      `      "title": "Clear, energizing title",\n` +
      `      "type": "run",\n` +
      `      "duration": "30 minutes",\n` +
      `      "intensity": "RPE 6 (Moderate - sustainable effort)",\n` +
      `      "warmup": "5 min easy warm-up specific to activity",\n` +
      `      "mainSet": "Specific workout with reps/duration and RPE target",\n` +
      `      "cooldown": "3 min easy cool-down + stretch",\n` +
      `      "why": ["Respects time constraint while maintaining stimulus", "Accommodates user's stated preference/limitation"]\n` +
      `    }\n` +
      `  ],\n` +
      `  "safetyChecks": ["Specific safety note based on their situation", "Adherence tip relevant to their constraint"]\n` +
      `}\n\n` +
      `If user wants harder, increase RPE 1-2 levels. If easier/shorter, reduce volume or intensity. Always include workout type. Respect equipment/time limits.`

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
