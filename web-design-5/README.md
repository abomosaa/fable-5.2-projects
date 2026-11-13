# Five agency landing pages

Five landing page concepts for a design and creative agency, built with the Next.js 16 App
Router. `/` is a plain index that links to them.

| Route           | Studio          | Direction                                                      |
| --------------- | --------------- | -------------------------------------------------------------- |
| `/design-one`   | Oberfeld        | Swiss typographic: one grotesque, three colours, a ruled grid  |
| `/design-two`   | Umbra           | Cinematic dark: serif titles, timecodes, an edit timeline      |
| `/design-three` | Wiggle Room     | Sticker pop: fat outlines, hard shadows, toys to play with     |
| `/design-four`  | Atelier Solenne | Quiet luxury: bone paper, old-style serif, arched still lifes  |
| `/design-five`  | Datum           | Technical blueprint: a drawing set with a live title strip     |

All studios, clients, people and figures are fictional.

## Running it

```bash
npm run dev     # develop
npm run lint    # eslint
npm run build   # production build (all routes prerender as static)
npm run start   # serve the build
```

## How it is organised

```
app/
  page.tsx                 index of the five designs (Tailwind utilities)
  layout.tsx, globals.css  root layout and truly global rules only
  _shared/                 small primitives used by several designs
  design-one/ … design-five/
    page.tsx               the page: fonts, metadata and section markup (server component)
    content.ts             all copy and data for the page
    design-*.css           the page's stylesheet
    _components/           interactive pieces (client components) and SVG artwork
```

Each design is self-contained: delete its folder and nothing else breaks.

### Conventions worth knowing

- **Styles are namespaced, not modular.** Every class in `design-one.css` starts with `d1-`,
  `design-two.css` with `d2-`, and so on, and every design's custom properties live on its
  root element. This project pipes all `*.css` through the Tailwind Turbopack loader (see
  `next.config.ts`), which strips CSS Modules of their module behaviour, so prefixes do the
  scoping instead.
- **Ids are namespaced too** (`#d3-work`). With Cache Components, Next.js keeps recently
  visited routes mounted but hidden, so two designs must never share an id.
- **Scroll reveals** are declarative. Mark an element with `data-reveal`; `RevealRoot` adds
  `data-revealed` when it enters the viewport and each stylesheet decides what that looks
  like. Keep the hidden state to `opacity`/`transform`: an element that clips itself away
  completely is never reported as intersecting.
- **Reduced motion** is handled in the last block of each stylesheet, and in JavaScript via
  `_shared/usePrefersReducedMotion.ts`. Without JavaScript, revealed content is forced visible
  from `layout.tsx`.
- **Artwork is code.** There are no bitmap images; posters, film stills, still lifes and
  drawings are inline SVG or CSS.
- **Forms have no backend.** They compose a pre-filled `mailto:` link with
  `_shared/mailto.ts`.

## Fonts

Loaded with `next/font` per page, so each route only ships its own typefaces. Google Fonts
are fetched at build time; Big Shoulders (Design Five) is self-hosted, see
`app/design-five/fonts/README.md`.
