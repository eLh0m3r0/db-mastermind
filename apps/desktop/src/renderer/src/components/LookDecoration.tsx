import { lookById } from '@/lib/looks'
import { useSettings } from '@/store/settings'

/** A small picture for the playful looks (drawn here, no outside artwork). Nothing for the standard ones. */
export function LookDecoration({ size = 20, className }: { size?: number; className?: string }) {
  const look = useSettings((s) => lookById(s.settings?.look))
  const Art = ART[look.id]
  if (!Art) return null
  return (
    <span aria-hidden className={className} data-testid="look-decoration" style={{ display: 'inline-flex', pointerEvents: 'none' }}>
      <Art size={size} />
    </span>
  )
}

type ArtProps = { size: number }

const ART: Record<string, (p: ArtProps) => React.ReactElement> = {
  halloween: ({ size }) => (
    <svg width={size * 1.9} height={size} viewBox="0 0 38 20">
      {/* A bat over a pumpkin. */}
      <path d="M2 5c2-1 3 0 4 1 1-2 2-2 3-2 1 0 2 0 3 2 1-1 2-2 4-1-1 1-2 3-3 3-1-1-2 0-2 1-1-1-1-1-2-1s-1 0-2 1c0-1-1-2-2-1-1 0-2-2-3-3z" fill="#7a5cff" />
      <path d="M28 6c0-1.4 1-2.4 2-2.6" stroke="#5b8a2b" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <ellipse cx="24.5" cy="13" rx="5" ry="6" fill="#ff7518" />
      <ellipse cx="31.5" cy="13" rx="5" ry="6" fill="#ff7518" />
      <ellipse cx="28" cy="13" rx="4.2" ry="6.4" fill="#ff8c3f" />
      <path d="M24 11l2-2.4 1.2 2.4zM29 11l2-2.4 1.2 2.4z" fill="#3a1d05" />
      <path d="M24.5 15c1.4 1.4 2.6 1.6 3.5 0.8 0.9 0.8 2.1 0.6 3.5-0.8-1 2.6-6 2.6-7 0z" fill="#3a1d05" />
    </svg>
  ),
  christmas: ({ size }) => (
    <svg width={size * 1.6} height={size} viewBox="0 0 32 20">
      {/* A snowflake by a little fir tree with a star. */}
      <g stroke="#9cc7e8" strokeWidth="1.2" strokeLinecap="round">
        <path d="M6 4v10M1.7 6.5l8.6 5M1.7 11.5l8.6-5" />
        <path d="M6 4l-1 1M6 4l1 1M6 14l-1-1M6 14l1-1" />
      </g>
      <path d="M23 3l5 6h-2.5l4 5h-3l3.5 4h-14l3.5-4h-3l4-5h-2.5z" fill="#1e7a3c" />
      <rect x="21.8" y="18" width="2.4" height="2" fill="#7a4a1f" />
      <path d="M23 0.4l0.9 1.8 2 0.3-1.4 1.4 0.3 2-1.8-0.9-1.8 0.9 0.3-2-1.4-1.4 2-0.3z" fill="#f2c94c" />
      <circle cx="21" cy="12" r="1" fill="#c0392b" />
      <circle cx="25.5" cy="15.5" r="1" fill="#f2c94c" />
      <circle cx="24" cy="9.5" r="0.9" fill="#c0392b" />
    </svg>
  ),
  medieval: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 20 20">
      {/* A castle tower with a pennant. */}
      <path d="M4 8h12v11H4z" fill="#a8895a" />
      <path d="M3 6h2v2h2V6h2v2h2V6h2v2h2V6h2v3H3z" fill="#8b6a3e" />
      <path d="M8.5 19v-4a1.5 1.5 0 013 0v4z" fill="#3b2a17" />
      <path d="M10 6V1" stroke="#3b2a17" strokeWidth="1" />
      <path d="M10 1l5 1.6L10 4.2z" fill="#a3261b" />
    </svg>
  ),
  fantasy: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 20 20">
      {/* A glowing crystal. */}
      <path d="M10 1l5 6-5 12-5-12z" fill="#8e6bff" />
      <path d="M10 1l5 6h-10z" fill="#b49cff" />
      <path d="M10 7v12l5-12z" fill="#6a4ad6" />
      <path d="M3 3l1 1M17 3l-1 1M2 10h1.5M18 10h-1.5" stroke="#c9a227" strokeWidth="1" strokeLinecap="round" />
    </svg>
  ),
  retro2001: ({ size }) => (
    <svg width={size} height={size} viewBox="0 0 20 20">
      {/* A floppy disk. */}
      <path d="M2 2h13l3 3v13H2z" fill="#245edb" />
      <rect x="5" y="2" width="8" height="5" fill="#d9e3f7" />
      <rect x="10" y="3" width="2" height="3" fill="#245edb" />
      <rect x="4.5" y="10" width="11" height="7" rx="0.5" fill="#ffffff" />
      <path d="M6 12.5h8M6 14.5h6" stroke="#9aa9c7" strokeWidth="0.8" />
    </svg>
  ),
  terminal: ({ size }) => (
    <span className="look-cursor font-mono text-[12px] leading-none" style={{ color: '#33ff66', fontSize: size * 0.65 }}>
      &gt;_
    </span>
  ),
}
