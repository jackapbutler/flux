// Types for Flux
import type { Timestamp } from 'firebase/firestore'

export type UserProfile = {
  goalText?: string
  workoutEnvironmentConstraintsText?: string
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
    tags?: string[]
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
  mainSet: string
  why: string[]
  type?: string
}

export type RecommendationResponse = {
  options: WorkoutOption[]
  safetyChecks?: string[]
}

export type SavedWorkout = {
  id: string
  option: WorkoutOption
  source?: string
  savedAt?: Timestamp
}
