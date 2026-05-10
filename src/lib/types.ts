// Types for Flux
import type { Timestamp } from 'firebase/firestore'

export type UserProfile = {
  goalText?: string
  fitnessPersonaText?: string
  fitnessPersonaUpdatedAt?: Timestamp
  createdAt?: Timestamp
  updatedAt?: Timestamp
  strava?: {
    connected?: boolean
    athleteId?: number
    lastSyncAt?: Timestamp
  }
}

export type Workout = {
  id: string
  source: 'strava'
  strava: {
    id: number
    type?: string
    name?: string
    startDate?: string
    elapsedTime?: number
    movingTime?: number
    distance?: number
  }
  context?: {
    text?: string
    voiceUrl?: string
    updatedAt?: Timestamp
  }
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

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
}
