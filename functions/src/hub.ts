import { GoogleGenerativeAI } from '@google/generative-ai'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { defineSecret } from 'firebase-functions/params'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { ensureAdminApp } from './admin'
import * as prompts from './prompts'

ensureAdminApp()

const db = getFirestore()
const geminiApiKey = defineSecret('GEMINI_API_KEY')

type WorkoutOption = {
  title: string
  duration: string
  intensity: string
  mainSet: string
  why: string[]
  type?: string
}

type RecommendationResponse = {
  options: WorkoutOption[]
  safetyChecks: string[]
}

type HubChatMessage = {
  role: 'user' | 'assistant'
  content: string
  visible?: boolean
}

type HubChatState = {
  messages: HubChatMessage[]
  recommendation: RecommendationResponse | null
  suggestedMessages: string[]
  ui: {
    showSwipeModal: boolean
    swipePrompt: string
  }
}

type RecommendationPreferences = {
  acceptedCount: number
  passedCount: number
  byType: { accepted: Record<string, number>; passed: Record<string, number> }
  byIntensity: { accepted: Record<string, number>; passed: Record<string, number> }
  byDuration: { accepted: Record<string, number>; passed: Record<string, number> }
}

type RecommendationWorkoutContext = {
  type: string | null
  sportType: string | null
  name: string | null
  workoutDateUtc: string | null
  dayOfWeekUtc: string | null
  daysAgo: number | null
  elapsedTime: number | null
  distance: number | null
  elevationGain: number | null
  avgHR: number | null
  maxHR: number | null
  avgPower: number | null
  weightedAvgPower: number | null
  calories: number | null
  sufferScore: number | null
  trainer: boolean | null
  contextText: string | null
  contextTags: string[] | null
}

type CurrentDateContext = {
  nowIsoUtc: string
  dateUtc: string
  dayOfWeekUtc: string
}

const MAX_SWIPE_PROMPT_LENGTH = 96
const MAX_SWIPE_PROMPT_WORDS = 16
const dayNamesUtc = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, maxLen)
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

function formatDateContext(ctx: CurrentDateContext): string {
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
    input.byIntensity && typeof input.byIntensity === 'object' ? (input.byIntensity as Record<string, unknown>) : {}
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

function summarizeTopCategory(map: Record<string, number>): string | null {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1])
  const top = entries[0]
  return top ? `${top[0]} (${top[1]})` : null
}

function buildRecommendationFeedbackSummary(preferences: RecommendationPreferences): string {
  const acceptedType = summarizeTopCategory(preferences.byType.accepted)
  const passedType = summarizeTopCategory(preferences.byType.passed)
  const acceptedIntensity = summarizeTopCategory(preferences.byIntensity.accepted)
  const passedIntensity = summarizeTopCategory(preferences.byIntensity.passed)
  const acceptedDuration = summarizeTopCategory(preferences.byDuration.accepted)
  const passedDuration = summarizeTopCategory(preferences.byDuration.passed)

  return [
    `Accepted ${preferences.acceptedCount}, passed ${preferences.passedCount}.`,
    acceptedType ? `Most accepted type: ${acceptedType}.` : null,
    passedType ? `Most passed type: ${passedType}.` : null,
    acceptedIntensity ? `Most accepted intensity: ${acceptedIntensity}.` : null,
    passedIntensity ? `Most passed intensity: ${passedIntensity}.` : null,
    acceptedDuration ? `Most accepted duration: ${acceptedDuration}.` : null,
    passedDuration ? `Most passed duration: ${passedDuration}.` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

function normalizePreferenceKey(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s/g, '_')
  return normalized || 'unknown'
}

function incrementCounter(map: Record<string, number>, key: string): Record<string, number> {
  return { ...map, [key]: (map[key] ?? 0) + 1 }
}

function parseDurationToMinutes(duration: string): number | null {
  const text = duration.toLowerCase()
  let minutes = 0
  const hourMatch = text.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/)
  if (hourMatch?.[1]) {
    const hours = Number(hourMatch[1])
    if (Number.isFinite(hours) && hours > 0) minutes += Math.round(hours * 60)
  }
  const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)\b/)
  if (minuteMatch?.[1]) {
    const directMinutes = Number(minuteMatch[1])
    if (Number.isFinite(directMinutes) && directMinutes > 0) minutes += Math.round(directMinutes)
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
  if (/\b(1|2|3|4)\b/.test(lower) || ['easy', 'low'].some((hint) => lower.includes(hint))) return 'easy'
  if (/\b(5|6|7)\b/.test(lower) || ['moderate'].some((hint) => lower.includes(hint))) return 'moderate'
  if (/\b(8|9|10)\b/.test(lower) || ['hard', 'high'].some((hint) => lower.includes(hint))) return 'hard'
  return 'unknown'
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

function unwrapJsonCodeFence(responseText: string): string {
  if (responseText.includes('```json')) return responseText.split('```json')[1]?.split('```')[0]?.trim() ?? responseText
  if (responseText.includes('```')) return responseText.split('```')[1]?.split('```')[0]?.trim() ?? responseText
  return responseText.trim()
}

function normalizeRecommendationResponse(raw: unknown): RecommendationResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (!Array.isArray(data.options)) return null
  const options = data.options
    .map((option) => normalizeWorkoutOption(option))
    .filter((option) => option.title && option.duration && option.intensity && option.mainSet)
    .slice(0, 3)
  if (options.length === 0) return null
  const safetyChecks = Array.isArray(data.safetyChecks)
    ? data.safetyChecks
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeText(item, 140))
      .filter(Boolean)
      .slice(0, 5)
    : []
  return { options, safetyChecks }
}

