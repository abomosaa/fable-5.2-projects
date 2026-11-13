export type Project = {
  no: string;
  client: string;
  project: string;
  sector: string;
  year: string;
  summary: string;
  results: string[];
  scope: string[];
};

export const projects: Project[] = [
  {
    no: "01",
    client: "Kunsthalle Nord",
    project: "Visual identity & wayfinding",
    sector: "Culture",
    year: "2026",
    summary:
      "A museum that changes its entire programme every eleven weeks needed an identity that could change with it. We drew one circle, one grid and one typeface, and wrote the rules that let the in-house team of three produce everything else.",
    results: [
      "Launch campaign produced in-house in 9 days",
      "Signage costs down 38% through a modular panel system",
      "Visitor wayfinding complaints reduced by two thirds",
    ],
    scope: ["Identity system", "Wayfinding", "Custom numerals", "Guidelines"],
  },
  {
    no: "02",
    client: "Ferro Cycles",
    project: "Brand system & product naming",
    sector: "Mobility",
    year: "2026",
    summary:
      "Ferro builds steel cargo bikes in Rotterdam and was about to enter four new markets with a logo drawn by a founder’s cousin. We kept the stubbornness, replaced the logo, and gave eleven products names a mechanic can shout across a workshop.",
    results: [
      "Naming architecture for 11 models in 3 lines",
      "Dealer toolkit adopted by 140 shops in year one",
      "Direct sales up 44% in the launch quarter",
    ],
    scope: ["Strategy", "Naming", "Identity", "Frame graphics"],
  },
  {
    no: "03",
    client: "Lumen Bank",
    project: "Rebrand & digital design language",
    sector: "Finance",
    year: "2025",
    summary:
      "Nine product teams, nine shades of blue. We consolidated two decades of drift into a single design language: one variable typeface, 212 tokens and a component library that ships to web, iOS and Android from the same source.",
    results: [
      "9 visual languages consolidated into 1",
      "Rolled out across 14 markets in 11 weeks",
      "Unaided brand recall up 31% after twelve months",
    ],
    scope: ["Rebrand", "Variable typeface", "Design tokens", "Motion"],
  },
  {
    no: "04",
    client: "Atlas Editions",
    project: "Publishing identity, 40 covers",
    sector: "Publishing",
    year: "2025",
    summary:
      "An independent publisher of translated non-fiction wanted its books to be recognisable from across a shop without looking like a series. The answer was a strict spine and a free cover — forty of them in the first year.",
    results: [
      "40 covers designed inside one template system",
      "Shortlisted for Most Beautiful Swiss Books",
      "Bookshop sell-through up 27% on the backlist",
    ],
    scope: ["Identity", "Cover system", "Editorial design", "Website"],
  },
  {
    no: "05",
    client: "Hafen Quartier",
    project: "Place brand & signage",
    sector: "Architecture",
    year: "2024",
    summary:
      "Eighteen hectares of former dockland, six developers and one very long quay. We built a place brand around a single directional arrow that scales from a street sign to a 30-metre crane wrap.",
    results: [
      "612 signs specified from 14 standard components",
      "Adopted by all six developers on the site",
      "European Design Awards — Gold, Signage",
    ],
    scope: ["Place brand", "Signage", "Environmental graphics"],
  },
  {
    no: "06",
    client: "Sora Audio",
    project: "Packaging system",
    sector: "Consumer electronics",
    year: "2024",
    summary:
      "Sora’s headphones were excellent and their boxes were anonymous. A packaging system built on concentric rings — one per product tier — now lets a customer read the whole range from three metres away.",
    results: [
      "Packaging SKUs reduced from 46 to 17",
      "All plastic removed; unit cost down 12%",
      "Retail listing won in 3 new chains",
    ],
    scope: ["Packaging", "Art direction", "Print production"],
  },
  {
    no: "07",
    client: "Tessel",
    project: "Custom typeface in three widths",
    sector: "Technology",
    year: "2023",
    summary:
      "Tessel was paying six figures a year to license a typeface that half its products could not embed. We drew a replacement — narrow, normal and wide, 480 glyphs per style — and they own it outright.",
    results: [
      "Licensing spend eliminated within 14 months",
      "27 styles, 92 languages supported",
      "TDC Certificate of Typographic Excellence",
    ],
    scope: ["Type design", "Font engineering", "Specimen"],
  },
  {
    no: "08",
    client: "Nordlys Festival",
    project: "Campaign identity",
    sector: "Culture",
    year: "2023",
    summary:
      "Ten nights of music above the Arctic Circle, promoted almost entirely on posters and in the dark. We made a generative bar system that redraws itself from each night’s line-up, so no two posters match and all of them belong.",
    results: [
      "1,400 unique posters from one script",
      "Sold out 19 days ahead of the previous record",
      "Toolkit reused for three further editions",
    ],
    scope: ["Campaign", "Generative system", "Motion", "Print"],
  },
];

