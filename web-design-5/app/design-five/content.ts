export const sheets = [
  { id: "d5-cover", no: "01", title: "Cover" },
  { id: "d5-capabilities", no: "02", title: "Capabilities" },
  { id: "d5-work", no: "03", title: "Selected work" },
  { id: "d5-process", no: "04", title: "Process" },
  { id: "d5-benchmarks", no: "05", title: "Benchmarks" },
  { id: "d5-estimate", no: "06", title: "Estimate" },
  { id: "d5-contact", no: "07", title: "Issue" },
] as const;

export const layers = [
  {
    no: "04",
    name: "Product",
    spec: "Screens, flows and content, assembled from everything below.",
  },
  {
    no: "03",
    name: "Patterns",
    spec: "Navigation, forms, tables, empty states. Documented with rules for use.",
  },
  {
    no: "02",
    name: "Components",
    spec: "Typed, tested, accessible React components with one source of truth.",
  },
  {
    no: "01",
    name: "Tokens",
    spec: "Colour, type, space and motion as data, synced between Figma and code.",
  },
];

export const capabilities = [
  {
    code: "DE-01",
    name: "Design systems",
    text: "Tokens, components and documentation built as a product, with versioning, tests and a release process.",
    duration: "8–14 wks",
    team: "3–4",
    output: "Token pipeline · Component library · Docs site",
  },
  {
    code: "DE-02",
    name: "Web platforms",
    text: "Marketing sites and editorial platforms that score in the high nineties and stay there after launch.",
    duration: "6–10 wks",
    team: "2–3",
    output: "Next.js build · CMS · Analytics",
  },
  {
    code: "DE-03",
    name: "Product interfaces",
    text: "Front-end architecture and UI engineering for complex applications, embedded with your product team.",
    duration: "10–20 wks",
    team: "3–5",
    output: "App shell · Feature UI · Test suite",
  },
  {
    code: "DE-04",
    name: "Prototypes & motion",
    text: "Coded prototypes that answer a question in days, and motion systems specified down to the cubic-bezier.",
    duration: "1–3 wks",
    team: "1–2",
    output: "Working prototype · Motion spec",
  },
  {
    code: "DE-05",
    name: "Audits & rescue",
    text: "Performance, accessibility and architecture reviews, with a costed plan rather than a list of complaints.",
    duration: "2 wks",
    team: "2",
    output: "Report · Roadmap · Quick wins shipped",
  },
];

export type DrawingId = "matrix" | "page" | "dashboard" | "mobile";

export const work: {
  dwg: string;
  drawing: DrawingId;
  client: string;
  title: string;
  text: string;
  metrics: { value: string; label: string }[];
  stack: string;
}[] = [
  {
    dwg: "DTM-118",
    drawing: "matrix",
    client: "Halcyon Health",
    title: "One design system for eleven products",
    text: "Replaced 412 hand-rolled components across four codebases with 96 that are typed, themed and tested.",
    metrics: [
      { value: "412→96", label: "Components" },
      { value: "−41%", label: "UI code" },
      { value: "3×", label: "Faster feature UI" },
    ],
    stack: "React · TypeScript · Style Dictionary",
  },
  {
    dwg: "DTM-124",
    drawing: "page",
    client: "Parcel & Post",
    title: "A national carrier’s site, rebuilt for the slow lane",
    text: "Tracking, rates and 2,300 pages of content, engineered for a mid-range phone on a rural connection.",
    metrics: [
      { value: "0.9 s", label: "LCP, p75" },
      { value: "+23%", label: "Task completion" },
      { value: "100", label: "Accessibility" },
    ],
    stack: "Next.js · Sanity · Edge cache",
  },
  {
    dwg: "DTM-131",
    drawing: "dashboard",
    client: "Northwind Energy",
    title: "A grid control room in the browser",
    text: "Live telemetry from 1,900 substations rendered at sixty frames a second, operable entirely by keyboard.",
    metrics: [
      { value: "60 fps", label: "At 40k points" },
      { value: "0", label: "Mouse required" },
      { value: "99.98%", label: "Uptime, yr 1" },
    ],
    stack: "React · WebGL · WebSockets",
  },
  {
    dwg: "DTM-137",
    drawing: "mobile",
    client: "Juno Bank",
    title: "Onboarding, prototyped in nine days",
    text: "Five coded variants tested with 60 customers before a single production ticket was written.",
    metrics: [
      { value: "9 days", label: "Brief to test" },
      { value: "5", label: "Variants" },
      { value: "+31%", label: "Completion" },
    ],
    stack: "React Native · Expo · Maze",
  },
];

