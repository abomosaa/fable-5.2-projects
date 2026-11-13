import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Five agency landing pages — index",
  description: "An index of five landing page concepts for a design and creative agency.",
};

const designs = [
  {
    href: "/design-one",
    name: "Oberfeld",
    style: "Swiss typographic",
    summary: "One grotesque, three colours, a twelve-column grid and an expandable work index.",
    swatches: ["#ecebe6", "#0d0d0c", "#ff4a1c"],
  },
  {
    href: "/design-two",
    name: "Umbra",
    style: "Cinematic dark",
    summary: "A film studio lit by a single eclipse: serif titles, timecodes and an edit timeline.",
    swatches: ["#070605", "#ece4d6", "#ffa14a"],
  },
  {
    href: "/design-three",
    name: "Wiggle Room",
    style: "Sticker pop",
    summary: "Fat outlines, hard shadows, googly-eyed characters and stickers you can drag.",
    swatches: ["#fff5e1", "#2f4cff", "#ff6bb0", "#ffd23e"],
  },
  {
    href: "/design-four",
    name: "Atelier Solenne",
    style: "Quiet luxury",
    summary: "Bone paper, a light old-style serif, arched still lifes and a materials library.",
    swatches: ["#efe8dc", "#241d17", "#94733f", "#232b25"],
  },
  {
    href: "/design-five",
    name: "Datum",
    style: "Technical blueprint",
    summary: "A drawing set on cobalt film with an exploded diagram and a live project estimator.",
    swatches: ["#1238e0", "#f2f5ff", "#ffe24a"],
  },
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16 font-sans text-neutral-900 sm:px-10">
      <p className="text-sm text-neutral-500">Index</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
        Five landing pages for a creative agency
      </h1>
      <p className="mt-3 max-w-xl text-neutral-600">
        Five separate concepts, each with its own art direction, typography, layout and
        interactions. Pick one to open it.
      </p>

      <ol className="mt-10 border-t border-neutral-200">
        {designs.map((design, i) => (
          <li key={design.href} className="border-b border-neutral-200">
            <Link
              href={design.href}
              className="group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-4 py-5 outline-offset-4 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-neutral-900 sm:px-3"
            >
              <span className="pt-0.5 text-sm tabular-nums text-neutral-400">0{i + 1}</span>
              <span>
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-lg font-semibold tracking-tight">{design.name}</span>
                  <span className="text-sm text-neutral-500">{design.style}</span>
                </span>
                <span className="mt-1 block text-sm text-neutral-600">{design.summary}</span>
                <span className="mt-3 flex gap-1.5" aria-hidden="true">
                  {design.swatches.map((color) => (
                    <span
                      key={color}
                      className="size-4 rounded-full ring-1 ring-black/10"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="pt-0.5 text-neutral-400 transition-transform group-hover:translate-x-1 group-hover:text-neutral-900 motion-reduce:transition-none"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <p className="mt-8 text-sm text-neutral-500">
        Routes: <code className="text-neutral-700">/design-one</code> to{" "}
        <code className="text-neutral-700">/design-five</code>. All studios, clients and figures
        are fictional.
      </p>
    </main>
  );
}