export const disciplines = [
  {
    no: "A",
    title: "Brand identity",
    text: "Positioning, naming, marks and the visual language that holds them together. We design the rules first and the logo second, because the rules are what your team will actually use.",
    items: [
      "Brand strategy & architecture",
      "Naming",
      "Logo & mark systems",
      "Guidelines people read",
    ],
  },
  {
    no: "B",
    title: "Typographic systems",
    text: "Custom typefaces, hierarchies and licensing that make sense. Type is the one brand asset that appears on every single surface; we treat it as infrastructure.",
    items: [
      "Custom & variable typefaces",
      "Multi-script extension",
      "Type hierarchies",
      "Licence rationalisation",
    ],
  },
  {
    no: "C",
    title: "Digital design language",
    text: "Tokens, components and motion principles built with your engineers, not handed over the wall. The identity has to survive a pull request.",
    items: [
      "Design tokens",
      "Component libraries",
      "Motion principles",
      "Product & web design",
    ],
  },
  {
    no: "D",
    title: "Spatial & editorial",
    text: "Wayfinding, exhibitions, books and reports. Paper and steel are unforgiving in ways screens are not, which is why we still love them.",
    items: [
      "Wayfinding & signage",
      "Exhibition graphics",
      "Books & annual reports",
      "Print production",
    ],
  },
];

export const stats = [
  { value: 214, suffix: "", label: "Identity systems shipped since 2011" },
  { value: 31, suffix: "", label: "Custom typefaces drawn and engineered" },
  { value: 92, suffix: "%", label: "Of clients come back for a second project" },
  { value: 14, suffix: "", label: "Years independent, no holding company" },
];

export const method = [
  {
    no: "01",
    title: "Read",
    weeks: 3,
    duration: "2–3 weeks",
    text: "We read everything: the strategy deck, the support tickets, the sign on the loading dock. Then we interview the people who will have to live with the result.",
  },
  {
    no: "02",
    title: "Reduce",
    weeks: 4,
    duration: "3–4 weeks",
    text: "Three directions become one. We cut until what remains can be explained in a sentence and drawn from memory.",
  },
  {
    no: "03",
    title: "Build",
    weeks: 9,
    duration: "6–10 weeks",
    text: "The system is drawn, tested on real applications and built into files, fonts and code. Nothing is presented that has not been stress-tested at 16 pixels.",
  },
  {
    no: "04",
    title: "Hand over",
    weeks: 2,
    duration: "2 weeks, then on call",
    text: "Workshops, templates and guidelines written for the people who use them. We stay on a retainer for the first year because that is when the questions arrive.",
  },
];

export const clients = [
  "Kunsthalle Nord",
  "Lumen Bank",
  "Ferro Cycles",
  "Atlas Editions",
  "Tessel",
  "Sora Audio",
  "Hafen Quartier",
  "ETH Bibliothek",
  "Nordlys Festival",
  "Rhône Rail",
  "Studio Brandt",
  "Museum für Gestaltung",
];

export const recognition = [
  { year: "2025", award: "Type Directors Club", detail: "Certificate of Typographic Excellence" },
  { year: "2025", award: "Most Beautiful Swiss Books", detail: "Shortlist, Atlas Editions" },
  { year: "2024", award: "European Design Awards", detail: "Gold, Signage & Wayfinding" },
  { year: "2024", award: "D&AD", detail: "Graphite Pencil, Branding" },
  { year: "2023", award: "ADC Switzerland", detail: "Silver, Corporate Design" },
  { year: "2023", award: "Swiss Design Awards", detail: "Finalist" },
];

export const nav = [
  { href: "#d1-work", label: "Work" },
  { href: "#d1-disciplines", label: "Disciplines" },
  { href: "#d1-method", label: "Method" },
  { href: "#d1-bureau", label: "Bureau" },
];

export const CONTACT_EMAIL = "new@oberfeld.studio";
