export type Category = "Branding" | "Packaging" | "Illustration" | "Digital";

export const categories: Category[] = ["Branding", "Packaging", "Illustration", "Digital"];

export type WorkItem = {
  id: "fizzy" | "dough" | "nap" | "goodboy" | "sunday" | "pedal";
  name: string;
  what: string;
  tags: Category[];
  result: string;
  color: string;
};

export const work: WorkItem[] = [
  {
    id: "fizzy",
    name: "Fizzy Liz",
    what: "Sparkling water with opinions",
    tags: ["Branding", "Packaging"],
    result: "Sold out in three weeks. Twice.",
    color: "var(--pink)",
  },
  {
    id: "dough",
    name: "Dough Bros",
    what: "A pizza chain that grew up (a bit)",
    tags: ["Branding", "Illustration"],
    result: "From 2 shops to 19 in two years.",
    color: "var(--yellow)",
  },
  {
    id: "nap",
    name: "Nap Club",
    what: "A sleep app that isn’t smug about it",
    tags: ["Digital", "Branding"],
    result: "4.9 stars from 80,000 sleepy people.",
    color: "var(--lilac)",
  },
  {
    id: "goodboy",
    name: "Good Boy Biscuits",
    what: "Dog treats, taste-tested by Gus",
    tags: ["Packaging", "Illustration"],
    result: "Listed in 640 stores in year one.",
    color: "var(--mint)",
  },
  {
    id: "sunday",
    name: "Sunday Paper",
    what: "Stationery for chronic list-makers",
    tags: ["Branding", "Illustration"],
    result: "Repeat orders up 61%.",
    color: "var(--tomato)",
  },
  {
    id: "pedal",
    name: "Pedal Pals",
    what: "First bikes for wobbly beginners",
    tags: ["Branding", "Digital"],
    result: "Waitlist of 12,000 before launch.",
    color: "var(--blue)",
  },
];

export const services = [
  {
    title: "Brand identity",
    color: "var(--yellow)",
    blurb: "Names, logos, colours, type and a personality you can actually describe to your mum.",
    items: ["Strategy & naming", "Logo & identity systems", "Tone of voice", "Guidelines humans read"],
  },
  {
    title: "Packaging",
    color: "var(--pink)",
    blurb: "Boxes, cans, pouches and labels that win the three-second fight on a shelf.",
    items: ["Structural & graphic design", "Range architecture", "Print-ready artwork", "Press checks"],
  },
  {
    title: "Illustration",
    color: "var(--mint)",
    blurb: "Characters, patterns and little drawings that do the heavy lifting words can’t.",
    items: ["Mascots & characters", "Icon & sticker sets", "Editorial & murals", "Animation-ready files"],
  },
  {
    title: "Websites",
    color: "var(--lilac)",
    blurb: "Fast, friendly sites designed with the developers in the room, not after they’ve left.",
    items: ["Marketing sites", "Shopify storefronts", "Design systems", "Launch campaigns"],
  },
];

export const steps = [
  {
    no: "1",
    title: "Snoop",
    when: "Week 1",
    text: "We ask a lot of nosy questions, try your product, read your reviews and stalk your competitors. Politely.",
  },
  {
    no: "2",
    title: "Scribble",
    when: "Weeks 2–3",
    text: "Three honest directions on a wall. You point at things. We argue a little. One survives.",
  },
  {
    no: "3",
    title: "Sweat",
    when: "Weeks 4–6",
    text: "The winning idea gets built out properly: every size, every surface, every awkward edge case.",
  },
  {
    no: "4",
    title: "Ship",
    when: "Weeks 7–8",
    text: "Files, guidelines, templates and a launch plan. Then we stick around while it meets the real world.",
  },
];

export const plans = [
  {
    name: "The Sprint",
    price: "$9,500",
    unit: "fixed",
    time: "2 weeks",
    color: "var(--mint)",
    pitch: "For brand-new things that need to look real by Friday fortnight.",
    features: ["Logo & mini identity", "Colour & type system", "Social starter kit", "One-page guidelines"],
    cta: "Book a Sprint",
    featured: false,
  },
  {
    name: "The Full Scoop",
    price: "$38,000",
    unit: "from",
    time: "8 weeks",
    color: "var(--yellow)",
    pitch: "The whole thing, done properly. Most of our favourite work started here.",
    features: [
      "Strategy & naming help",
      "Full identity system",
      "Packaging or website design",
      "Illustration set",
      "Guidelines & templates",
    ],
    cta: "Get the Full Scoop",
    featured: true,
  },
  {
    name: "The Sidekick",
    price: "$6,500",
    unit: "per month",
    time: "Rolling",
    color: "var(--lilac)",
    pitch: "An on-call design team for brands that are already out in the wild.",
    features: ["Designer + art director", "Unlimited requests, one at a time", "Weekly check-in", "Pause any month"],
    cta: "Hire a Sidekick",
    featured: false,
  },
];

export const praise = [
  {
    quote:
      "We asked for a logo. We got a brand our customers tattoo on themselves. Genuinely. There are four tattoos now.",
    name: "Liz Okafor",
    role: "Founder, Fizzy Liz",
    color: "var(--pink)",
  },
  {
    quote:
      "The only agency I’ve worked with where the timeline was real and the invoices matched the quote.",
    name: "Marco Bellini",
    role: "Co-founder, Dough Bros",
    color: "var(--yellow)",
  },
  {
    quote:
      "They made our investors laugh in a pitch meeting. On purpose. We closed the round nine days later.",
    name: "Priya Raman",
    role: "CEO, Nap Club",
    color: "var(--lilac)",
  },
];

export const faqs = [
  {
    q: "We’re tiny. Is that a problem?",
    a: "Tiny is our favourite. About half our clients are founders with a product, a deadline and no marketing department. The Sprint was built for exactly that.",
  },
  {
    q: "How fast can you start?",
    a: "Usually within three to four weeks. Sprints sometimes sneak in sooner when a project wraps early, so it’s always worth asking.",
  },
  {
    q: "Do we get the source files?",
    a: "All of them, forever. Fonts are licensed in your name, illustrations are yours outright, and nothing lives in an account only we can open.",
  },
  {
    q: "What if we hate everything?",
    a: "It has happened exactly once in eight years. We show work early and often, so the worst case is a wobbly Tuesday, not a wasted month.",
  },
  {
    q: "Can you work with our developers / printers / cousin?",
    a: "Yes, yes and probably. We hand over tidy files, sit in on build reviews and go to press checks. Your cousin is on their own.",
  },
];

export const nav = [
  { href: "#d3-work", label: "Work" },
  { href: "#d3-services", label: "Services" },
  { href: "#d3-how", label: "How it goes" },
  { href: "#d3-pricing", label: "Pricing" },
  { href: "#d3-faq", label: "FAQ" },
];

export const CONTACT_EMAIL = "hi@wiggleroom.studio";
