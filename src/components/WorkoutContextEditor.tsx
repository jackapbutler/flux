import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useMemo, useRef, useState } from 'react'
import { db, storage, functions } from '../lib/firebase'
import { httpsCallable } from 'firebase/functions'

type Props = {
  uid: string
  workoutId: string
  initialText?: string | null
}

function errorMessage(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message
  }
  return String(err)
}

export function WorkoutContextEditor({ uid, workoutId, initialText }: Props) {
  const [text, setText] = useState(initialText ?? '')
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const workoutRef = useMemo(() => doc(db, 'users', uid, 'workouts', workoutId), [uid, workoutId])

  const saveText = async () => {
    try {
      setError(null)
      setStatus(null)
      setSaving(true)
      await updateDoc(workoutRef, {
        context: { text: text.trim(), updatedAt: serverTimestamp() },
      })

      const fn = httpsCallable(functions, 'buildFitnessPersona')
      await fn()
      setStatus('Context saved')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const startRecording = async () => {
    try {
      setError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []

      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data)
      }

      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
      }

      mr.start()
      mediaRecorderRef.current = mr
      setRecording(true)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const stopAndUpload = async () => {
    const mr = mediaRecorderRef.current
    if (!mr) return

    try {
      setError(null)
      setStatus(null)
      setUploading(true)

      const stopped = new Promise<void>((resolve) => {
        mr.onstop = () => resolve()
        mr.stop()
      })
      await stopped

      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      if (blob.size === 0) throw new Error('No audio captured')
      const mimeType = (blob.type || 'audio/webm').split(';')[0].trim().toLowerCase()

      const path = `users/${uid}/workouts/${workoutId}/context-${Date.now()}.webm`
      const r = storageRef(storage, path)
      await uploadBytes(r, blob, { contentType: mimeType })
      const url = await getDownloadURL(r)

      setStatus('Transcribing...')
      const reader = new FileReader()
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1]
          resolve(base64)
        }
      })
      reader.readAsDataURL(blob)
      const audioBase64 = await base64Promise

      const transcribeFn = httpsCallable<{ audio: string; mimeType?: string }, { transcription: string }>(
        functions,
        'transcribeWorkoutVoice',
      )
      const {
        data: { transcription },
      } = await transcribeFn({ audio: audioBase64, mimeType })

      const newText = transcription
        ? text.trim()
          ? `${text.trim()}\n\n${transcription}`
          : transcription
        : text.trim()

      if (transcription) {
        setText(newText)
      }

      await updateDoc(workoutRef, {
        context: {
          text: newText,
          voiceUrl: url,
          updatedAt: serverTimestamp(),
        },
      })

      const fn = httpsCallable(functions, 'buildFitnessPersona')
      await fn()
      setStatus('Voice context attached')

      setRecording(false)
      mediaRecorderRef.current = null
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setUploading(false)
      setRecording(false)
    }
  }

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <label className="field">
        <span>Workout context</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="How did it feel? Any pain, sleep quality, or energy notes?"
          rows={3}
        />
      </label>

      <div className="row">
        <button type="button" onClick={() => void saveText()} disabled={saving}>
          {saving ? 'Saving...' : 'Save context'}
        </button>

        {!recording ? (
          <button type="button" className="secondary" onClick={() => void startRecording()}>
            Record voice
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void stopAndUpload()} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Stop + attach'}
          </button>
        )}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {status ? <p className="muted">{status}</p> : null}
    </div>
  )
}
