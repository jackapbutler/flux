import type { WorkoutOption } from '../lib/types'
import { WorkoutIcon } from './WorkoutIcon'

type Props = {
  option: WorkoutOption
  index: number
}

function getIntensityColor(intensity: string): string {
  const lower = intensity.toLowerCase()
  if (lower.includes('1') || lower.includes('2') || lower.includes('easy') || lower.includes('low')) {
    return 'var(--success)'
  }
  if (lower.includes('3') || lower.includes('4') || lower.includes('5') || lower.includes('moderate')) {
    return 'var(--accent-2)'
  }
  if (lower.includes('7') || lower.includes('8') || lower.includes('9') || lower.includes('high') || lower.includes('hard')) {
    return 'var(--error)'
  }
  return 'var(--accent)'
}

export function RecommendationCard({ option, index }: Props) {
  const intensityColor = getIntensityColor(option.intensity)

  return (
    <div className="workoutOption">
      <div className="optionHeader">
        <div className="workoutIconWrapper">
          <WorkoutIcon type={option.type} size="medium" />
        </div>
        <div className="headerContent">
          <div className="optionRank">Option {index + 1}</div>
          <h3 className="optionTitle">{option.title}</h3>
        </div>
      </div>

      <div className="optionMetrics">
        <div className="metricSmall">
          <span className="metricLabel">Duration</span>
          <span className="metricValue">{option.duration}</span>
        </div>
        <div className="metricSmall">
          <span className="metricLabel">Intensity</span>
          <span className="metricValue" style={{ color: intensityColor }}>
            {option.intensity}
          </span>
        </div>
      </div>

      <div className="optionSection">
        <div className="sectionLabel">Warmup</div>
        <div className="sectionContent">{option.warmup}</div>
      </div>

      <div className="optionSection">
        <div className="sectionLabel">Main set</div>
        <div className="sectionContent">{option.mainSet}</div>
      </div>

      <div className="optionSection">
        <div className="sectionLabel">Cooldown</div>
        <div className="sectionContent">{option.cooldown}</div>
      </div>

      <div className="optionWhy">
        <div className="sectionLabel">Why this workout</div>
        <ul className="whyList">
          {option.why.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
