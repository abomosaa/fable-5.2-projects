export type PlateId = "nature-morte" | "vauquelin" | "ormeau" | "lys" | "maren";

export const commissions: {
  numeral: string;
  plate: PlateId;
  shape: "arch" | "wide";
  house: string;
  place: string;
  year: string;
  scope: string;
  text: string;
  note: string;
}[] = [
  {
    numeral: "I",
    plate: "vauquelin",
    shape: "arch",
    house: "Hôtel Vauquelin",
    place: "Le Marais, Paris",
    year: "2026",
    scope: "Identity, signage, stationery, key fobs",
    text: "Forty-two rooms behind a seventeenth-century carriage door. We drew a monogram from the ironwork of the original balcony and set every word in the house in a single cut of Garamond.",
    note: "The brass key fobs are cast in Thiers by the foundry that made the originals in 1921.",
  },
  {
    numeral: "II",
    plate: "ormeau",
    shape: "wide",
    house: "Ormeau Parfums",
    place: "Grasse",
    year: "2025",
    scope: "Flacon, packaging, art direction",
    text: "Six fragrances composed around a single ingredient each. The flacon is a river stone; the carton opens like a book; the campaign contains no people and no adjectives.",
    note: "Awarded Best Packaging at the Fragrance Foundation France.",
  },
  {
    numeral: "III",
    plate: "lys",
    shape: "arch",
    house: "Domaine Lys",
    place: "Savennières, Loire",
    year: "2025",
    scope: "Labels for nine cuvées, cases, cellar-door print",
    text: "A fifth-generation domaine with four generations of labels. We kept the lily, lost the gold, and let nine shades of uncoated white do the work of telling the cuvées apart.",
    note: "Letterpress printed on cotton stock, numbered by hand at the domaine.",
  },
  {
    numeral: "IV",
    plate: "maren",
    shape: "wide",
    house: "Maren Ceramics",
    place: "Nørrebro, Copenhagen",
    year: "2024",
    scope: "Identity, photography, online shop",
    text: "A potter who had never needed a logo and was right not to want one. The identity is her maker’s stamp, a typewriter face, and photographs taken in the hour before the kiln is opened.",
    note: "The online shop sells out each firing in under a day.",
  },
];

export const offer = [
  {
    numeral: "i.",
    title: "Identity",
    text: "Names, marks and typographic systems, drawn by hand before they are drawn by machine.",
    items: ["Naming & verbal identity", "Monograms & marques", "Typography", "Guardianship documents"],
  },
  {
    numeral: "ii.",
    title: "Art direction",
    text: "Photography, film and campaign, directed with a small crew and a long lens.",
    items: ["Photography & film", "Campaign", "Set & styling", "Editorial"],
  },
  {
    numeral: "iii.",
    title: "Packaging & print",
    text: "Objects made to be kept. We specify the material, the finish and the hand that makes it.",
    items: ["Structural design", "Materials & finishing", "Stationery", "Production"],
  },
  {
    numeral: "iv.",
    title: "Digital",
    text: "Websites and booking journeys with the manners of a good concierge.",
    items: ["Websites", "E-commerce", "Reservations", "Digital guardianship"],
  },
];

export const principles = [
  {
    no: "N° 1",
    title: "Six houses a year",
    text: "We accept six commissions each year and no more. Every one is led by a founder from the first conversation to the last proof.",
  },
  {
    no: "N° 2",
    title: "We begin on site",
    text: "Before a line is drawn we spend a week where the work will live: in the cellar, on the reception desk, behind the counter on a Saturday.",
  },
  {
    no: "N° 3",
    title: "Printed before presented",
    text: "You will never be shown a screen where an object should be. First presentations arrive as paper, cloth, glass and foil.",
  },
];

export const figures = [
  { value: "6", label: "Commissions a year" },
  { value: "XVII", label: "Years of practice" },
  { value: "4", label: "Months, on average" },
  { value: "9 in 10", label: "Arrive by introduction" },
];

export const materials = [
  { id: "mist", name: "Colorplan Mist", spec: "350 gsm, uncoated" },
  { id: "linen", name: "Cotton Linen", spec: "Gmund, 300 gsm" },
  { id: "emboss", name: "Blind emboss", spec: "Sculpted brass die" },
  { id: "foil", name: "Brass foil N° 3", spec: "Hot-stamped, matte" },
  { id: "cloth", name: "Olive bookcloth", spec: "Dutch linen, starched" },
  { id: "ink", name: "Oxblood", spec: "Letterpress, two hits" },
  { id: "stone", name: "Travertine", spec: "Honed, unfilled" },
  { id: "glass", name: "Smoked glass", spec: "Mouth-blown, 4 mm" },
];

export const houses = [
  "Hôtel Vauquelin",
  "Ormeau Parfums",
  "Domaine Lys",
  "Maren Ceramics",
  "Maison Orrery",
  "Villa Sévigné",
  "Thorne & Daughters",
  "Atelier Brume",
  "Kiso Ryokan",
  "Galerie Odile Vasse",
];

export const journal = [
  {
    date: "October 2026",
    title: "On the colour of old paper",
    text: "Why we mix our whites by eye, and what a 1921 hotel ledger taught us about warmth.",
  },
  {
    date: "July 2026",
    title: "A week in the cellar at Savennières",
    text: "Notes, sketches and one very cold morning from the first site visit to Domaine Lys.",
  },
  {
    date: "March 2026",
    title: "Against the mood board",
    text: "A short argument for beginning with one object instead of two hundred images.",
  },
];

export const CONTACT_EMAIL = "enquiries@ateliersolenne.com";
