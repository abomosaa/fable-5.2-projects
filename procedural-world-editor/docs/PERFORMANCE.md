# Measured performance

All numbers below were **measured** by `tools/perf.mjs` on 2026-11-12; nothing is estimated.

## Machine

- CPU: Intel(R) Core(TM) i7-14700K (28 threads), RAM 31 GiB, Linux 7.3.3-1-cachyos
- GPU / driver as reported by WebGL: ANGLE (Intel, Vulkan 1.4.354 (Intel(R) Arc(tm) B580 Graphics (BMG G21) (0x0000E20B)), Intel open-source Mesa driver)
- Device: Mesa Intel(R) Arc(tm) B580 Graphics (BMG G21) (0xe20b)     Version: 26.2.6
- Browser: (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36 (Playwright Chromium, headless, ANGLE → Vulkan, vsync disabled for the measurement)
- Viewport (render target): 1920×1080, MSAA as per quality preset

## Frame time while navigating

"eye level" walks forward at 1.6 m/s from the project's opening view while looking around; "aerial" orbits the project's aerial camera. 6 s each after 1.5 s warm-up. Frame time = interval between animation frames (CPU + GPU + compositor).

| project | quality | view | avg fps | avg ms | p50 ms | p95 ms | p99 ms | max ms | draw calls | triangles / frame (all passes) | scatter instances | impostors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| showcase-valley | high | eye level | 37.2 | 26.9 | 3.7 | 142.4 | 148.8 | 149.5 | 773 | 24.9 M | 15037 | 236324 |
| showcase-valley | high | aerial | 105.6 | 9.5 | 1.0 | 20.3 | 183.0 | 323.2 | 271 | 4.4 M | 5132 | 237524 |
| showcase-lake | high | eye level | 41.3 | 24.2 | 37.2 | 50.2 | 51.2 | 52.5 | 859 | 20.5 M | 17690 | 77776 |
| showcase-lake | high | aerial | 98.8 | 10.1 | 15.7 | 19.7 | 20.4 | 21.4 | 197 | 4.6 M | 3400 | 78241 |
| showcase-coast | high | eye level | 72.8 | 13.7 | 23.6 | 27.1 | 27.8 | 28.6 | 372 | 10.5 M | 3119 | 30445 |
| showcase-coast | high | aerial | 85.1 | 11.7 | 19.9 | 24.2 | 25.2 | 25.9 | 165 | 4.3 M | 0 | 30458 |
| showcase-valley | medium | eye level | 36.6 | 27.4 | 3.9 | 145.7 | 149.1 | 154.8 | 767 | 31.2 M | 16895 | 235724 |
| showcase-valley | medium | aerial | 122.2 | 8.2 | 1.2 | 20.5 | 145.9 | 210.3 | 272 | 3.2 M | 7742 | 237514 |
| showcase-lake | medium | eye level | 41.9 | 23.9 | 35.0 | 48.9 | 49.5 | 49.7 | 864 | 21.8 M | 20609 | 77532 |
| showcase-lake | medium | aerial | 110.8 | 9.0 | 13.6 | 17.2 | 17.8 | 20.2 | 197 | 3.8 M | 5600 | 78241 |
| showcase-coast | medium | eye level | 81.7 | 12.2 | 20.0 | 23.6 | 24.3 | 25.3 | 378 | 10.8 M | 2891 | 30440 |
| showcase-coast | medium | aerial | 96.4 | 10.4 | 17.1 | 20.7 | 21.8 | 24.6 | 171 | 3.4 M | 2 | 30458 |

## Load time

Time from navigation to the first interactive frame of a showcase (2049² terrain), including deriving water, materials and scatter, baking normals / AO, decoding models and textures.

| project | quality | total s | derive ms | terrain upload + bake ms | ground textures ms | models ms |
|---|---|---|---|---|---|---|
| showcase-valley | high | 7.9 | 2093 | 2602 | 1287 | 544 |
| showcase-lake | high | 8.4 | 2508 | 2468 | 1295 | 640 |
| showcase-coast | high | 7.4 | 1714 | 2408 | 1309 | 681 |
| showcase-valley | medium | 7.9 | 2121 | 2634 | 1294 | 549 |
| showcase-lake | medium | 8.6 | 2533 | 2501 | 1336 | 660 |
| showcase-coast | medium | 7.5 | 1732 | 2430 | 1320 | 680 |

## Editing latency (high quality)

Wall-clock time of the synchronous update triggered by an edit, on the main thread (ms).

| project | sculpt dab (median / max) | stroke commit | undo stroke | move river point | undo | lake level (commit / live) | sea level | time of day | biome rule | regenerate all |
|---|---|---|---|---|---|---|---|---|---|---|
| showcase-valley | 4.4 / 7.5 | 3865.6 | 3758.2 | 5436.9 | 5392.6 | — / — | — | 1.3 | 1135.9 | 7233.5 |
| showcase-lake | 5.9 / 10.7 | 3682.4 | 3553.8 | 4711.9 | 4635.0 | 4482.5 / 2751.0 | — | 1.7 | 1582.1 | 7251.9 |
| showcase-coast | 4.0 / 6.8 | 3027.8 | 3028.6 | — | — | — / — | 4178.2 | 1.0 | 1039.9 | 10456.8 |

Notes

- Brush dabs run every frame while the mouse is down (fast path: re-carve + ground weights + texture upload for the touched rectangle); the commit on mouse-up re-solves water if the stroke can affect it and regenerates scatter in the region.
- Whole-map operations (lake / sea level, biome rules, regenerate all) are synchronous and block the UI for the time shown; terrain generation and erosion run in a worker with progress and cancel.
- Known weak spots visible in these numbers: (1) walking at eye level through dense vegetation (the valley) has frame-time spikes (see p95 / max) when near-camera ground-cover cells are generated and uploaded on the main thread; the medium preset does not help there because the stall is CPU-side. (2) Committing a stroke or a path edit that can affect water re-solves the whole water field (flood fill, river flow solve, exact distance transforms, swell) and regenerates scatter, which takes seconds on a 2049² terrain; only the per-dab brush feedback is interactive. Neither has been optimised further.
- Headless Chromium was used so the measurement is reproducible from the command line; a visible browser window on the same machine may differ slightly.
