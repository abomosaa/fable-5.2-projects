export type StillId = "aurea" | "first-light" | "meridian" | "treeline" | "nocturne";

export type Film = {
  still: StillId;
  title: string;
  client: string;
  kind: string;
  runtime: string;
  year: string;
  note: string;
  laurels?: string;
};

export const films: Film[] = [
  {
    still: "aurea",
    title: "Aurea",
    client: "Maison Aurea",
    kind: "Fragrance film",
    runtime: "01:00",
    year: "2026",
    note: "Shot on 35mm, finished in Houdini. One drop of amber, followed from the still to the skin.",
    laurels: "Ciclope — Gold, Cinematography",
  },
  {
    still: "first-light",
    title: "First Light",
    client: "Kite Mobility",
    kind: "Launch film",
    runtime: "01:30",
    year: "2026",
    note: "The reveal of the Kite One, lit only by its own headlamps across forty kilometres of salt flat.",
    laurels: "Cannes Lions — Silver, Film Craft",
  },
  {
    still: "meridian",
    title: "Meridian",
    client: "Northlight Pictures",
    kind: "Main title sequence",
    runtime: "01:12",
    year: "2025",
    note: "Eight episodes, one eclipse. Built from practical light passes and a hand-cut brass aperture.",
    laurels: "D&AD — Graphite Pencil, Title Design",
  },
  {
    still: "treeline",
    title: "Above the Treeline",
    client: "Halden Outdoor",
    kind: "Brand film",
    runtime: "02:40",
    year: "2025",
    note: "Eleven days in Lofoten with a crew of six. No voice-over, and one take of fog we waited four days for.",
    laurels: "Vimeo Staff Pick",
  },
  {
    still: "nocturne",
    title: "Nocturne Sessions",
    client: "Sonar Hall",
    kind: "Realtime tour visuals",
    runtime: "90:00 live",
    year: "2024",
    note: "A show system driven by the band’s own stems: fourteen songs, thirty-one dates, zero pre-renders.",
  },
];

export const credits = [
  "Maison Aurea",
  "Kite Mobility",
  "Halden Outdoor",
  "Northlight Pictures",
  "Sonar Hall",
  "Arclight Audio",
  "Ostra Hotels",
  "Field & Fathom",
];

export const crafts = [
  {
    no: "01",
    title: "Brand films",
    text: "From fifteen-second cut-downs to five-minute anthems. Live action, CG, or the blurry place in between where most good work now lives.",
    tags: ["Direction", "Cinematography", "Edit", "Grade"],
  },
  {
    no: "02",
    title: "Motion systems",
    text: "Identity that moves: logo behaviours, kinetic type, transitions and a toolkit your in-house team will actually open.",
    tags: ["Motion identity", "Toolkits", "Templates", "Guidelines"],
  },
  {
    no: "03",
    title: "CG & realtime",
    text: "Houdini, Unreal and TouchDesigner under one roof. Product visualisation, simulation and visuals that react live.",
    tags: ["Look development", "Simulation", "Unreal", "Live shows"],
  },
  {
    no: "04",
    title: "Sound & score",
    text: "Original music and sound design, composed to picture in our own room. Because half of what you see is what you hear.",
    tags: ["Composition", "Sound design", "Mix", "Dolby Atmos"],
  },
];

export type Clip = { label: string; start: number; end: number };
export type Track = { id: string; name: string; tone: string; clips: Clip[] };

/** Clip positions are expressed in weeks on an eight-week schedule. */
export const TOTAL_WEEKS = 8;

export const tracks: Track[] = [
  {
    id: "story",
    name: "Story",
    tone: "ember",
    clips: [
      { label: "Treatment", start: 0, end: 1.5 },
      { label: "Script & boards", start: 1.5, end: 3.25 },
    ],
  },
  {
    id: "design",
    name: "Design",
    tone: "rose",
    clips: [
      { label: "Look development", start: 1.75, end: 3.75 },
      { label: "Styleframes", start: 3.75, end: 5 },
    ],
  },
  {
    id: "picture",
    name: "Picture",
    tone: "violet",
    clips: [{ label: "Shoot & animation", start: 3.5, end: 6.75 }],
  },
  {
    id: "sound",
    name: "Sound",
    tone: "teal",
    clips: [
      { label: "Score sketches", start: 2.5, end: 4 },
      { label: "Sound design & mix", start: 5.75, end: 7.75 },
    ],
  },
  {
    id: "finish",
    name: "Finish",
    tone: "bone",
    clips: [
      { label: "Grade", start: 6.5, end: 7.5 },
      { label: "Master", start: 7.5, end: 8 },
    ],
  },
];

export const acts = [
  {
    act: "Act I",
    title: "Treatment",
    weeks: "Weeks 1–2",
    text: "One idea, written down. A treatment, a reference cut and a number you can take to finance. If we cannot say it in a paragraph we do not shoot it.",
  },
  {
    act: "Act II",
    title: "Design",
    weeks: "Weeks 2–5",
    text: "Boards, look development and styleframes. You see the film as stills before anyone books a camera, and the score starts before the picture does.",
  },
  {
    act: "Act III",
    title: "Picture",
    weeks: "Weeks 4–7",
    text: "The shoot, the simulation, the long nights with the render farm. You get a cut every Friday and a producer who answers the phone.",
  },
  {
    act: "Act IV",
    title: "Finish",
    weeks: "Weeks 7–8",
    text: "Grade, mix and conform in our own rooms. Every deliverable, every aspect ratio, every platform — mastered, checked and named properly.",
  },
];

export const laurels = [
  { year: "2026", name: "Ciclope Festival", detail: "Gold — Cinematography", film: "Aurea" },
  { year: "2026", name: "Cannes Lions", detail: "Silver — Film Craft", film: "First Light" },
  { year: "2025", name: "D&AD", detail: "Graphite Pencil — Title Design", film: "Meridian" },
  { year: "2025", name: "Vimeo", detail: "Staff Pick, eleventh in total", film: "Above the Treeline" },
  { year: "2024", name: "ADC Annual Awards", detail: "Silver Cube — Motion", film: "Nocturne Sessions" },
  { year: "2024", name: "SXSW Title Design", detail: "Finalist", film: "Low Tide" },
];

export const figures = [
  { value: 146, suffix: "", label: "Films delivered" },
  { value: 31, suffix: "", label: "Countries shot in" },
  { value: 11, suffix: "", label: "Vimeo Staff Picks" },
  { value: 24, suffix: "", label: "Seats in our screening room" },
];

export const CONTACT_EMAIL = "hello@umbra.film";
