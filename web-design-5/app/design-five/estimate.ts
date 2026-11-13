/** Pure pricing model for the estimator. Kept separate from the UI so it is easy to tune. */

export const projectTypes = [
  { id: "system", label: "Design system", weeks: 8, cost: 64, team: "2 design engineers · 1 systems designer" },
  { id: "site", label: "Web platform", weeks: 6, cost: 42, team: "2 design engineers · 1 content engineer" },
  { id: "product", label: "Product interface", weeks: 10, cost: 88, team: "3 design engineers · 1 tech lead" },
  { id: "sprint", label: "Prototype sprint", weeks: 2, cost: 14, team: "1 design engineer · 1 designer" },
] as const;

export const modules = [
  { id: "audit", label: "Codebase & performance audit", weeks: 1, cost: 6 },
  { id: "motion", label: "Motion system", weeks: 1, cost: 9 },
  { id: "cms", label: "CMS integration", weeks: 2, cost: 12 },
  { id: "a11y", label: "WCAG 2.2 AA certification", weeks: 1, cost: 7 },
  { id: "docs", label: "Documentation site", weeks: 1, cost: 8 },
  { id: "training", label: "Team training & pairing", weeks: 0.5, cost: 4 },
] as const;

export const paces = [
  { label: "Steady", time: 1.25, cost: 0.95, note: "Part-time team, lowest cost" },
  { label: "Standard", time: 1, cost: 1, note: "Dedicated team" },
  { label: "Fast-track", time: 0.75, cost: 1.2, note: "Expanded team, parallel tracks" },
] as const;

export type ProjectTypeId = (typeof projectTypes)[number]["id"];
export type ModuleId = (typeof modules)[number]["id"];

export type Estimate = {
  weeksLow: number;
  weeksHigh: number;
  costLow: number;
  costHigh: number;
  team: string;
};

export function estimate(type: ProjectTypeId, selected: ModuleId[], pace: number): Estimate {
  const project = projectTypes.find((item) => item.id === type) ?? projectTypes[0];
  const extras = modules.filter((item) => selected.includes(item.id));
  const speed = paces[pace] ?? paces[1];

  const weeks = (project.weeks + extras.reduce((sum, item) => sum + item.weeks, 0)) * speed.time;
  const cost = (project.cost + extras.reduce((sum, item) => sum + item.cost, 0)) * speed.cost;

  return {
    weeksLow: Math.max(1, Math.floor(weeks * 0.92)),
    weeksHigh: Math.max(2, Math.ceil(weeks * 1.1)),
    costLow: Math.round(cost * 0.92),
    costHigh: Math.round(cost * 1.1),
    team: project.team,
  };
}
