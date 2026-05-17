import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { collection, doc, getDocs, limit as firestoreLimit, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db, storage, functions } from '../lib/firebase'
import { httpsCallable } from 'firebase/functions'

type Props = {
  uid: string
  workoutId: string
  workoutType?: string | null
  initialText?: string | null
  initialTags?: string[] | null
  initialVoiceUrl?: string | null
}

const MAX_SUGGESTED_TAGS = 6
const MAX_SELECTED_TAGS = 6

const DEFAULT_TAGS_BY_TYPE: Array<{ match: string[]; tags: string[] }> = [
  { match: ['run'], tags: ['Recovery', 'Easy', 'Tempo', 'Intervals', 'Long'] },
  { match: ['ride', 'cycle'], tags: ['Recovery', 'Endurance', 'Tempo', 'Intervals', 'Climbing'] },
  { match: ['swim'], tags: ['Technique', 'Endurance', 'Tempo', 'Intervals', 'Recovery'] },
  { match: ['weight', 'gym', 'strength', 'workout'], tags: ['Push', 'Pull', 'Upper', 'Lower', 'Core'] },
]

function normalizeTag(raw: string): string | null {
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ').slice(0, 24)
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    const normalized = normalizeTag(tag)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key); out.push(normalized)
  }
  return out
}

function defaultTagsForWorkout(type?: string | null): string[] {
  if (!type) return ['Push', 'Pull', 'Upper', 'Lower', 'Recovery']
  const normalized = type.toLowerCase()
  const matched = DEFAULT_TAGS_BY_TYPE.find((entry) => entry.match.some((m) => normalized.includes(m)))
  return matched?.tags ?? ['Push', 'Pull', 'Upper', 'Lower', 'Recovery']
}

export function WorkoutContextEditor({ uid, workoutId, workoutType, initialText, initialTags, initialVoiceUrl }: Props) {
  const [text, setText] = useState(initialText ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(() => uniqueTags(initialTags ?? []).slice(0, MAX_SELECTED_TAGS))
  const [suggestedTags, setSuggestedTags] = useState<string[]>([])
  const [voiceUrl, setVoiceUrl] = useState<string | null>(initialVoiceUrl ?? null)
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const workoutRef = useMemo(() => doc(db, 'users', uid, 'workouts', workoutId), [uid, workoutId])

  useEffect(() => {
    const typeDefaults = defaultTagsForWorkout(workoutType)
    const loadSuggestions = async () => {
      try {
        const recentSnap = await getDocs(query(collection(db, 'users', uid, 'workouts'), orderBy('strava.startDate', 'desc'), firestoreLimit(20)))
        const counts = new Map<string, number>()
        for (const d of recentSnap.docs) {
          const data = d.data() as { context?: { tags?: unknown } }
          if (!Array.isArray(data.context?.tags)) continue
          for (const raw of data.context.tags) {
            if (typeof raw !== 'string') continue
            const tag = normalizeTag(raw)
            if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1)
          }
        }
        const personal = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
        setSuggestedTags(uniqueTags([...typeDefaults, ...personal]).slice(0, MAX_SUGGESTED_TAGS))
      } catch { setSuggestedTags(typeDefaults.slice(0, MAX_SUGGESTED_TAGS)) }
    }
    void loadSuggestions()
  }, [uid, workoutType])

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const exists = prev.some((t) => t.toLowerCase() === tag.toLowerCase())
      if (exists) return prev.filter((t) => t.toLowerCase() !== tag.toLowerCase())
      if (prev.length >= MAX_SELECTED_TAGS) return prev
      return [...prev, tag]
    })
  }

  const saveText = async () => {
    try {
      setError(null); setStatus(null); setSaving(true)
      await updateDoc(workoutRef, { context: { text: text.trim(), tags: selectedTags, voiceUrl: voiceUrl ?? null, updatedAt: serverTimestamp() } })
      setStatus('Context saved')
    } catch (e) { setError(String(e)) } finally { setSaving(false) }
  }

  const startRecording = async () => {
    try {
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data) }
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()) }
      mr.start(); mediaRecorderRef.current = mr; setRecording(true)
    } catch (e) { setError('Mic access denied') }
  }

  const stopAndUpload = async () => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    try {
      setError(null); setStatus(null); setUploading(true)
      const stopped = new Promise<void>((resolve) => { mr.onstop = () => resolve(); mr.stop() })
      await stopped
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
       const path = `users/${uid}/workouts/${workoutId}/context-${Date.now()}.webm`
      const r = storageRef(storage, path)
      await uploadBytes(r, blob, { contentType: 'audio/webm' })
      const url = await getDownloadURL(r); setVoiceUrl(url)
      setStatus('Transcribing...')
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve) => { reader.onloadend = () => resolve((reader.result as string).split(',')[1]) })
      reader.readAsDataURL(blob)
      const audioBase64 = await base64Promise
      const transcribeFn = httpsCallable<{ audio: string; mimeType?: string }, { transcription: string }>(functions, 'transcribeWorkoutVoice')
      const { data: { transcription } } = await transcribeFn({ audio: audioBase64, mimeType: 'audio/webm' })
      const newText = transcription ? (text.trim() ? `\${text.trim()}\n\n\${transcription}` : transcription) : text.trim()
      if (transcription) setText(newText)
      await updateDoc(workoutRef, { context: { text: newText, tags: selectedTags, voiceUrl: url, updatedAt: serverTimestamp() } })
      setStatus('Voice attached'); setRecording(false)
    } catch (e) { setError(String(e)) } finally { setUploading(false); setRecording(false) }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <label className="field">
        <span>Workout Context</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Pain, sleep, or energy notes..." rows={3} />
      </label>

      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="rec-label">Tags</span>
          <span className="muted small">{selectedTags.length}/{MAX_SELECTED_TAGS}</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {uniqueTags([...selectedTags, ...suggestedTags]).map((tag) => {
            const active = selectedTags.some((t) => t.toLowerCase() === tag.toLowerCase())
            return (
              <button key={tag} className="secondary small" style={{ padding: '4px 10px', fontSize: '0.7rem', background: active ? 'var(--accent)' : 'var(--surface-2)', color: active ? 'white' : 'var(--text)', borderColor: active ? 'var(--accent)' : 'var(--border)' }} onClick={() => toggleTag(tag)}>
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      <div className="row">
        <button className="primary" style={{ flex: 1 }} onClick={() => void saveText()} disabled={saving}>
          {saving ? '...' : 'Save Context'}
        </button>
        {!recording ? (
          <button className="secondary" onClick={() => void startRecording()}>Record Voice</button>
        ) : (
          <button className="primary" style={{ background: 'var(--error)' }} onClick={() => void stopAndUpload()} disabled={uploading}>
            {uploading ? '...' : 'Stop + Attach'}
          </button>
        )}
      </div>
      {status && <p className="muted" style={{ textAlign: 'center', fontSize: '11px' }}>{status}</p>}
      {error && <p className="error" style={{ textAlign: 'center', fontSize: '11px' }}>{error}</p>}
    </div>
  )
}
