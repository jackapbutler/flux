import { initializeApp, getApp, getApps, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  type Auth,
} from 'firebase/auth'
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore'
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from 'firebase/functions'
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics'
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage'

function required(name: string, value: string | undefined): string {
  if (value == null || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Add it to .env (e.g. VITE_FIREBASE_API_KEY=...) and restart the dev server.`,
    )
  }
  return value
}

const firebaseConfig = {
  apiKey: required('VITE_FIREBASE_API_KEY', import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: required(
    'VITE_FIREBASE_AUTH_DOMAIN',
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  ),
  projectId: required(
    'VITE_FIREBASE_PROJECT_ID',
    import.meta.env.VITE_FIREBASE_PROJECT_ID,
  ),
  storageBucket: required(
    'VITE_FIREBASE_STORAGE_BUCKET',
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  ),
  messagingSenderId: required(
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  ),
  appId: required('VITE_FIREBASE_APP_ID', import.meta.env.VITE_FIREBASE_APP_ID),
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

let app: FirebaseApp
let auth: Auth
let db: Firestore
let functions: Functions
let storage: FirebaseStorage
let analyticsPromise: Promise<Analytics | null> | null = null

function init(): void {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig)
  auth = getAuth(app)
  auth.useDeviceLanguage()
  db = getFirestore(app)
  functions = getFunctions(app, 'us-central1')
  storage = getStorage(app)

  if (import.meta.env.VITE_USE_EMULATORS === 'true') {
    const authHost = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1'
    const authPort = Number(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT ?? '9099')

    const fsHost =
      import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_HOST ?? '127.0.0.1'
    const fsPort = Number(import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT ?? '8080')

    const fnHost = import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1'
    const fnPort = Number(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT ?? '5001')

    const stHost = import.meta.env.VITE_FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1'
    const stPort = Number(import.meta.env.VITE_FIREBASE_STORAGE_EMULATOR_PORT ?? '9199')

    connectAuthEmulator(auth, `http://${authHost}:${authPort}`, {
      disableWarnings: true,
    })
    connectFirestoreEmulator(db, fsHost, fsPort)
    connectFunctionsEmulator(functions, fnHost, fnPort)
    connectStorageEmulator(storage, stHost, stPort)
  }
}

init()

export { app }
export { auth, db, functions, storage }

export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

export function initAnalytics(): Promise<Analytics | null> {
  if (analyticsPromise) return analyticsPromise

  analyticsPromise = (async () => {
    if (!firebaseConfig.measurementId) return null
    if (typeof window === 'undefined') return null

    const ok = await isSupported().catch(() => false)
    if (!ok) return null

    return getAnalytics(app)
  })()

  return analyticsPromise
}
