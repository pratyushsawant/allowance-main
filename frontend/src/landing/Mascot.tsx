// The Allowance agent mascot (blue robot with a visor, antenna and USDC coin badge).
// One drawing, placed inside an <svg> by the hero's spending-line scene (ScanPath).

// The shapes on their own, for placing inside another <svg>. Drawn in a ~62×64 box.
export function MascotArt({ blink = true }: { blink?: boolean }) {
  return (
    <>
      <line x1="30" y1="4" x2="30" y2="16" stroke="#1d4f91" strokeWidth="3" strokeLinecap="round" />
      <circle cx="30" cy="4" r="5" fill="#2a7dff" className={blink ? "blink" : undefined} />
      <rect x="4" y="16" width="52" height="44" rx="18" fill="#1d4f91" />
      <rect x="11" y="25" width="38" height="20" rx="10" fill="#eaf2ff" />
      <circle cx="23" cy="36" r="3.6" fill="#1247d6" />
      <circle cx="37" cy="36" r="3.6" fill="#1247d6" />
      <path d="M24,51 Q30,55 36,51" fill="none" stroke="#9fc2ff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="53" cy="54" r="8.5" fill="#2775ca" stroke="#fffdf9" strokeWidth="2.5" />
      <text x="53" y="58" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">
        $
      </text>
    </>
  );
}

