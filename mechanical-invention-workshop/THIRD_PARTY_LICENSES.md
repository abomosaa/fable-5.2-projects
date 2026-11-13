# Third-party software, assets and attribution

Mechanism Workshop itself contains no downloaded 3D models, textures, images or
sounds. Every part is generated procedurally from its dimensions; lighting uses
three.js' procedural `RoomEnvironment`. The only bundled binary assets are the
two typefaces and the geometry-kernel WebAssembly module listed below. All of
them are installed from the npm registry by `npm install`; none requires an
account or a paid API, and nothing is fetched at run time.

## Shipped in the application bundle (`dist/`)

| Package | Version | Licence | Used for | Source |
|---|---|---|---|---|
| three | 0.187.0 | MIT | WebGL renderer, cameras, OrbitControls, RoomEnvironment, BufferGeometryUtils | https://github.com/mrdoob/three.js |
| manifold-3d | 3.5.4 | Apache-2.0 | Geometry kernel (WASM): extrusion, solid and 2D booleans, offsets, manifold guarantee. Bundles Clipper2 (Boost Software License 1.0) | https://github.com/elalish/manifold |
| react, react-dom | 19.3.1 | MIT | User interface | https://github.com/facebook/react |
| fflate | 0.8.3 | MIT | ZIP container for 3MF export | https://github.com/101arrowz/fflate |
| lucide-react | 1.71.0 | ISC | Icons | https://github.com/lucide-icons/lucide |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 | Inter typeface (UI text) — © The Inter Project Authors | https://github.com/rsms/inter |
| @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 | JetBrains Mono typeface (numbers) — © The JetBrains Mono Project Authors | https://github.com/JetBrains/JetBrainsMono |

## Development and verification tools (not shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| vite | 8.3.7 | MIT | Build and dev server |
| @vitejs/plugin-react | 6.3.0 | MIT | JSX transform |
| typescript | 7.0.2 | Apache-2.0 | Type checking |
| tsx | 4.23.15 | MIT | Running TypeScript scripts |
| vitest | 5.1.0 | MIT | Unit tests |
| playwright | 1.65.0 | Apache-2.0 | End-to-end UI workflows (drives Chromium) |
| @types/* | — | MIT | Type declarations |
| trimesh (Python) | 5.2.0 | MIT | Independent STL / 3MF reader in `scripts/verify_*.py` |
| ezdxf (Python) | 1.4.5 | MIT | Independent DXF reader |
| numpy / lxml / networkx (Python) | 2.5.4 / 6.1.3 / 3.7 | BSD-3-Clause | Dependencies of the verifiers |

Full licence texts are in each package's directory under `node_modules/`
(`LICENSE` / `LICENSE.md`) after installation.

## Methods and reference data (no code copied)

- Constraint projection: SHAKE — J.-P. Ryckaert, G. Ciccotti, H. J. C. Berendsen, *J. Comput. Phys.* 23 (1977).
- Velocity-level contact with Coulomb friction as a complementarity problem: Stewart & Trinkle (1996), Anitescu & Potra (1997); solved by projected Gauss–Seidel.
- Involute gear geometry and cam motion laws (cycloidal, harmonic, 3-4-5 polynomial): standard machine-design texts (e.g. Norton, *Design of Machinery*).
- Walking linkage proportions: Theo Jansen's published "holy numbers" for the Strandbeest leg, used as link lengths in millimetres.
- Plot colours: categorical palette validated for colour-vision-deficiency separation and contrast on the app's dark plot surface.
