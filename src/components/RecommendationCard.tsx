import { WorkoutIcon } from './WorkoutIcon'
import type { WorkoutOption } from '../lib/types'

type Props = {
  option: WorkoutOption
  index: number
  onPass: () => void
  onAccept: () => void
  disabled?: boolean
}

export function RecommendationCard({ option, onPass, onAccept, disabled }: Props) {
  return (
    <div className="rec-card stack">
      <div className="rec-header">
        <div className="rec-icon">
          <WorkoutIcon type={option.type} />
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <h3 style={{ fontSize: '1rem' }}>{option.title}</h3>
          <div className="badge">{option.type || 'Workout'}</div>
        </div>
      </div>

      <div className="rec-metrics">
        <div className="rec-metric">
          <div className="rec-label">Duration</div>
          <div className="rec-value">{option.duration}</div>
        </div>
        <div className="rec-metric">
          <div className="rec-label">Intensity</div>
          <div className="rec-value">{option.intensity}</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="rec-label">Main Set</div>
        <div className="sectionContent" style={{ fontSize: '0.875rem' }}>{option.mainSet}</div>
      </div>

      {option.why && option.why.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="rec-label">Coach's Note</div>
          <ul className="whyList" style={{ margin: 0 }}>
            {option.why.map((reason, i) => (
              <li key={i} style={{ color: 'var(--text)', fontSize: '0.8125rem' }}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button 
          className="primary" 
          style={{ flex: 1 }} 
          onClick={onAccept} 
          disabled={disabled}
        >
          Accept Plan
        </button>
        <button 
          className="secondary" 
          onClick={onPass} 
          disabled={disabled}
        >
          Pass
        </button>
      </div>
    </div>
  )
}
