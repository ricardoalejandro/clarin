export type CatMood = 'idle' | 'thinking' | 'typing' | 'happy' | 'greeting' |
  'playing_ball' | 'sleeping' | 'stretching' | 'washing' |
  'chasing_tail' | 'looking_left' | 'looking_right' | 'yawning' |
  'pawing' | 'jumping' | 'winking' | 'curious' | 'excited' |
  'love' | 'studying' | 'fishing' | 'dancing' | 'meowing' |
  'stargazing' | 'walking' | 'walking_ball'

interface ErosCatProps {
  mood: CatMood
  size?: number
  direction?: 'front' | 'side'
}

/* ───── Side-view cat component ───── */
function SideViewCat({ mood, size }: { mood: CatMood; size: number }) {
  const isWalking = mood === 'walking' || mood === 'walking_ball'
  const eyesClosed = mood === 'sleeping' || mood === 'washing' || mood === 'yawning'
  const eyesHappy = mood === 'happy' || mood === 'greeting' || mood === 'excited' || mood === 'love'
  const isBig = mood === 'excited' || mood === 'curious'

  const tailSpeed = mood === 'happy' || mood === 'greeting' || mood === 'excited' || mood === 'dancing'
    ? '0.4s' : mood === 'idle' || mood === 'curious' ? '2.5s' : isWalking ? '0.6s' : undefined
  const breatheSpeed = mood === 'idle' || mood === 'sleeping' ? '3s' : mood === 'thinking' ? '1.5s' : undefined

  return (
    <svg viewBox="0 0 140 130" width={size} height={size} xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: 'visible', filter: 'drop-shadow(0px 2px 4px rgba(100, 116, 139, 0.25))' }}>
      <g style={{
        transformOrigin: '70px 65px',
        animation: mood === 'jumping' ? 'eros-hop 0.6s ease-in-out infinite'
          : mood === 'dancing' ? 'eros-sway 0.5s ease-in-out infinite'
          : isWalking ? 'eros-walk-bob 0.5s ease-in-out infinite'
          : undefined,
      }}>
        {/* Tail — curves up and back */}
        <path
          d="M 20 72 Q 8 55 12 38 Q 15 28 22 32"
          stroke="#e2e8f0" strokeWidth="7" strokeLinecap="round" fill="none"
          style={{
            transformOrigin: '20px 72px',
            animation: tailSpeed ? `eros-side-tail ${tailSpeed} ease-in-out infinite` : undefined,
          }}
        />

        {/* Body — elongated ellipse, cat seen from side */}
        <ellipse cx="58" cy="78" rx="38" ry="22" fill="white" stroke="#e2e8f0" strokeWidth="1.5"
          style={{
            transformOrigin: '58px 78px',
            animation: breatheSpeed ? `eros-breathe ${breatheSpeed} ease-in-out infinite` : undefined,
          }}
        />
        {/* Belly */}
        <ellipse cx="58" cy="84" rx="22" ry="10" fill="#f8fafc" />

        {/* Back legs (behind body) */}
        {isWalking ? (
          <g>
            <ellipse cx="32" cy="100" rx="5" ry="3" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cy" values="100;96;100" dur="0.5s" repeatCount="indefinite" />
              <animate attributeName="cx" values="32;28;32" dur="0.5s" repeatCount="indefinite" />
            </ellipse>
            <ellipse cx="40" cy="100" rx="5" ry="3" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cy" values="100;96;100" dur="0.5s" begin="0.25s" repeatCount="indefinite" />
              <animate attributeName="cx" values="40;36;40" dur="0.5s" begin="0.25s" repeatCount="indefinite" />
            </ellipse>
          </g>
        ) : mood !== 'jumping' && (
          <g>
            <ellipse cx="34" cy="100" rx="5" ry="3" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="1" />
            <ellipse cx="42" cy="100" rx="5" ry="3" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="1" />
          </g>
        )}

        {/* Front legs */}
        {isWalking ? (
          <g>
            <ellipse cx="72" cy="100" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cy" values="100;96;100" dur="0.5s" begin="0.12s" repeatCount="indefinite" />
              <animate attributeName="cx" values="72;76;72" dur="0.5s" begin="0.12s" repeatCount="indefinite" />
            </ellipse>
            <ellipse cx="80" cy="100" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cy" values="100;96;100" dur="0.5s" begin="0.37s" repeatCount="indefinite" />
              <animate attributeName="cx" values="80;84;80" dur="0.5s" begin="0.37s" repeatCount="indefinite" />
            </ellipse>
          </g>
        ) : mood === 'jumping' ? (
          <g>
            <ellipse cx="72" cy="96" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1" />
            <ellipse cx="80" cy="96" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1" />
          </g>
        ) : (
          <g>
            <ellipse cx="72" cy="100" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1" />
            <ellipse cx="80" cy="100" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1" />
          </g>
        )}

        {/* Ear (single visible from side) */}
        <polygon
          points="80,30 72,10 90,22"
          fill="white" stroke="#e2e8f0" strokeWidth="1.5" strokeLinejoin="round"
          style={{
            transformOrigin: '80px 30px',
            animation: mood === 'greeting' || mood === 'curious'
              ? 'eros-wave 0.5s ease-in-out infinite alternate' : undefined,
          }}
        />
        <polygon points="81,29 76,16 87,24" fill="#fecdd3" />

        {/* Head — profile circle, shifted right */}
        <g style={{
          transformOrigin: '85px 50px',
          transform: mood === 'curious' ? 'rotate(8deg)' : undefined,
        }}>
          <ellipse cx="85" cy="50" rx="22" ry="20" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />

          {/* Eye — single visible */}
          {eyesClosed ? (
            <ellipse cx="92" cy="48" rx={isBig ? 6 : 5} ry="0.5" fill="#059669" />
          ) : eyesHappy ? (
            <ellipse cx="92" cy="48" rx={isBig ? 6 : 5} ry="3" fill="#059669"
              style={{ transformOrigin: '92px 48px', animation: 'eros-blink 4s ease-in-out infinite' }}
            />
          ) : (
            <g>
              <ellipse cx="92" cy="48" rx={isBig ? 6.5 : 5.5} ry={isBig ? 6 : 5} fill="#059669"
                style={{ transformOrigin: '92px 48px', animation: mood === 'idle' ? 'eros-blink 4s ease-in-out infinite' : undefined }}
              />
              <ellipse cx="93" cy="48" rx={mood === 'thinking' ? 1.5 : isBig ? 3 : 2.5}
                ry={isBig ? 4.5 : 3.5} fill="#0f172a"
                style={{ transformOrigin: '92px 48px', animation: mood === 'idle' ? 'eros-blink 4s ease-in-out infinite' : undefined }}
              />
              <circle cx="94" cy="46" r="1" fill="white" />
            </g>
          )}

          {/* Nose — side profile triangle */}
          <polygon points="107,54 103,57 103,51" fill="#fb7185" />

          {/* Mouth */}
          {mood === 'yawning' || mood === 'meowing' ? (
            <ellipse cx="104" cy="59" rx="3" ry="2.5" fill="#fda4af" stroke="#94a3b8" strokeWidth="0.8" />
          ) : eyesHappy ? (
            <path d="M 101 58 Q 104 61 107 58" stroke="#94a3b8" strokeWidth="1" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M 101 58 Q 104 60 107 58" stroke="#94a3b8" strokeWidth="1" fill="none" strokeLinecap="round" />
          )}

          {/* Whiskers — only the side ones */}
          <line x1="107" y1="52" x2="125" y2="49" stroke="#cbd5e1" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="107" y1="55" x2="126" y2="55" stroke="#cbd5e1" strokeWidth="0.8" strokeLinecap="round" />
          <line x1="107" y1="58" x2="125" y2="61" stroke="#cbd5e1" strokeWidth="0.8" strokeLinecap="round" />

          {/* Blush */}
          {eyesHappy && (
            <ellipse cx="96" cy="55" rx="5" ry="3" fill="#fda4af" opacity="0.35" />
          )}
        </g>

        {/* Thinking dots */}
        {mood === 'thinking' && (
          <g>
            <circle cx="110" cy="32" r="2" fill="#059669" opacity="0.4">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0s" repeatCount="indefinite" />
            </circle>
            <circle cx="117" cy="26" r="2.5" fill="#059669" opacity="0.6">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0.3s" repeatCount="indefinite" />
            </circle>
            <circle cx="125" cy="20" r="3" fill="#059669" opacity="0.8">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0.6s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Sleeping Zzz */}
        {mood === 'sleeping' && (
          <g>
            <text x="105" y="30" fontSize="10" fill="#059669" fontWeight="bold" opacity="0.6">
              <animate attributeName="opacity" values="0.6;0;0.6" dur="2.5s" repeatCount="indefinite" />
              <animate attributeName="y" values="30;20" dur="2.5s" repeatCount="indefinite" />
              Z
            </text>
            <text x="115" y="22" fontSize="8" fill="#059669" fontWeight="bold" opacity="0.4">
              <animate attributeName="opacity" values="0.4;0;0.4" dur="2.5s" begin="0.8s" repeatCount="indefinite" />
              <animate attributeName="y" values="22;12" dur="2.5s" begin="0.8s" repeatCount="indefinite" />
              z
            </text>
          </g>
        )}

        {/* Love hearts */}
        {mood === 'love' && (
          <g>
            <text x="108" y="28" fontSize="11" opacity="0.8">
              <animate attributeName="y" values="28;14" dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="1.5s" repeatCount="indefinite" />
              ❤️
            </text>
            <text x="118" y="34" fontSize="9" opacity="0.6">
              <animate attributeName="y" values="34;20" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              💕
            </text>
          </g>
        )}

        {/* Studying glasses */}
        {mood === 'studying' && (
          <g>
            <circle cx="92" cy="48" r="7" fill="none" stroke="#64748b" strokeWidth="1.5" />
            <line x1="85" y1="47" x2="76" y2="44" stroke="#64748b" strokeWidth="1.5" />
            <rect x="60" y="96" width="25" height="10" rx="2" fill="#93c5fd" stroke="#60a5fa" strokeWidth="1" />
            <line x1="72" y1="96" x2="72" y2="106" stroke="#60a5fa" strokeWidth="1" />
          </g>
        )}

        {/* Playing ball */}
        {mood === 'playing_ball' && (
          <circle cx="110" cy="95" r="6" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1">
            <animate attributeName="cy" values="95;86;95" dur="0.8s" repeatCount="indefinite" />
          </circle>
        )}

        {/* Walking ball */}
        {mood === 'walking_ball' && (
          <g>
            <circle cx="110" cy="98" r="7" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1">
              <animate attributeName="cx" values="110;118;110" dur="0.8s" repeatCount="indefinite" />
            </circle>
            <circle cx="110" cy="96" r="2" fill="#f59e0b" opacity="0.4">
              <animate attributeName="cx" values="110;118;110" dur="0.8s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Meowing waves */}
        {mood === 'meowing' && (
          <g>
            <circle cx="107" cy="56" r="0" fill="none" stroke="#059669" strokeWidth="0.8" opacity="0">
              <animate attributeName="r" values="0;12" dur="1s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0" dur="1s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Stargazing */}
        {mood === 'stargazing' && (
          <g>
            <text x="30" y="12" fontSize="8" opacity="0.3">
              <animate attributeName="opacity" values="0.3;1;0.3" dur="1.5s" repeatCount="indefinite" />
              ⭐
            </text>
            <text x="60" y="5" fontSize="10" opacity="0.5">
              <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              ✨
            </text>
            <text x="100" y="10" fontSize="7" opacity="0.4">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" begin="1s" repeatCount="indefinite" />
              ⭐
            </text>
          </g>
        )}

        {/* Fishing */}
        {mood === 'fishing' && (
          <g>
            <line x1="98" y1="42" x2="120" y2="18" stroke="#92400e" strokeWidth="2" strokeLinecap="round" />
            <path d="M120 18 Q125 30 120 45" stroke="#94a3b8" strokeWidth="0.8" fill="none" strokeDasharray="2,2">
              <animate attributeName="d" values="M120 18 Q125 30 120 45;M120 18 Q128 28 120 45;M120 18 Q125 30 120 45" dur="2s" repeatCount="indefinite" />
            </path>
            <text x="116" y="50" fontSize="8">🐟</text>
          </g>
        )}

        {/* Pawing */}
        {mood === 'pawing' && (
          <ellipse cx="88" cy="96" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
            <animate attributeName="cy" values="96;89;96" dur="0.7s" repeatCount="indefinite" />
            <animate attributeName="cx" values="88;92;88" dur="0.7s" repeatCount="indefinite" />
          </ellipse>
        )}
      </g>
    </svg>
  )
}

/* ───── Front-view cat component (original) ───── */
export default function ErosCat({ mood, size = 80, direction = 'front' }: ErosCatProps) {
  if (direction === 'side') return <SideViewCat mood={mood} size={size} />
  const isWalking = mood === 'walking' || mood === 'walking_ball'
  const eyesClosed = mood === 'sleeping' || mood === 'washing' || mood === 'yawning'
  const eyesSquint = mood === 'happy' || mood === 'winking'
  const lookLeft = mood === 'looking_left' || mood === 'curious'
  const lookRight = mood === 'looking_right' || isWalking
  const lookUp = mood === 'stargazing'
  const bigEyes = mood === 'excited' || mood === 'curious'

  const leftEyeRy = eyesClosed ? 0.5 : eyesSquint ? 3 : bigEyes ? 6.5 : 5.5
  const rightEyeRy = eyesClosed ? 0.5 : (mood === 'winking' ? 0.5 : eyesSquint ? 3 : bigEyes ? 6.5 : 5.5)

  const pupilCxOffset = lookLeft ? -3 : lookRight ? 3 : lookUp ? 0 : 0
  const pupilCyOffset = lookUp ? -3 : 0

  const tailSpeed = mood === 'happy' || mood === 'greeting' || mood === 'excited' || mood === 'dancing'
    ? '0.4s' : mood === 'idle' || mood === 'curious' ? '2.5s' : isWalking ? '0.6s' : undefined

  const breatheSpeed = mood === 'idle' || mood === 'sleeping'
    ? '3s' : mood === 'thinking' ? '1.5s' : mood === 'stretching' ? '1.8s' : undefined

  return (
    <svg
      viewBox="0 0 120 140"
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: 'visible', filter: 'drop-shadow(0px 2px 4px rgba(100, 116, 139, 0.25))' }}
    >
      <g style={{
        transformOrigin: '60px 70px',
        animation: mood === 'chasing_tail' ? 'eros-spin 2s linear infinite'
          : mood === 'jumping' ? 'eros-hop 0.6s ease-in-out infinite'
          : mood === 'dancing' ? 'eros-sway 0.5s ease-in-out infinite'
          : isWalking ? 'eros-walk-bob 0.5s ease-in-out infinite'
          : undefined,
      }}>
        {/* Tail */}
        <path
          d="M 38 105 Q 15 115 18 128 Q 24 135 32 128 Q 36 120 40 112"
          stroke="#e2e8f0"
          strokeWidth="7"
          strokeLinecap="round"
          fill="none"
          style={{
            transformOrigin: '38px 105px',
            animation: tailSpeed ? `eros-tail ${tailSpeed} ease-in-out infinite` : undefined,
          }}
        />

        {/* Body */}
        <ellipse
          cx="60"
          cy="95"
          rx="32"
          ry="28"
          fill="white"
          stroke="#e2e8f0"
          strokeWidth="1.5"
          style={{
            transformOrigin: '60px 95px',
            animation: breatheSpeed ? `eros-breathe ${breatheSpeed} ease-in-out infinite`
              : mood === 'stretching' ? 'eros-stretch 2s ease-in-out infinite'
              : undefined,
          }}
        />

        {/* Belly patch */}
        <ellipse cx="60" cy="100" rx="16" ry="14" fill="#f8fafc" />

        {/* Left ear */}
        <polygon
          points="30,45 22,20 44,38"
          fill="white"
          stroke="#e2e8f0"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <polygon points="31,43 26,26 41,39" fill="#fecdd3" />

        {/* Right ear */}
        <polygon
          points="90,45 98,20 76,38"
          fill="white"
          stroke="#e2e8f0"
          strokeWidth="1.5"
          strokeLinejoin="round"
          style={{
            transformOrigin: '87px 40px',
            animation: mood === 'greeting' || mood === 'curious'
              ? 'eros-wave 0.5s ease-in-out infinite alternate' : undefined,
          }}
        />
        <polygon points="89,43 94,26 79,39" fill="#fecdd3" />

        {/* Head */}
        <g style={{
          transformOrigin: '60px 57px',
          transform: mood === 'curious' ? 'rotate(10deg)' : undefined,
        }}>
          <ellipse cx="60" cy="57" rx="30" ry="26" fill="white" stroke="#e2e8f0" strokeWidth="1.5" />

          {/* Left eye */}
          <ellipse cx="48" cy="54" rx={bigEyes ? 7 : 6} ry={leftEyeRy} fill="#059669"
            style={{
              transformOrigin: '48px 54px',
              animation: (mood === 'idle' || mood === 'happy') ? 'eros-blink 4s ease-in-out infinite' : undefined,
            }}
          />
          <ellipse cx={48 + pupilCxOffset} cy={54 + pupilCyOffset}
            rx={mood === 'thinking' ? 1.5 : bigEyes ? 3 : 2.5}
            ry={eyesClosed ? 0.3 : mood === 'happy' ? 2 : bigEyes ? 5 : 4} fill="#0f172a"
            style={{
              transformOrigin: '48px 54px',
              animation: (mood === 'idle' || mood === 'happy') ? 'eros-blink 4s ease-in-out infinite' : undefined,
            }}
          />
          <circle cx="50" cy="51" r="1.2" fill="white" opacity={eyesClosed ? 0 : 1} />

          {/* Right eye */}
          <ellipse cx="72" cy="54" rx={bigEyes ? 7 : 6} ry={rightEyeRy} fill="#059669"
            style={{
              transformOrigin: '72px 54px',
              animation: (mood === 'idle' || mood === 'happy') ? 'eros-blink 4s ease-in-out infinite' : undefined,
            }}
          />
          <ellipse cx={72 + pupilCxOffset} cy={54 + pupilCyOffset}
            rx={mood === 'thinking' ? 1.5 : bigEyes ? 3 : 2.5}
            ry={mood === 'winking' ? 0.3 : eyesClosed ? 0.3 : mood === 'happy' ? 2 : bigEyes ? 5 : 4} fill="#0f172a"
            style={{
              transformOrigin: '72px 54px',
              animation: (mood === 'idle' || mood === 'happy') ? 'eros-blink 4s ease-in-out infinite' : undefined,
            }}
          />
          <circle cx="74" cy="51" r="1.2" fill="white" opacity={eyesClosed || mood === 'winking' ? 0 : 1} />

          {/* Nose */}
          <polygon points="60,62 57,66 63,66" fill="#fb7185" />

          {/* Mouth */}
          {mood === 'yawning' || mood === 'meowing' ? (
            <ellipse cx="60" cy="70" rx="5" ry="4" fill="#fda4af" stroke="#94a3b8" strokeWidth="0.8" />
          ) : mood === 'happy' || mood === 'greeting' || mood === 'excited' || mood === 'love' ? (
            <path d="M 57 67 Q 60 71 63 67" stroke="#94a3b8" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M 57 67 Q 60 70 63 67" stroke="#94a3b8" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          )}

          {/* Whiskers */}
          <line x1="30" y1="63" x2="52" y2="65" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <line x1="28" y1="66" x2="52" y2="67" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <line x1="30" y1="70" x2="52" y2="69" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <line x1="90" y1="63" x2="68" y2="65" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <line x1="92" y1="66" x2="68" y2="67" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />
          <line x1="90" y1="70" x2="68" y2="69" stroke="#cbd5e1" strokeWidth="1" strokeLinecap="round" />

          {/* Blush cheeks */}
          {(mood === 'happy' || mood === 'greeting' || mood === 'love' || mood === 'excited') && (
            <>
              <ellipse cx="40" cy="66" rx="7" ry="4" fill="#fda4af" opacity="0.4" />
              <ellipse cx="80" cy="66" rx="7" ry="4" fill="#fda4af" opacity="0.4" />
            </>
          )}
        </g>

        {/* Thinking dots */}
        {mood === 'thinking' && (
          <g>
            <circle cx="82" cy="40" r="2" fill="#059669" opacity="0.4">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0s" repeatCount="indefinite" />
            </circle>
            <circle cx="89" cy="36" r="2.5" fill="#059669" opacity="0.6">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0.3s" repeatCount="indefinite" />
            </circle>
            <circle cx="97" cy="31" r="3" fill="#059669" opacity="0.8">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="0.8s" begin="0.6s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Typing indicator */}
        {mood === 'typing' && (
          <g>
            <circle cx="48" cy="128" r="4" fill="#059669" opacity="0.6">
              <animate attributeName="cy" values="128;122;128" dur="0.6s" begin="0s" repeatCount="indefinite" />
            </circle>
            <circle cx="60" cy="128" r="4" fill="#059669" opacity="0.6">
              <animate attributeName="cy" values="128;122;128" dur="0.6s" begin="0.2s" repeatCount="indefinite" />
            </circle>
            <circle cx="72" cy="128" r="4" fill="#059669" opacity="0.6">
              <animate attributeName="cy" values="128;122;128" dur="0.6s" begin="0.4s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Sleeping Zzz */}
        {mood === 'sleeping' && (
          <g>
            <text x="80" y="38" fontSize="10" fill="#059669" fontWeight="bold" opacity="0.6">
              <animate attributeName="opacity" values="0.6;0;0.6" dur="2.5s" repeatCount="indefinite" />
              <animate attributeName="y" values="38;28" dur="2.5s" repeatCount="indefinite" />
              Z
            </text>
            <text x="90" y="30" fontSize="8" fill="#059669" fontWeight="bold" opacity="0.4">
              <animate attributeName="opacity" values="0.4;0;0.4" dur="2.5s" begin="0.8s" repeatCount="indefinite" />
              <animate attributeName="y" values="30;20" dur="2.5s" begin="0.8s" repeatCount="indefinite" />
              z
            </text>
            <text x="97" y="24" fontSize="6" fill="#059669" fontWeight="bold" opacity="0.3">
              <animate attributeName="opacity" values="0.3;0;0.3" dur="2.5s" begin="1.6s" repeatCount="indefinite" />
              <animate attributeName="y" values="24;14" dur="2.5s" begin="1.6s" repeatCount="indefinite" />
              z
            </text>
          </g>
        )}

        {/* Playing ball */}
        {mood === 'playing_ball' && (
          <circle cx="90" cy="115" r="6" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1">
            <animate attributeName="cy" values="115;105;115" dur="0.8s" repeatCount="indefinite" />
          </circle>
        )}

        {/* Washing paw */}
        {mood === 'washing' && (
          <ellipse cx="52" cy="55" rx="4" ry="8" fill="white" stroke="#e2e8f0" strokeWidth="1">
            <animate attributeName="cy" values="55;50;55" dur="1s" repeatCount="indefinite" />
          </ellipse>
        )}

        {/* Love hearts */}
        {mood === 'love' && (
          <g>
            <text x="82" y="35" fontSize="12" opacity="0.8">
              <animate attributeName="y" values="35;20" dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.8;0" dur="1.5s" repeatCount="indefinite" />
              ❤️
            </text>
            <text x="72" y="30" fontSize="10" opacity="0.6">
              <animate attributeName="y" values="30;15" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              💕
            </text>
            <text x="90" y="40" fontSize="9" opacity="0.7">
              <animate attributeName="y" values="40;25" dur="1.5s" begin="1s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0" dur="1.5s" begin="1s" repeatCount="indefinite" />
              💖
            </text>
          </g>
        )}

        {/* Studying glasses */}
        {mood === 'studying' && (
          <g>
            <circle cx="48" cy="54" r="8" fill="none" stroke="#64748b" strokeWidth="1.5" />
            <circle cx="72" cy="54" r="8" fill="none" stroke="#64748b" strokeWidth="1.5" />
            <line x1="56" y1="54" x2="64" y2="54" stroke="#64748b" strokeWidth="1.5" />
            <line x1="40" y1="52" x2="30" y2="48" stroke="#64748b" strokeWidth="1.5" />
            <line x1="80" y1="52" x2="90" y2="48" stroke="#64748b" strokeWidth="1.5" />
            {/* Book */}
            <rect x="45" y="118" width="30" height="12" rx="2" fill="#93c5fd" stroke="#60a5fa" strokeWidth="1" />
            <line x1="60" y1="118" x2="60" y2="130" stroke="#60a5fa" strokeWidth="1" />
          </g>
        )}

        {/* Fishing rod */}
        {mood === 'fishing' && (
          <g>
            <line x1="85" y1="45" x2="100" y2="20" stroke="#92400e" strokeWidth="2" strokeLinecap="round" />
            <path d="M100 20 Q105 35 100 50" stroke="#94a3b8" strokeWidth="0.8" fill="none" strokeDasharray="2,2">
              <animate attributeName="d" values="M100 20 Q105 35 100 50;M100 20 Q108 30 100 50;M100 20 Q105 35 100 50" dur="2s" repeatCount="indefinite" />
            </path>
            <text x="96" y="55" fontSize="8">🐟</text>
          </g>
        )}

        {/* Meowing sound waves */}
        {mood === 'meowing' && (
          <g>
            <circle cx="60" cy="70" r="0" fill="none" stroke="#059669" strokeWidth="0.8" opacity="0">
              <animate attributeName="r" values="0;15" dur="1s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0" dur="1s" repeatCount="indefinite" />
            </circle>
            <circle cx="60" cy="70" r="0" fill="none" stroke="#059669" strokeWidth="0.8" opacity="0">
              <animate attributeName="r" values="0;15" dur="1s" begin="0.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0" dur="1s" begin="0.5s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* Stargazing stars */}
        {mood === 'stargazing' && (
          <g>
            <text x="20" y="15" fontSize="8" opacity="0.3">
              <animate attributeName="opacity" values="0.3;1;0.3" dur="1.5s" repeatCount="indefinite" />
              ⭐
            </text>
            <text x="50" y="8" fontSize="10" opacity="0.5">
              <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" begin="0.5s" repeatCount="indefinite" />
              ✨
            </text>
            <text x="85" y="12" fontSize="7" opacity="0.4">
              <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" begin="1s" repeatCount="indefinite" />
              ⭐
            </text>
          </g>
        )}

        {/* Pawing animation */}
        {mood === 'pawing' && (
          <ellipse cx="75" cy="112" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
            <animate attributeName="cy" values="112;105;112" dur="0.7s" repeatCount="indefinite" />
          </ellipse>
        )}

        {/* Walking legs */}
        {isWalking && (
          <g>
            {/* Left front paw */}
            <ellipse cx="48" cy="120" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cx" values="48;42;48" dur="0.5s" repeatCount="indefinite" />
              <animate attributeName="cy" values="120;117;120" dur="0.5s" repeatCount="indefinite" />
            </ellipse>
            {/* Right front paw */}
            <ellipse cx="72" cy="120" rx="5" ry="3" fill="white" stroke="#e2e8f0" strokeWidth="1">
              <animate attributeName="cx" values="72;78;72" dur="0.5s" repeatCount="indefinite" />
              <animate attributeName="cy" values="120;117;120" dur="0.5s" begin="0.25s" repeatCount="indefinite" />
            </ellipse>
            {/* Left back paw */}
            <ellipse cx="42" cy="122" rx="4" ry="2.5" fill="white" stroke="#e2e8f0" strokeWidth="0.8">
              <animate attributeName="cx" values="42;38;42" dur="0.5s" begin="0.25s" repeatCount="indefinite" />
              <animate attributeName="cy" values="122;119;122" dur="0.5s" begin="0.25s" repeatCount="indefinite" />
            </ellipse>
            {/* Right back paw */}
            <ellipse cx="78" cy="122" rx="4" ry="2.5" fill="white" stroke="#e2e8f0" strokeWidth="0.8">
              <animate attributeName="cx" values="78;82;78" dur="0.5s" repeatCount="indefinite" />
              <animate attributeName="cy" values="122;119;122" dur="0.5s" repeatCount="indefinite" />
            </ellipse>
          </g>
        )}

        {/* Rolling ball while walking */}
        {mood === 'walking_ball' && (
          <g>
            <circle cx="100" cy="120" r="7" fill="#fbbf24" stroke="#f59e0b" strokeWidth="1">
              <animate attributeName="cx" values="100;108;100" dur="0.8s" repeatCount="indefinite" />
            </circle>
            <circle cx="100" cy="118" r="2" fill="#f59e0b" opacity="0.4">
              <animate attributeName="cx" values="100;108;100" dur="0.8s" repeatCount="indefinite" />
              <animate attributeName="r" values="2;3;2" dur="0.8s" repeatCount="indefinite" />
            </circle>
          </g>
        )}
      </g>
    </svg>
  )
}
