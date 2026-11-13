# Export verification report

Verified directory: `exports/samples`

Produced by `scripts/verify_exports.py`, which only reads the exported files (trimesh, ezdxf, lxml, Python stdlib) and compares them with the expected values of each `manifest.json`. It does not use the application's TypeScript code.

**Result: PASS** — 5449 of 5449 checks passed across 6 project(s) and 74 part(s).

Reader versions: trimesh 5.2.0, ezdxf 1.4.5, numpy 2.5.4, lxml 6.1.3, networkx 3.7, Python 3.13.7.

## Tolerances

| Quantity | Tolerance |
|---|---|
| volume (STL, 3MF objects) | 0.5 % relative |
| bounding-box extents (STL, 3MF, DXF, SVG) | 0.02 mm |
| hole centre (DXF CIRCLE/POINT, SVG marks) | 0.001 mm |
| hole radius / diameter (DXF, SVG) | 0.001 mm |
| hole radius measured on the STL mesh | 0.005 mm |
| lowest point of an exported part (must be z = 0) | 0.0001 mm |
| drawing dimension values (data-value) | 0.001 mm |
| stored vs computed STL facet normal (1 - cos) | 0.001 |
| DXF profile area x thickness vs expected volume | 0.5 % relative |

## Measured vs expected (per part)