function recommendationToSuggestedMessages(recommendation: RecommendationResponse | null): string[] {
  if (!recommendation || recommendation.options.length === 0) return []
  return recommendation.options.slice(0, 3).map((option) => {
    const type = option.type ? `${option.type} ` : ''
    return `Tune a ${type}option like "${option.title}" (${option.duration}, ${option.intensity}) to suit me today.`
  })
}

function limitWords(text: string, maxWords: number): string {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const words = normalized.split(' ').filter(Boolean)
  if (words.length <= maxWords) return normalized
  return words.slice(0, maxWords).join(' ')
}

function normalizeHubChatUi(
  raw: unknown,
  recommendation: RecommendationResponse | null,
): { showSwipeModal: boolean; swipePrompt: string } {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const swipePromptRaw = limitWords(sanitizeText(input.swipePrompt, MAX_SWIPE_PROMPT_LENGTH), MAX_SWIPE_PROMPT_WORDS)
  const hasRecommendation = Boolean(recommendation && recommendation.options.length > 0)
  return {
    showSwipeModal:
      hasRecommendation && typeof input.showSwipeModal === 'boolean' ? input.showSwipeModal : hasRecommendation,
    swipePrompt: swipePromptRaw || 'I have workout options ready. Open swipe mode to pass or save what fits today.',
  }
}

async function getRecentRecommendationContext(uid: string): Promise<{
  currentDateContext: CurrentDateContext
  workouts: RecommendationWorkoutContext[]
  contextCount: number
}> {
  const now = new Date()
  const workoutsSnap = await db.collection(`users/${uid}/workouts`).orderBy('strava.startDate', 'desc').limit(10).get()

  const workouts = workoutsSnap.docs.map((d) => {
    const data = (d.data() ?? {}) as {
      strava?: { type?: unknown; sportType?: unknown; name?: unknown; startDate?: unknown; distance?: unknown; elapsedTime?: unknown; movingTime?: unknown; elevationGain?: unknown; avgHR?: unknown; maxHR?: unknown; avgPower?: unknown; weightedAvgPower?: unknown; calories?: unknown; sufferScore?: unknown; trainer?: unknown }
      context?: { text?: unknown; tags?: unknown }
    }
    const startDate = typeof data.strava?.startDate === 'string' ? data.strava.startDate : null
    const parsed = startDate ? new Date(startDate) : null
    const daysAgo =
      parsed && !Number.isNaN(parsed.getTime())
        ? Math.max(0, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())) / (24 * 60 * 60 * 1000)))
        : null
    return {
      type: typeof data.strava?.type === 'string' ? data.strava.type : null,
      sportType: typeof data.strava?.sportType === 'string' ? data.strava.sportType : null,
      name: typeof data.strava?.name === 'string' ? data.strava.name : null,
      workoutDateUtc: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null,
      dayOfWeekUtc: parsed && !Number.isNaN(parsed.getTime()) ? dayNamesUtc[parsed.getUTCDay()] : null,
      daysAgo,
      distance: typeof data.strava?.distance === 'number' ? data.strava.distance : null,
      elapsedTime: typeof data.strava?.elapsedTime === 'number' ? data.strava.elapsedTime : null,
      movingTime: typeof data.strava?.movingTime === 'number' ? data.strava.movingTime : null,
      elevationGain: typeof data.strava?.elevationGain === 'number' ? data.strava.elevationGain : null,
      avgHR: typeof data.strava?.avgHR === 'number' ? data.strava.avgHR : null,
      maxHR: typeof data.strava?.maxHR === 'number' ? data.strava.maxHR : null,
      avgPower: typeof data.strava?.avgPower === 'number' ? data.strava.avgPower : null,
      weightedAvgPower: typeof data.strava?.weightedAvgPower === 'number' ? data.strava.weightedAvgPower : null,
      calories: typeof data.strava?.calories === 'number' ? data.strava.calories : null,
      sufferScore: typeof data.strava?.sufferScore === 'number' ? data.strava.sufferScore : null,
      trainer: typeof data.strava?.trainer === 'boolean' ? data.strava.trainer : null,
      contextText: typeof data.context?.text === 'string' ? data.context.text : null,
      contextTags: readContextTags(data.context?.tags),
    }
  })

  return {
    currentDateContext: {
      nowIsoUtc: now.toISOString(),
      dateUtc: now.toISOString().slice(0, 10),
      dayOfWeekUtc: dayNamesUtc[now.getUTCDay()],
    },
    workouts,
    contextCount: workouts.filter((w) => Boolean(w.contextText)).length,
  }
}

