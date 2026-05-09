import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore'
import { useMemo, useRef, useState } from 'react'
import { db, storage } from '../lib/firebase'

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
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const workoutRef = useMemo(() => doc(db, 'users', uid, 'workouts', workoutId), [uid, workoutId])

  const saveText = async () => {
    try {
      setError(null)
      setSaving(true)
      await updateDoc(workoutRef, {
        context: { text: text.trim(), updatedAt: serverTimestamp() },
      })
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
      setUploading(true)

      const stopped = new Promise<void>((resolve) => {
        mr.onstop = () => resolve()
        mr.stop()
      })
      await stopped

      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      if (blob.size === 0) throw new Error('No audio captured')

      const path = `users/${uid}/workouts/${workoutId}/context-${Date.now()}.webm`
      const r = storageRef(storage, path)
      await uploadBytes(r, blob, { contentType: 'audio/webm' })
      const url = await getDownloadURL(r)

      await updateDoc(workoutRef, {
        context: {
          text: text.trim(),
          voiceUrl: url,
          updatedAt: serverTimestamp(),
        },
      })

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
        <span>How did it feel?</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="E.g. legs heavy, good sleep, windy, slight knee niggle"
        />
      </label>

      <div className="row">
        <button type="button" onClick={() => void saveText()} disabled={saving}>
          {saving ? 'Saving…' : 'Save context'}
        </button>

        {!recording ? (
          <button type="button" className="secondary" onClick={() => void startRecording()}>
            Record voice
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void stopAndUpload()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Stop + attach'}
          </button>
        )}
      </div>

      {error ? <div className="error">{error}</div> : null}
      <p className="muted">Voice notes upload to your Firebase Storage bucket.</p>
    </div>
  )
}
