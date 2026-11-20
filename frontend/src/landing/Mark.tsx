// The Allowance logo: a coin dropping into an open hand ("money you hand over").
// Pass `size` for a fixed pixel size, or `className` to size it with CSS.
export function Mark({ size = 26, light = false, className }: { size?: number; light?: boolean; className?: string }) {
  return (
    <svg
      width={className ? undefined : size}
      height={className ? undefined : size}
      viewBox="0 0 28 28"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 15a11 11 0 0 0 22 0" fill="none" stroke={light ? "#fff" : "var(--color-pine)"} strokeWidth="3" strokeLinecap="round" />
      <circle cx="14" cy="9" r="6" fill={light ? "#fff" : "var(--color-usdc)"} />
    </svg>
  );
}
