import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret, defineString } from 'firebase-functions/params'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

initializeApp()

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

export const geminiPrompt = onCall({ secrets: [geminiApiKey] }, async (req) => {
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
  { secrets: [stravaClientId, stravaStateSecret], cors: true },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to connect Strava')
    }

    const clientId = stravaClientId.value()
    const secret = stravaStateSecret.value()

    if (!clientId) {
      throw new HttpsError('failed-precondition', 'Missing STRAVA_CLIENT_ID secret')
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
      const code = typeof req.query.code === 'string' ? req.query.code : ''
      const state = typeof req.query.state === 'string' ? req.query.state : ''

      if (!code || !state) {
        res.status(400).send('Missing code/state')
        return
      }

      const stateSecret = stravaStateSecret.value()
      const { uid } = parseAndVerifyState(state, stateSecret)

      const clientId = stravaClientId.value()
      const clientSecret = stravaClientSecret.value()

      const tokenResp = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
        }),
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
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )

      await db.doc(`users/${uid}`).set(
        {
          strava: {
            connected: true,
            athleteId: athleteId ?? undefined,
            lastSyncAt: null,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new HttpsError('internal', `Strava refresh failed: ${resp.status} ${body}`)
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
      }
    }

    return {
      type: typeof data.strava?.type === 'string' ? data.strava.type : null,
      name: typeof data.strava?.name === 'string' ? data.strava.name : null,
      startDate: typeof data.strava?.startDate === 'string' ? data.strava.startDate : null,
      distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
      elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
    }
  })

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })

  const prompt =
    `You are Flux, a calm personal trainer in the user's pocket.\n` +
    `Write a short fitness persona for this user based on their goal and recent workouts.\n` +
    `Keep it under 160 words. No fluff.\n\n` +
    `Goal:\n${goalText || '(not set)'}\n\n` +
    `Recent workouts (JSON):\n${JSON.stringify(workouts, null, 2)}\n\n` +
    `Output format:\n` +
    `- Persona (3-5 bullets)\n` +
    `- Constraints/risks (0-3 bullets)\n` +
    `- Coaching focus for next 2 weeks (3 bullets)`

  const result = await model.generateContent(prompt)
  return result.response.text().trim()
}

export const buildFitnessPersona = onCall({ secrets: [geminiApiKey] }, async (req) => {
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
})

export const recommendNextWorkout = onCall({ secrets: [geminiApiKey] }, async (req) => {
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
        }
        context?: { text?: unknown }
      }

      return {
        type: typeof data.strava?.type === 'string' ? data.strava.type : null,
        name: typeof data.strava?.name === 'string' ? data.strava.name : null,
        startDate: typeof data.strava?.startDate === 'string' ? data.strava.startDate : null,
        distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
        elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
        contextText: typeof data.context?.text === 'string' ? data.context.text : null,
      }
    })

    const guidance = readGuidanceText()
    const apiKey = requireGeminiKey()

    const prompt =
      `You are Flux, a calm personal trainer in the user's pocket.\n` +
      `Use the guidance, goal, persona, and recent workouts to recommend 1–3 next workouts.\n` +
      `Be safe and specific.\n\n` +
      `WORKOUT_GUIDANCE.TXT:\n${guidance || '(missing guidance)'}\n\n` +
      `Goal:\n${goalText || '(not set)'}\n\n` +
      `Fitness persona (if any):\n${persona || '(not built yet)'}\n\n` +
      `Recent workouts (JSON):\n${JSON.stringify(workouts, null, 2)}\n\n` +
      `Return exactly this format:\n` +
      `Option 1 (best):\n- Title\n- Duration\n- Intensity (RPE)\n- Warmup\n- Main set\n- Cooldown\n- Why (2 bullets)\n\n` +
      `Option 2 (optional): same\n\n` +
      `Option 3 (optional): same\n`

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })
    const result = await model.generateContent(prompt)
    const text = result.response.text()

    return { text }
  } catch (e) {
    console.error('recommendNextWorkout failed', e)
    if (e instanceof HttpsError) throw e
    throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
  }
})

export const stravaSyncRecent = onCall(
  { secrets: [stravaClientId, stravaClientSecret, geminiApiKey], cors: true },
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
        throw new HttpsError('internal', `Strava activities failed: ${resp.status} ${body}`)
      }

      const activities = (await resp.json()) as Array<Record<string, unknown>>
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
              name: typeof a.name === 'string' ? a.name : null,
              startDate: typeof a.start_date === 'string' ? a.start_date : null,
              elapsedTime: typeof a.elapsed_time === 'number' ? a.elapsed_time : null,
              movingTime: typeof a.moving_time === 'number' ? a.moving_time : null,
              distance: typeof a.distance === 'number' ? a.distance : null,
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

      if (buildPersona) {
        const personaText = await buildFitnessPersonaText(req.auth.uid)
        await db.doc(`users/${req.auth.uid}`).set(
          {
            fitnessPersonaText: personaText,
            fitnessPersonaUpdatedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        )
      }

      return { upserted, personaBuilt: buildPersona }
    } catch (e) {
      console.error('stravaSyncRecent failed', e)
      if (e instanceof HttpsError) throw e
      throw new HttpsError('internal', (e as Error)?.message || 'Unknown error')
    }
  },
)
