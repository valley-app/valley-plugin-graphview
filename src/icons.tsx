import { React } from './runtime'
import type { ReactElement, ReactNode } from 'react'

/**
 * Inline SVG icons (Lucide-style, drawn with the host's React) — same pattern
 * as sideNotes/src/icons.tsx. Emoji glyphs (✎ 🗑 …) render as colored emoji on
 * macOS and clash with the app chrome; these stay monochrome via currentColor.
 */
type IconProps = { className?: string; title?: string }

const Svg = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    {
      className: props.className,
      width: '1em',
      height: '1em',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    },
    props.title ? <title>{props.title}</title> : null,
    props.children
  )

export const Plus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
)

export const Minus = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M5 12h14" /></Svg>
)

export const X = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>
)

export const Check = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
)

export const Filter = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="M3 5h18l-7 8v6l-4 2v-8z" /></Svg>
)

export const Groups = (p: IconProps): ReactElement => (
  <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M17.5 14v7M14 17.5h7" /></Svg>
)

export const GripVertical = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="9" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none" /></Svg>
)

export const Eye = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const ChevronDown = (p: IconProps): ReactElement => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
)

export const Copy = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
)

export const PinOff = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="m2 2 20 20" />
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 5 4 4v2" />
    <path d="M5 14h9" />
  </Svg>
)

export const ExternalLink = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
)

export const FolderOpen = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M6 14.5 4 21h15.5a2 2 0 0 0 1.9-1.4l1.6-5.1H6z" />
    <path d="M2 19V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2" />
  </Svg>
)

export const Search = (p: IconProps): ReactElement => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
)

export const Realm = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 9V7M12 17v-2M9 12H7M17 12h-2" />
  </Svg>
)

export const GraphIcon = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </Svg>
)

export const History = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </Svg>
)

export const Pencil = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
    <path d="m15 5 4 4" />
  </Svg>
)

export const CopyPlus = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M15 12v6M12 15h6" />
    <rect x="8" y="8" width="14" height="14" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Svg>
)

export const Trash = (p: IconProps): ReactElement => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2" />
  </Svg>
)

export const LinkDirection = ({ arrows, ...p }: IconProps & { arrows: boolean }): ReactElement => (
  <Svg {...p}><circle cx="4" cy="12" r="2" /><circle cx="20" cy="12" r="2" /><path d="M6 12h12" />{arrows ? <path d="m13 8 4 4-4 4" /> : null}</Svg>
)