| Project | Part | Kind | Volume measured (mm³) | Volume expected (mm³) | Dev. | BBox measured (mm) | BBox expected (mm) | Triangles | Euler | Holes (DXF circles / expected) |
|---|---|---|---:|---:|---:|---|---|---:|---:|---:|
| cam-follower | P1 Back plate | baseplate | 68190.92 | 68190.92 | 0.0000 % | [90, 190, 4] | [90, 190, 4] | 384 | 0 | 1 / 1 |
| cam-follower | P3 Cam | cam | 12344.85 | 12344.85 | 0.0000 % | [51.675, 51.675, 6] | [51.675, 51.675, 6] | 3024 | 0 | 1 / 1 |
| cam-follower | P4 Follower | follower | 5901.09 | 5901.09 | 0.0000 % | [11.999, 101, 6] | [11.999, 101, 6] | 264 | 2 | 0 / 0 |
| cam-follower | P5 Guide channel | rail | 6993.31 | 6993.31 | 0.0000 % | [36, 34, 7.5] | [36, 34, 7.5] | 356 | 2 | 0 / 0 |
| export-demo | P1 Base plate | baseplate | 76480.65 | 76480.65 | 0.0000 % | [160, 120, 4] | [160, 120, 4] | 680 | -4 | 3 / 3 |
| export-demo | P2 Crank | link | 1403.12 | 1403.12 | 0.0000 % | [40, 10, 4] | [40, 10, 4] | 508 | -2 | 2 / 2 |
| export-demo | P3 Coupler | link | 3403.12 | 3403.12 | 0.0000 % | [90, 10, 4] | [90, 10, 4] | 508 | -2 | 2 / 2 |
| export-demo | P4 Rocker | link | 5868.50 | 5868.50 | 0.0000 % | [60, 41.225, 4] | [60, 41.225, 4] | 660 | -4 | 3 / 3 |
| export-demo | P5 Gear 20T | gear | 7199.87 | 7199.87 | 0.0000 % | [44, 44, 6] | [44, 44, 6] | 2224 | 0 | 1 / 1 |
| export-demo | P6 Cam | cam | 10110.15 | 10110.15 | 0.0000 % | [46, 47.125, 6] | [46, 47.125, 6] | 3024 | 0 | 1 / 1 |
| export-demo | P7 Drive pulley | pulley | 2731.65 | 2731.65 | 0.0000 % | [25.5, 25.5, 8.7] | [25.5, 25.5, 8.7] | 1200 | 0 | 1 / 1 |
| export-demo | P8 Crank pulley | pulley | 10925.74 | 10925.74 | 0.0000 % | [45.5, 45.5, 8.7] | [45.5, 45.5, 8.7] | 1844 | -2 | 2 / 2 |
| export-demo | P9 Slotted rail | rail | 7525.18 | 7525.18 | 0.0000 % | [116, 22, 5] | [116, 22, 5] | 320 | 0 | 0 / 0 |
| export-demo | P10 Tie bar | link | 2603.12 | 2603.12 | 0.0000 % | [70, 10, 4] | [70, 10, 4] | 508 | -2 | 2 / 2 |
| export-demo | P11 Tie bar | link | 2603.12 | 2603.12 | 0.0000 % | [70, 10, 4] | [70, 10, 4] | 508 | -2 | 2 / 2 |
| fourbar | P1 Frame plate | baseplate | 29735.79 | 29735.79 | 0.0000 % | [150, 50, 4] | [150, 50, 4] | 532 | -2 | 2 / 2 |
| fourbar | P3 Crank | link | 1722.40 | 1722.40 | 0.0000 % | [42, 12, 4] | [42, 12, 4] | 524 | -2 | 2 / 2 |
| fourbar | P4 Rocker | link | 3701.17 | 3701.17 | 0.0000 % | [82, 12, 4] | [82, 12, 4] | 524 | -2 | 2 / 2 |
| fourbar | P5 Coupler | link | 11637.44 | 11637.44 | 0.0000 % | [102, 47.739, 4] | [102, 47.739, 4] | 676 | -4 | 3 / 3 |
| gear-reduction | P1 Gearbox plate | baseplate | 155489.65 | 155489.65 | 0.0000 % | [260, 150, 4] | [260, 150, 4] | 728 | -4 | 3 / 3 |
| gear-reduction | P3 Pinion 16T | gear | 4520.25 | 4520.25 | 0.0000 % | [36, 36, 6] | [36, 36, 6] | 1872 | 0 | 1 / 1 |
| gear-reduction | P4 Gear 48T | gear | 42939.08 | 42939.08 | 0.0000 % | [100, 100, 6] | [100, 100, 6] | 4752 | 0 | 1 / 1 |
| gear-reduction | P5 Pinion 14T | gear | 3409.09 | 3409.09 | 0.0000 % | [32, 31.449, 6] | [32, 31.449, 6] | 1656 | 0 | 1 / 1 |
| gear-reduction | P6 Output gear 56T | gear | 58523.89 | 58523.89 | 0.0000 % | [116, 116, 6] | [116, 116, 6] | 5536 | 0 | 1 / 1 |
| gear-reduction | P9 Load drum | pulley | 8189.35 | 8189.35 | 0.0000 % | [36, 36, 11.3] | [36, 36, 11.3] | 1440 | 0 | 1 / 1 |
| slider-crank | P1 Base plate | baseplate | 126426.40 | 126426.40 | 0.0000 % | [330, 96, 4] | [330, 96, 4] | 532 | -2 | 2 / 2 |
| slider-crank | P3 Motor pulley | pulley | 2731.65 | 2731.65 | 0.0000 % | [25.5, 25.5, 8.7] | [25.5, 25.5, 8.7] | 1200 | 0 | 1 / 1 |
| slider-crank | P4 Crank pulley | pulley | 33645.89 | 33645.89 | 0.0000 % | [75.5, 75.5, 8.7] | [75.5, 75.5, 8.7] | 2228 | -2 | 2 / 2 |
| slider-crank | P5 Connecting rod | link | 4009.06 | 4009.06 | 0.0000 % | [96, 11, 4] | [96, 11, 4] | 524 | -2 | 2 / 2 |
| slider-crank | P6 Rail riser | baseplate | 11325.24 | 11325.24 | 0.0000 % | [90, 30, 4.2] | [90, 30, 4.2] | 140 | 2 | 0 / 0 |
| slider-crank | P7 Slotted guide | rail | 7645.18 | 7645.18 | 0.0000 % | [86, 26, 5] | [86, 26, 5] | 320 | 0 | 0 / 0 |
| slider-crank | P8 Slider | slider | 993.69 | 993.69 | 0.0000 % | [22, 9.7, 5] | [22, 9.7, 5] | 288 | 0 | 1 / 1 |
| walker | P1 Side plate A | baseplate | 8975.25 | 8975.25 | 0.0000 % | [102, 30, 3] | [102, 30, 3] | 648 | -4 | 3 / 3 |
| walker | P2 Side plate B | baseplate | 8975.25 | 8975.25 | 0.0000 % | [102, 30, 3] | [102, 30, 3] | 648 | -4 | 3 / 3 |
| walker | P6 Crank web 1 | link | 462.42 | 462.42 | 0.0000 % | [23, 8, 3] | [23, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P8 Crank web 2 | link | 725.96 | 725.96 | 0.0000 % | [33.981, 8, 3] | [33.981, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P10 Crank web 3 | link | 725.96 | 725.96 | 0.0000 % | [33.981, 8, 3] | [33.981, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P12 Crank web 4 | link | 462.42 | 462.42 | 0.0000 % | [23, 8, 3] | [23, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P13 Link j F1 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P14 Link k F1 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P15 Upper triangle F1 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P16 Link c F1 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P17 Link f F1 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P18 Foot F1 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |
| walker | P19 Link j R1 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P20 Link k R1 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P21 Upper triangle R1 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P22 Link c R1 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P23 Link f R1 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P24 Foot R1 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |
| walker | P25 Link j F2 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P26 Link k F2 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P27 Upper triangle F2 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P28 Link c F2 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P29 Link f F2 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P30 Foot F2 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |
| walker | P31 Link j R2 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P32 Link k R2 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P33 Upper triangle R2 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P34 Link c R2 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P35 Link f R2 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P36 Foot R2 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |
| walker | P37 Link j F3 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P38 Link k F3 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P39 Upper triangle F3 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P40 Link c F3 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P41 Link f F3 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P42 Foot F3 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |
| walker | P43 Link j R3 | link | 1302.42 | 1302.42 | 0.0000 % | [58, 8, 3] | [58, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P44 Link k R3 | link | 1588.02 | 1588.02 | 0.0000 % | [69.9, 8, 3] | [69.9, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P45 Upper triangle R3 | link | 4217.09 | 4217.09 | 0.0000 % | [49.5, 48.015, 3] | [49.5, 48.015, 3] | 596 | -4 | 3 / 3 |
| walker | P46 Link c R3 | link | 1045.62 | 1045.62 | 0.0000 % | [47.3, 8, 3] | [47.3, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P47 Link f R3 | link | 1048.02 | 1048.02 | 0.0000 % | [47.4, 8, 3] | [47.4, 8, 3] | 460 | -2 | 2 / 2 |
| walker | P48 Foot R3 | link | 4557.84 | 4557.84 | 0.0000 % | [52.447, 56.384, 3] | [52.447, 56.384, 3] | 596 | -4 | 3 / 3 |

## Checks by file type

| Project | File type | Passed | Failed |
|---|---|---:|---:|
| cam-follower | 3MF | 44 | 0 |
| cam-follower | BOM CSV | 10 | 0 |
| cam-follower | DXF | 63 | 0 |
| cam-follower | STL | 65 | 0 |
| cam-follower | drawing SVG | 63 | 0 |
| cam-follower | guide HTML | 10 | 0 |
| cam-follower | profile SVG | 56 | 0 |
| export-demo | 3MF | 93 | 0 |
| export-demo | BOM CSV | 10 | 0 |
| export-demo | DXF | 174 | 0 |
| export-demo | STL | 189 | 0 |
| export-demo | drawing SVG | 183 | 0 |
| export-demo | guide HTML | 10 | 0 |
| export-demo | profile SVG | 154 | 0 |
| fourbar | 3MF | 44 | 0 |
| fourbar | BOM CSV | 10 | 0 |
| fourbar | DXF | 64 | 0 |
| fourbar | STL | 68 | 0 |
| fourbar | drawing SVG | 67 | 0 |
| fourbar | guide HTML | 10 | 0 |
| fourbar | profile SVG | 56 | 0 |
| gear-reduction | 3MF | 58 | 0 |
| gear-reduction | BOM CSV | 10 | 0 |
| gear-reduction | DXF | 95 | 0 |
| gear-reduction | STL | 107 | 0 |
| gear-reduction | drawing SVG | 101 | 0 |
| gear-reduction | guide HTML | 10 | 0 |
| gear-reduction | profile SVG | 84 | 0 |
| slider-crank | 3MF | 65 | 0 |
| slider-crank | BOM CSV | 10 | 0 |
| slider-crank | DXF | 110 | 0 |
| slider-crank | STL | 119 | 0 |
| slider-crank | drawing SVG | 113 | 0 |
| slider-crank | guide HTML | 10 | 0 |
| slider-crank | profile SVG | 98 | 0 |
| walker | 3MF | 310 | 0 |
| walker | BOM CSV | 10 | 0 |
| walker | DXF | 672 | 0 |
| walker | STL | 714 | 0 |
| walker | drawing SVG | 712 | 0 |
| walker | guide HTML | 10 | 0 |
| walker | profile SVG | 588 | 0 |

## Failed checks

None.
