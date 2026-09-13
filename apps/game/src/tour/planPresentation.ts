import {
  Camera,
  Eye,
  Orbit,
  Pause,
  Route,
  Volume2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react'
import type { TourCameraMotion } from '@inertialref/protocol'

export const GUIDE_CAMERA_MOTION: Readonly<
  Record<TourCameraMotion, { label: string; icon: LucideIcon }>
> = {
  hold: { label: 'Hold the view', icon: Camera },
  orbit: { label: 'Gentle orbit', icon: Orbit },
  'push-in': { label: 'Move closer', icon: ZoomIn },
  'pull-back': { label: 'Pull back', icon: ZoomOut },
  reveal: { label: 'Reveal the scene', icon: Eye },
}

export interface GuidePlanPhase {
  readonly label: string
  readonly icon: LucideIcon
}

export function guidePlanPhase(
  state: string,
  narration: 'idle' | 'loading' | 'speaking' | 'looking',
): GuidePlanPhase {
  if (state === 'paused') return { label: 'Paused', icon: Pause }
  if (state === 'traveling') return { label: 'Moving into view', icon: Route }
  if (state === 'planning') return { label: 'Revising the tour', icon: Route }
  if (narration === 'speaking') return { label: 'Speaking', icon: Volume2 }
  if (narration === 'loading')
    return { label: 'Preparing the story', icon: Volume2 }
  if (narration === 'looking') return { label: 'Time to look', icon: Eye }
  return { label: 'Taking in the view', icon: Eye }
}

export function guideDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes > 0
    ? `About ${minutes} min`
    : `About ${Math.round(seconds)} sec`
}

export function guideElapsed(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(seconds))
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
}
