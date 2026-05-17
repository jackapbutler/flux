import { getApps, initializeApp } from 'firebase-admin/app'

export function ensureAdminApp(): void {
  if (getApps().length === 0) {
    initializeApp()
  }
}
