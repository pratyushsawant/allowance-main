// The four spending rules as shown on the landing page: one source for their text and
// icons, used by the rules section (RulesFlow) and the scroll-driven hero.
import { CalendarClock, Hand, Receipt, Store, type LucideIcon } from "lucide-react";

export type RuleMeta = { icon: LucideIcon; title: string; amber?: boolean };

export const RULES: RuleMeta[] = [
  { icon: Store, title: "Only sellers you approve" },
  { icon: Receipt, title: "A limit on every request" },
  { icon: CalendarClock, title: "A daily budget" },
  { icon: Hand, title: "Your OK above an amount", amber: true },
];

import { usd } from "../format";

const usdc = (n: number) => `${usd(n)} USDC`;

// The live value under each rule, in the same order as RULES.
export function ruleValues(r: { sellers: string[]; perRequestCap: number; dailyBudget: number; approvalThreshold: number; spentToday: number }) {
  const left = Math.max(0, r.dailyBudget - r.spentToday);
  return [
    `${r.sellers.length} seller${r.sellers.length === 1 ? "" : "s"}`,
    usdc(r.perRequestCap),
    `${usdc(left)} left of ${usd(r.dailyBudget)}`,
    usdc(r.approvalThreshold),
  ];
}