async function loadHubChatMessages(uid: string, limitCount = 80): Promise<HubChatMessage[]> {
  const snap = await db.collection(`users/${uid}/hubChat`).orderBy('createdAt', 'asc').limit(limitCount).get()
  return snap.docs
    .map((doc) => {
      const data = (doc.data() ?? {}) as { role?: unknown; content?: unknown }
      const role = data.role === 'user' ? 'user' : data.role === 'assistant' ? 'assistant' : null
      const content = typeof data.content === 'string' ? sanitizeText(data.content, 2000) : ''
      if (!role || !content) return null
      return { role, content }
    })
    .filter((message): message is HubChatMessage => message !== null)
}

async function loadHubChatState(uid: string): Promise<HubChatState> {
  const [messages, metaSnap] = await Promise.all([loadHubChatMessages(uid), db.doc(`users/${uid}/hubChat/meta`).get()])
  const meta = (metaSnap.data() ?? {}) as { recommendation?: unknown; suggestedMessages?: unknown; ui?: unknown }
  const recommendation = normalizeRecommendationResponse(meta.recommendation)
  const suggestedMessages = Array.isArray(meta.suggestedMessages)
    ? meta.suggestedMessages
      .filter((item): item is string => typeof item === 'string')
      .map((item) => sanitizeText(item, 120))
      .filter(Boolean)
      .slice(0, 6)
    : recommendationToSuggestedMessages(recommendation)
  const ui = normalizeHubChatUi(meta.ui, recommendation)
  return { messages, recommendation, suggestedMessages, ui }
}

async function clearHubChatState(uid: string): Promise<{ cleared: number }> {
  const hubChatRef = db.collection(`users/${uid}/hubChat`)
  const [messagesSnap, metaSnap] = await Promise.all([hubChatRef.get(), db.doc(`users/${uid}/hubChat/meta`).get()])
  const batch = db.batch()

  messagesSnap.docs.forEach((doc) => batch.delete(doc.ref))
  if (metaSnap.exists) {
    batch.delete(metaSnap.ref)
  }

  await batch.commit()
  return { cleared: messagesSnap.size + (metaSnap.exists ? 1 : 0) }
}

function countUserMessages(conversation: HubChatMessage[]): number {
  return conversation.reduce((count, message) => count + (message.role === 'user' && message.visible !== false ? 1 : 0), 0)
}

