import { useRef, useState } from 'react'
import type { WorkoutOption } from '../lib/types'
import { WorkoutIcon } from './WorkoutIcon'

const SWIPE_THRESHOLD = 80
const MAX_DRAG_OFFSET = 160

function clampDragOffset(offset: number): number {
  return Math.max(-MAX_DRAG_OFFSET, Math.min(MAX_DRAG_OFFSET, offset))
}

type Props = {
  option: WorkoutOption
  index: number
  onPass?: () => void
  onAccept?: () => void
  disabled?: boolean
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

export function RecommendationCard({ option, index, onPass, onAccept, disabled }: Props) {
  const intensityColor = getIntensityColor(option.intensity)
  const topReason = option.why.length > 0 ? option.why[0] : undefined
  const overviewPreview = option.mainSet.trim()
  const [dragOffset, setDragOffset] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const isDragging = useRef(false)

  // Calculate rotation and opacity for stamps
  const rotation = (dragOffset / MAX_DRAG_OFFSET) * 10
  const passOpacity = Math.min(1, Math.max(0, -dragOffset / (SWIPE_THRESHOLD * 0.8)))
  const acceptOpacity = Math.min(1, Math.max(0, dragOffset / (SWIPE_THRESHOLD * 0.8)))

  const applySwipe = () => {
    const finalOffset = dragOffset
    touchStartX.current = null
    isDragging.current = false
    
    if (disabled) {
      setDragOffset(0)
      return
    }

    if (finalOffset <= -SWIPE_THRESHOLD && onPass) {
      onPass()
    } else if (finalOffset >= SWIPE_THRESHOLD && onAccept) {
      onAccept()
    }
    
    setDragOffset(0)
  }

  const handleDragStart = (clientX: number) => {
    if (disabled) return
    touchStartX.current = clientX
    isDragging.current = true
  }

  const handleDragMove = (clientX: number) => {
    if (touchStartX.current === null || !isDragging.current || disabled) return
    setDragOffset(clampDragOffset(clientX - touchStartX.current))
  }

  return (
    <div
      className="workoutOption swipeCard"
      style={{
        transform: dragOffset 
          ? `translateX(${dragOffset}px) rotate(${rotation}deg)` 
          : 'translateX(0px) rotate(0deg)',
        transition: isDragging.current 
          ? 'none' 
          : 'transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        cursor: isDragging.current ? 'grabbing' : (onPass || onAccept) ? 'grab' : 'default',
        userSelect: 'none',
        zIndex: isDragging.current ? 100 : 1,
      }}
      onTouchStart={(e) => handleDragStart(e.touches[0]?.clientX ?? 0)}
      onTouchMove={(e) => handleDragMove(e.touches[0]?.clientX ?? 0)}
      onTouchEnd={applySwipe}
      onTouchCancel={() => {
        touchStartX.current = null
        isDragging.current = false
        setDragOffset(0)
      }}
      onMouseDown={(e) => handleDragStart(e.clientX)}
      onMouseMove={(e) => handleDragMove(e.clientX)}
      onMouseUp={applySwipe}
      onMouseLeave={() => {
        if (isDragging.current) applySwipe()
      }}
    >
      <div className="swipeStamp swipeStamp--pass" style={{ opacity: passOpacity }}>
        Pass
      </div>
      <div className="swipeStamp swipeStamp--accept" style={{ opacity: acceptOpacity }}>
        Like
      </div>

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
          <span className="optionMetricLabel">Duration</span>
          <span className="optionMetricValue">{option.duration}</span>
        </div>
        <div className="metricSmall">
          <span className="optionMetricLabel">Intensity</span>
          <span className="optionMetricValue" style={{ color: intensityColor }}>
            {option.intensity}
          </span>
        </div>
      </div>

      <div className="optionSummary">
        <div className="sectionLabel">Overview</div>
        <div className="optionPreview">{overviewPreview}</div>
      </div>

      {topReason ? (
        <div className="optionWhy">
          <div className="sectionLabel">Why this workout</div>
          <p className="whyPreview">{topReason}</p>
        </div>
      ) : null}

      {(onPass || onAccept) && (
        <div className="swipeActions">
          <div className="muted" style={{ fontSize: '12px' }}>
            Swipe left to pass or right to accept
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={onPass} disabled={disabled}>
              Pass
            </button>
            <button type="button" className="primary" onClick={onAccept} disabled={disabled}>
              Accept & save
            </button>
          </div>
        </div>
      )}

      <details className="optionDetails">
        <summary className="optionToggle">View workout details</summary>

        <div className="optionSection">
          <div className="sectionLabel">Main set</div>
          <div className="sectionContent">{option.mainSet}</div>
        </div>

        <div className="optionSection">
          <div className="sectionLabel">Full workout rationale</div>
          <ul className="whyList">
            {option.why.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  )
}
