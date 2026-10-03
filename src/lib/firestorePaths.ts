export const userDocPath = (uid: string) => `users/${uid}`
export const workoutDocPath = (uid: string, workoutId: string) =>
  `users/${uid}/workouts/${workoutId}`
export const workoutsCollectionPath = (uid: string) => `users/${uid}/workouts`