async function distillChatPersona(uid: string, conversation: HubChatMessage[]): Promise<void> {
  if (countUserMessages(conversation) < 2) return
  const userRef = db.doc(`users/${uid}`)
  const userSnap = await userRef.get()
  const userData = (userSnap.data() ?? {}) as { fitnessPersonaText?: unknown; fitnessPersonaPreferenceText?: unknown }
  const previousPersona = typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''
  const previousPreferenceText =
    typeof userData.fitnessPersonaPreferenceText === 'string' ? userData.fitnessPersonaPreferenceText.trim() : ''

  const dialogue = conversation.slice(-14).map((msg) => `${msg.role}: ${msg.content}`).join('\n')
  if (!dialogue) return

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })
  const prompt =
    `You are updating a fitness preference memory from a coach chat.\n` +
    `Summarize only durable preferences and constraints that should influence future workout recommendations.\n` +
    `Do NOT include short-term chat filler or motivational language.\n` +
    `Keep under 120 words.\n\n` +
    `PREVIOUS PREFERENCE MEMORY:\n${previousPreferenceText || '(none)'}\n\n` +
    `CURRENT PERSONA:\n${previousPersona || '(none)'}\n\n` +
    `LATEST CHAT SNIPPET:\n${dialogue}\n\n` +
    `Output plain text only.`

  const result = await model.generateContent(prompt)
  const distilledPreference = sanitizeText(result.response.text(), 1200)
  if (!distilledPreference) return

  await userRef.set(
    {
      fitnessPersonaPreferenceText: distilledPreference,
      fitnessPersonaUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

async function getHubChatStateImpl(uid: string): Promise<HubChatState> {
  return await loadHubChatState(uid)
}

async function chatInHubImpl(
  uid: string,
  userMessage: string,
  conversationHistory?: HubChatMessage[],
): Promise<HubChatState> {
  const userRef = db.doc(`users/${uid}`)
  const [existingState, userSnap, recommendationContext] = await Promise.all([
    conversationHistory ? Promise.resolve(null) : loadHubChatState(uid),
    userRef.get(),
    getRecentRecommendationContext(uid),
  ])

  const userData = (userSnap.data() ?? {}) as {
    goalText?: unknown
    workoutEnvironmentConstraintsText?: unknown
    fitnessPersonaText?: unknown
    fitnessPersonaPreferenceText?: unknown
    recommendationPreferences?: unknown
  }
  const goalText = typeof userData.goalText === 'string' ? userData.goalText.trim() : ''
  const workoutEnvironmentConstraintsText =
    typeof userData.workoutEnvironmentConstraintsText === 'string' ? userData.workoutEnvironmentConstraintsText.trim() : ''
  const persona = typeof userData.fitnessPersonaText === 'string' ? userData.fitnessPersonaText.trim() : ''
  const preferencePersona =
    typeof userData.fitnessPersonaPreferenceText === 'string' ? userData.fitnessPersonaPreferenceText.trim() : ''
  const recommendationFeedback = buildRecommendationFeedbackSummary(
    parseRecommendationPreferences(userData.recommendationPreferences),
  )

  const baseConversation = conversationHistory?.length
    ? conversationHistory
    : existingState?.messages ?? []
  const conversation = [...baseConversation.slice(-18), { role: 'user' as const, content: userMessage }]
  const conversationContext = conversation.map((msg) => `${msg.role}: ${msg.content}`).join('\n')

  const prompt = prompts.buildChatPrompt(
    goalText,
    workoutEnvironmentConstraintsText,
    persona,
    preferencePersona,
    recommendationFeedback,
    formatDateContext(recommendationContext.currentDateContext),
    formatWorkoutsAsText(recommendationContext.workouts),
    conversationContext,
  )

  const apiKey = requireGeminiKey()
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' })
  const result = await model.generateContent(prompt)
  const responseText = unwrapJsonCodeFence(result.response.text())

  let parsedRaw: { assistantMessage?: unknown; recommendation?: unknown; ui?: unknown; suggestedMessages?: unknown }
  try {
    parsedRaw = JSON.parse(responseText) as { assistantMessage?: unknown; recommendation?: unknown; ui?: unknown; suggestedMessages?: unknown }
  } catch (jsonErr) {
    throw new HttpsError(
      'internal',
      `Failed to parse chat JSON: ${(jsonErr as Error)?.message || 'Invalid format'}. Raw snippet: ${responseText.substring(0, 120)}`,
    )
  }

  const assistantMessage = sanitizeText(parsedRaw.assistantMessage, 1500)
  if (!assistantMessage) throw new HttpsError('internal', 'Chat response was missing assistantMessage')

  const recommendation = normalizeRecommendationResponse(parsedRaw.recommendation)
  const ui = normalizeHubChatUi(parsedRaw.ui, recommendation)
  const suggestedMessages = Array.isArray(parsedRaw.suggestedMessages)
    ? parsedRaw.suggestedMessages.filter((item): item is string => typeof item === 'string').map((item) => sanitizeText(item, 120)).filter(Boolean).slice(0, 6)
    : recommendationToSuggestedMessages(recommendation)

  const hubMessagesRef = db.collection(`users/${uid}/hubChat`)
  const batch = db.batch()
  batch.set(hubMessagesRef.doc(), { role: 'user', content: userMessage, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  batch.set(hubMessagesRef.doc(), { role: 'assistant', content: assistantMessage, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  batch.set(db.doc(`users/${uid}/hubChat/meta`), { recommendation, ui, suggestedMessages, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  await batch.commit()

  const fullConversation = [...conversation, { role: 'assistant' as const, content: assistantMessage }]
  await distillChatPersona(uid, fullConversation)

  return await loadHubChatState(uid)
}

export const getHubChatStateCallable = onCall({ invoker: 'public', cors: ['*'] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be authenticated')
  return await getHubChatStateImpl(request.auth.uid)
})

export const clearHubChatStateCallable = onCall({ invoker: 'public', cors: ['*'] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be authenticated')
  return await clearHubChatState(request.auth.uid)
})

export const deleteSavedWorkoutCallable = onCall({ invoker: 'public', cors: ['*'] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be authenticated')

  const savedWorkoutId = sanitizeText((request.data as { savedWorkoutId?: unknown } | undefined)?.savedWorkoutId, 80)
  if (!savedWorkoutId) throw new HttpsError('invalid-argument', 'savedWorkoutId is required')

  const savedWorkoutRef = db.doc(`users/${request.auth.uid}/savedWorkouts/${savedWorkoutId}`)
  await savedWorkoutRef.delete()

  return { deleted: true }
})

export const chatInHubCallable = onCall({ invoker: 'public', secrets: [geminiApiKey], cors: ['*'] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be authenticated')
  const userMessage = sanitizeText(request.data?.userMessage, 800)
  if (!userMessage) throw new HttpsError('invalid-argument', 'userMessage is required')
  const conversationHistoryRaw = (request.data as { conversationHistory?: unknown } | undefined)?.conversationHistory
  const conversationHistory = Array.isArray(conversationHistoryRaw)
    ? conversationHistoryRaw
      .filter((msg): msg is HubChatMessage => {
        if (!msg || typeof msg !== 'object') return false
        const role = (msg as { role?: unknown }).role
        const content = (msg as { content?: unknown }).content
        return (role === 'user' || role === 'assistant') && typeof content === 'string' && Boolean(content.trim())
      })
      .map((msg) => ({
        role: msg.role,
        content: sanitizeText(msg.content, 2000),
        visible: msg.visible !== false,
      }))
    : undefined
  return await chatInHubImpl(request.auth.uid, userMessage, conversationHistory)
})

function parseDurationAndBuckets(option: WorkoutOption, decision: 'pass' | 'accept') {
  const typeKey = normalizePreferenceKey(option.type || 'unknown')
  const intensityKey = intensityBucket(option.intensity)
  const durationKey = durationBucket(parseDurationToMinutes(option.duration))
  const countKey: 'acceptedCount' | 'passedCount' = decision === 'accept' ? 'acceptedCount' : 'passedCount'
  const bucketKey: 'accepted' | 'passed' = decision === 'accept' ? 'accepted' : 'passed'
  return { typeKey, intensityKey, durationKey, countKey, bucketKey }
}

export const respondToWorkoutRecommendation = onCall({ secrets: [geminiApiKey], invoker: 'public' }, async (req) => {
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
    const { typeKey, intensityKey, durationKey, countKey, bucketKey } = parseDurationAndBuckets(option, decision)
    const next: RecommendationPreferences = {
      ...previous,
      [countKey]: previous[countKey] + 1,
      byType: { ...previous.byType, [bucketKey]: incrementCounter(previous.byType[bucketKey], typeKey) },
      byIntensity: { ...previous.byIntensity, [bucketKey]: incrementCounter(previous.byIntensity[bucketKey], intensityKey) },
      byDuration: { ...previous.byDuration, [bucketKey]: incrementCounter(previous.byDuration[bucketKey], durationKey) },
    }

    tx.set(userRef, { recommendationPreferences: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    tx.set(db.doc(`users/${uid}/hubChat/meta`), {
      recommendation: null,
      suggestedMessages: [],
      ui: { showSwipeModal: false, swipePrompt: '' },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

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

    return { saved }
  })

  return result
})

export { formatDateContext, formatWorkoutsAsText, getRecentRecommendationContext, readContextTags }
