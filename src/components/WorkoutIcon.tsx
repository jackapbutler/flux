type Props = {
  type?: string | null
  size?: 'small' | 'medium' | 'large'
}

export function WorkoutIcon({ type, size = 'small' }: Props) {
  const iconSize = size === 'small' ? 18 : size === 'medium' ? 24 : 32
  const lower = (type || '').toLowerCase()

  // Thoughtful, simplified iconography
  let icon = '✦' // Default flux spark
  if (lower.includes('run')) icon = '👟'
  if (lower.includes('ride') || lower.includes('bike') || lower.includes('cycling')) icon = '🚲'
  if (lower.includes('swim')) icon = '🏊'
  if (lower.includes('weight') || lower.includes('strength') || lower.includes('lift')) icon = '💪'
  if (lower.includes('yoga') || lower.includes('stretch')) icon = '🧘'
  if (lower.includes('walk')) icon = '🚶'
  if (lower.includes('hike')) icon = '🥾'

  return (
    <div 
      style={{ 
        fontSize: `${iconSize}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1
      }}
      aria-hidden="true"
    >
      {icon}
    </div>
  )
}
