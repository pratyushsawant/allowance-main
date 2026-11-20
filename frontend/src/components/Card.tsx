import type { ReactNode } from "react";

// A white surface with a plain sentence-case heading and an optional right-side aside.
export function Card({
  title,
  icon,
  aside,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[22px] border border-line bg-surface p-5 ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <PanelTitle icon={icon}>{title}</PanelTitle>
        {aside && <div className="text-sm text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

// Panel heading with a small tinted icon tile; shared by every dashboard panel.
export function PanelTitle({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em]">
      {icon && <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-pine-soft text-pine">{icon}</span>}
      {children}
    </h2>
  );
}