export const process = [
  {
    code: "A",
    name: "Survey",
    time: "Week 1",
    text: "We measure what exists: the codebase, the design files, the build, the bundle, the backlog. You get a written survey, not a workshop.",
    outputs: ["Codebase audit", "Performance baseline", "Risk register"],
  },
  {
    code: "B",
    name: "Datum",
    time: "Week 2",
    text: "We agree the reference points everything else is measured from: tokens, breakpoints, browser support, budgets and the definition of done.",
    outputs: ["Technical spec", "Performance budget", "Definition of done"],
  },
  {
    code: "C",
    name: "Draft",
    time: "Weeks 3–4",
    text: "A thin, working slice through the whole stack. One real page or flow, end to end, deployed. Ugly problems surface while they are still cheap.",
    outputs: ["Vertical slice", "CI pipeline", "Preview deploys"],
  },
  {
    code: "D",
    name: "Build",
    time: "Weeks 5–10",
    text: "Two-week cycles with a demo at the end of each. Design and engineering share one board, one repository and one definition of finished.",
    outputs: ["Fortnightly releases", "Component docs", "Test coverage"],
  },
  {
    code: "E",
    name: "Verify",
    time: "Week 11",
    text: "Every budget is checked against the datum: performance on real devices, accessibility with real assistive tech, and a security review.",
    outputs: ["Device lab report", "WCAG 2.2 AA audit", "Load test"],
  },
  {
    code: "F",
    name: "Hand over",
    time: "Week 12",
    text: "Documentation, pairing sessions and a recorded walkthrough. We leave your team able to maintain it without us, then stay on call for ninety days.",
    outputs: ["Runbook", "Pairing sessions", "90-day warranty"],
  },
];

export const benchmarks = [
  { value: 0.8, decimals: 1, suffix: " s", label: "Median LCP across live builds", ref: "Ø" },
  { value: 100, decimals: 0, suffix: "", label: "Lighthouse accessibility, every launch since 2022", ref: "A11Y" },
  { value: 38, decimals: 0, suffix: "", label: "Design systems in production", ref: "QTY" },
  { value: 94, decimals: 0, suffix: "%", label: "Projects delivered inside the estimate", ref: "TOL" },
];

export const fieldNotes = [
  {
    quote:
      "Datum are the only agency whose pull requests our staff engineers actually enjoy reviewing. The system they built is still the cleanest part of our codebase.",
    name: "Dana Whitlock",
    role: "VP Engineering, Halcyon Health",
  },
  {
    quote:
      "They told us the estimate, then they hit the estimate. I had forgotten that was a thing that could happen.",
    name: "Tomasz Brandt",
    role: "Head of Digital, Parcel & Post",
  },
];

export const revisions = [
  { rev: "D", date: "2026-10", note: "Toronto office opened; team now 14 design engineers", by: "MO" },
  { rev: "C", date: "2025-06", note: "Open-sourced token pipeline (4.1k stars)", by: "JV" },
  { rev: "B", date: "2023-02", note: "First WCAG 2.2 AA certified build shipped", by: "AK" },
  { rev: "A", date: "2019-09", note: "Studio founded, Rotterdam", by: "MO" },
];

export const CONTACT_EMAIL = "build@datum.engineering";
