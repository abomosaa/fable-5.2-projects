# Real photo sets for Detailed Capture evaluation

Four sets of real photographs (one overview + separately exposed close-ups of the same physical subject), all downloaded from Wikimedia Commons as original, unmodified bytes (SHA-1 checked against the Commons API). Layout: `datasets/real/<set>/overview.jpg`, `closeup_NN.jpg`. Machine-readable copy of everything below, plus the estimated homographies and footprints: `datasets/real/sources.json`. Scripts used for collection and QA: `datasets/tools/` (`commons.py`, `make_urls.py`, `fetch_originals.sh`, `sanity.py`, `build_docs.py`); raw check output and footprint overlays: `datasets/tools/out/`. Licence, author and date come from the Commons API (`extmetadata`) as of 2026-11-12.

## Sanity-check method

`datasets/tools/sanity.py`, one image pair at a time: both images are capped at 4000 px on the long side; SIFT (contrastThreshold 0.03; up to 60k overview / 12k close-up keypoints); the close-up is additionally tried at 1, 1/2, 1/4 and 1/8 of its working size and the trial with most inliers is kept; FLANN kNN + Lowe ratio 0.75; `cv2.findHomography(USAC_MAGSAC, 3 px)`. Reported: **ratio matches**, **H inliers**, **scale factor** = sqrt(|det J|) of the overview->close-up mapping at the point that lands on the close-up centre, converted to ORIGINAL pixel units of both files (close-up px per overview px; also given at the four close-up corners), **footprint** of the close-up in the overview frame, **NCC** between the overview and the close-up warped to overview resolution (a crop of the same file would give ~1.0 together with scale <= 1), and **H/F inliers** = homography inliers divided by fundamental-matrix inliers on the same matches (about 1 = one plane explains the pair; clearly below 1 = parallax, relief or lens distortion that a single homography cannot explain). `registers` = at least 25 inliers and a geometrically plausible (convex, non-degenerate) footprint. 'Independent capture' is judged from EXIF (own timestamp / camera / focal length) plus scale > 1.3. Images are read with `cv2.imread` defaults, i.e. EXIF orientation applied; all pixel sizes, footprints and homographies are in that displayed orientation. There is no ground-truth alignment: these numbers only show that a plain baseline does or does not lock on.

## alexander_mosaic_sailko

**Category:** 1 - artwork / texture (flat, textured)  
**Subject:** Alexander Mosaic (Battle of Issus), from the House of the Faun, Pompeii, c. 100 BC; Museo Archeologico Nazionale di Napoli, inv. 10020. Wall-mounted floor mosaic, roughly 5.8 x 3.1 m including border (size from literature, not measured).

One photographer (Sailko), one camera (Canon PowerShot G12), one visit: overview at 11:35:44 and eleven close-ups during the following 75 seconds (2013-11-29). The close-ups overlap heavily and form a zoom hierarchy (footprints from 23% down to 0.7% of the overview frame; the three most magnified were taken at 12 mm instead of 6.1 mm focal length). All eleven are kept even though the brief asked for 3-10; closeup_11 is the most extreme and can be dropped.

Caveats:

- The overview file is 3188x2332, i.e. slightly cropped by the author from the camera's 3648x2736 frame, and the mosaic itself only spans about 2800 px of it (wall, rope barrier and plinth are also in frame).
- Close-ups were taken from below and from the side: footprints are clearly trapezoidal and the scale factor varies by up to 2x across one close-up (see corner range).
- H/F inlier ratios of 0.68-0.92 for the seven wider close-ups (01-06, 10): a single homography leaves up to a third of the geometrically consistent matches outside 3 px. Plausible causes are uncorrected wide-angle lens distortion of the compact camera and an uneven mosaic surface; cause not verified.
- Daylight from windows: closeup_04, closeup_05 and closeup_10 have a blue cast and veiling glare on the right-hand (dark horses) area that is absent in the overview.
- Large lacunae filled with plain mortar give big texture-less regions (more than half of closeup_01).

| local file | title (Commons) | author | license | source page | original px | notes |
|---|---|---|---|---|---|---|
| `overview.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 01.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_01.JPG | 3188x2332 (7.4 MP) | whole mosaic on the museum wall |
| `closeup_01.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 02.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_02.JPG | 3648x2736 (10.0 MP) | left part: Alexander on Bucephalus, large mortar lacunae; strongly oblique |
| `closeup_02.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 03.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_03.JPG | 3648x2736 (10.0 MP) | centre: speared Persian rider, horse heads |
| `closeup_03.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 04.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_04.JPG | 3648x2736 (10.0 MP) | centre bottom: collapsed dark horse, lance on the ground |
| `closeup_04.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 05.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_05.JPG | 3648x2736 (10.0 MP) | right half: Darius' chariot and Persian cavalry; window glare |
| `closeup_05.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 06.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_06.JPG | 3648x2736 (10.0 MP) | right: chariot team (dark horses), mosaic border; window glare |
| `closeup_06.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 07.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_07.JPG | 3648x2736 (10.0 MP) | Darius and charioteer, chariot wheel (7.4 mm) |
| `closeup_07.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 08.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_08.JPG | 3648x2736 (10.0 MP) | fallen Persian with mirror-shield, below the chariot |
| `closeup_08.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 09.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_09.JPG | 3648x2736 (10.0 MP) | shield with reflected face, tight (12 mm zoom) |
| `closeup_09.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 10.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_10.JPG | 3648x2736 (10.0 MP) | heads of Persian nobles right of Darius (12 mm zoom) |
| `closeup_10.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 11.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_11.JPG | 3648x2736 (10.0 MP) | dark chariot horses; glare |
| `closeup_11.jpg` | Battaglia di isso, prob. copia di opera del IV sec ac di philoxenos d'eretria, 125-120 ac ca. da casa del fauno a pompei, 10020, 12.JPG | Sailko | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Battaglia_di_isso,_prob._copia_di_opera_del_IV_sec_ac_di_philoxenos_d%27eretria,_125-120_ac_ca._da_casa_del_fauno_a_pompei,_10020,_12.JPG | 3648x2736 (10.0 MP) | face of the Persian under the horses, bottom right (12 mm zoom); most extreme magnification |

Sanity check vs `overview.jpg` (overview EXIF: Canon PowerShot G12, 2013:11:29 11:35:44, f=6.1mm). Scale = close-up px per overview px at the close-up centre, original pixel units.

| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `closeup_01.jpg` | Canon PowerShot G12, 2013:11:29 11:36:25, f=6.1mm | 499 | 431 | 0.89 | 3.68 | 2.23-5.36 | 11.0 | 0.838 | yes | yes (own EXIF timestamp, 3.7x more px per subject unit) | registers cleanly |
| `closeup_02.jpg` | Canon PowerShot G12, 2013:11:29 11:36:17, f=6.1mm | 1316 | 952 | 0.732 | 5.02 | 3.85-6.30 | 5.6 | 0.782 | yes | yes (own EXIF timestamp, 5.0x more px per subject unit) | registers cleanly |
| `closeup_03.jpg` | Canon PowerShot G12, 2013:11:29 11:36:14, f=6.1mm | 1011 | 835 | 0.843 | 5.91 | 5.32-6.53 | 3.9 | 0.755 | yes | yes (own EXIF timestamp, 5.9x more px per subject unit) | registers cleanly |
| `closeup_04.jpg` | Canon PowerShot G12, 2013:11:29 11:35:52, f=6.1mm | 3262 | 2437 | 0.752 | 2.43 | 2.07-2.80 | 23.1 | 0.77 | yes | yes (own EXIF timestamp, 2.4x more px per subject unit) | registers cleanly |
| `closeup_05.jpg` | Canon PowerShot G12, 2013:11:29 11:35:56, f=6.1mm | 2720 | 1840 | 0.682 | 3.25 | 2.87-3.65 | 12.8 | 0.798 | yes | yes (own EXIF timestamp, 3.3x more px per subject unit) | registers cleanly |
| `closeup_06.jpg` | Canon PowerShot G12, 2013:11:29 11:36:36, f=7.407mm | 2128 | 1916 | 0.918 | 4.15 | 3.34-5.01 | 8.1 | 0.791 | yes | yes (own EXIF timestamp, 4.1x more px per subject unit) | registers cleanly |
| `closeup_07.jpg` | Canon PowerShot G12, 2013:11:29 11:36:08, f=6.1mm | 583 | 564 | 0.971 | 6.48 | 5.83-7.15 | 3.2 | 0.738 | yes | yes (own EXIF timestamp, 6.5x more px per subject unit) | registers cleanly |
| `closeup_08.jpg` | Canon PowerShot G12, 2013:11:29 11:36:58, f=12.074mm | 305 | 301 | 0.993 | 10.89 | 10.16-11.64 | 1.1 | 0.853 | yes | yes (own EXIF timestamp, 10.9x more px per subject unit) | registers cleanly; 11x scale gap |
| `closeup_09.jpg` | Canon PowerShot G12, 2013:11:29 11:36:44, f=12.074mm | 501 | 497 | 0.998 | 7.90 | 6.69-9.18 | 2.2 | 0.834 | yes | yes (own EXIF timestamp, 7.9x more px per subject unit) | registers cleanly |
| `closeup_10.jpg` | Canon PowerShot G12, 2013:11:29 11:36:02, f=6.1mm | 1381 | 929 | 0.681 | 5.61 | 5.07-6.16 | 4.3 | 0.758 | yes | yes (own EXIF timestamp, 5.6x more px per subject unit) | registers cleanly |
| `closeup_11.jpg` | Canon PowerShot G12, 2013:11:29 11:36:51, f=12.074mm | 101 | 97 | 0.97 | 14.19 | 13.54-14.84 | 0.7 | 0.812 | yes | yes (own EXIF timestamp, 14.2x more px per subject unit) | registers, weak support (97 inliers); 14x scale gap, only matched at 1/8 size |

Summary: 11/11 close-ups register with the baseline; scale factors 2.43-14.19; inliers 97-2437.
Footprint visualisation: `datasets/tools/out/alexander_mosaic_sailko_footprints.jpg`.

## vatican_map_sicilia

**Category:** 2 - text / document-like (wall map with lettering)  
**Subject:** 'Sicilia', fresco map in the Gallery of Maps (Galleria delle Carte Geografiche), Vatican Museums; Ignazio Danti and workshop, 1580-83. Flat wall painting, roughly 3 x 4 m (not measured). South is up.

One photographer (Fabrizio Garrisi), same day (2022-12-10), two cameras: overview with a Canon EOS R at 24 mm, seven close-ups with a Sony ILCE-7 at 50 mm (EXIF times 67-70 minutes later; two camera clocks, so the real gap is not certain). Lettering: closeup_06 is the inscription cartouche (gold capitals on red, crisp in the close-up, smeared in the overview), closeup_07 has the 'APHRICVM MARE' title and coastal place names, closeup_02-05 the labelled city views (Messana, Syracusa, Panormus). closeup_05 contains closeup_02/03/04 at lower magnification, closeup_01 overlaps closeup_02, closeup_06 overlaps closeup_04 and closeup_07.

Caveats:

- The overview is NOT a straight-out-of-camera frame: saved from Adobe Photoshop (EXIF Software), perspective-corrected and cropped to 5470x4446. At 100% it shows doubled edges / smearing on fine lettering, so it may be a blend or a strongly resampled frame. It also includes the stucco frame, two busts and a railing; the map itself spans about 3900 of 5470 px.
- Several close-ups were cropped by the author before upload (3550x3550, 2666x4000, 5098x4000, 3102x4654, 4670x3628 instead of the camera's 6000x4000). They are crops of their own exposures (distinct EXIF timestamps, and 5.5-5.9x the overview's pixel density), not crops of the overview or of closeup_05.
- Easiest set geometrically: H/F inlier ratio 0.96-0.99, scale nearly constant across each close-up. Large blue sea areas are a repetitive wave pattern.
- Licences are mixed: overview CC BY-SA 4.0, close-ups CC0.

| local file | title (Commons) | author | license | source page | original px | notes |
|---|---|---|---|---|---|---|
| `overview.jpg` | Sicilia - Galleria delle Carte Geografiche -FG.jpg | Fabrizio Garrisi | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Sicilia_-_Galleria_delle_Carte_Geografiche_-FG.jpg | 5470x4446 (24.3 MP) | whole map wall bay incl. frame and title tablet; perspective-corrected in Photoshop |
| `closeup_01.jpg` | Sicilia. Galleria delle carte geografiche. Musei Vaticani -FG7.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Sicilia._Galleria_delle_carte_geografiche._Musei_Vaticani_-FG7.jpg | 6000x4000 (24.0 MP) | sea and small islands left of the city-view insets, left edge of the Messana inset |
| `closeup_02.jpg` | Veduta di Messina. Sicilia. Galleria delle carte geografiche -FG.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Veduta_di_Messina._Sicilia._Galleria_delle_carte_geografiche_-FG.jpg | 3550x3550 (12.6 MP) | city view 'MESSANA' (author-cropped, square) |
| `closeup_03.jpg` | Veduta di Siracusa. Sicilia. Galleria delle carte geografiche -FG.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Veduta_di_Siracusa._Sicilia._Galleria_delle_carte_geografiche_-FG.jpg | 5098x4000 (20.4 MP) | city view 'SYRACVSA' (author-cropped) |
| `closeup_04.jpg` | Veduta di Palermo. Sicilia. Galleria delle carte geografiche -FG.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Veduta_di_Palermo._Sicilia._Galleria_delle_carte_geografiche_-FG.jpg | 2666x4000 (10.7 MP) | city view 'PANORMVS' (author-cropped, portrait) |
| `closeup_05.jpg` | Vedute di Messina Siracusa e Palermo. Sicilia. Galleria delle carte geografiche -FG.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Vedute_di_Messina_Siracusa_e_Palermo._Sicilia._Galleria_delle_carte_geografiche_-FG.jpg | 6000x4000 (24.0 MP) | all three city views in one frame (full 6000x4000 frame) |
| `closeup_06.jpg` | Sicilia. Galleria delle carte geografiche, Musei Vaticani -FG4.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Sicilia._Galleria_delle_carte_geografiche,_Musei_Vaticani_-FG4.jpg | 3102x4654 (14.4 MP) | inscription cartouche: dense gold lettering on red (author-cropped, portrait) |
| `closeup_07.jpg` | Sicilia. Galleria delle carte geografiche, Musei Vaticani -FG5.jpg | Fabrizio Garrisi | CC0 | https://commons.wikimedia.org/wiki/File:Sicilia._Galleria_delle_carte_geografiche,_Musei_Vaticani_-FG5.jpg | 4670x3628 (16.9 MP) | 'APHRICVM MARE' lettering, coast with place names, ships (author-cropped) |

Sanity check vs `overview.jpg` (overview EXIF: Canon EOS R, 2022:12:10 14:50:57, f=24mm). Scale = close-up px per overview px at the close-up centre, original pixel units.

| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `closeup_01.jpg` | ILCE-7, 2022:12:10 15:57:51, f=50mm | 394 | 344 | 0.961 | 5.46 | 5.23-5.69 | 3.3 | 0.925 | yes | yes (own EXIF timestamp, different camera, 5.5x more px per subject unit) | registers cleanly |
| `closeup_02.jpg` | ILCE-7, 2022:12:10 15:58:00, f=50mm | 111 | 100 | 0.971 | 5.93 | 5.86-6.00 | 1.5 | 0.924 | yes | yes (own EXIF timestamp, different camera, 5.9x more px per subject unit) | registers cleanly |
| `closeup_03.jpg` | ILCE-7, 2022:12:10 15:58:08, f=50mm | 222 | 216 | 0.986 | 5.63 | 5.51-5.75 | 2.6 | 0.925 | yes | yes (own EXIF timestamp, different camera, 5.6x more px per subject unit) | registers cleanly |
| `closeup_04.jpg` | ILCE-7, 2022:12:10 15:58:16, f=50mm | 222 | 218 | 0.995 | 5.53 | 5.48-5.59 | 1.4 | 0.872 | yes | yes (own EXIF timestamp, different camera, 5.5x more px per subject unit) | registers cleanly |
| `closeup_05.jpg` | ILCE-7, 2022:12:10 15:58:26, f=50mm | 1229 | 1185 | 0.993 | 3.05 | 2.99-3.11 | 10.6 | 0.793 | yes | yes (own EXIF timestamp, different camera, 3.1x more px per subject unit) | registers cleanly |
| `closeup_06.jpg` | ILCE-7, 2022:12:10 16:00:20, f=50mm | 945 | 897 | 0.987 | 2.67 | 2.58-2.75 | 8.3 | 0.839 | yes | yes (own EXIF timestamp, different camera, 2.7x more px per subject unit) | registers cleanly |
| `closeup_07.jpg` | ILCE-7, 2022:12:10 16:00:32, f=50mm | 517 | 491 | 0.986 | 2.29 | 2.19-2.39 | 13.3 | 0.89 | yes | yes (own EXIF timestamp, different camera, 2.3x more px per subject unit) | registers cleanly |

Summary: 7/7 close-ups register with the baseline; scale factors 2.29-5.93; inliers 100-1185.
Footprint visualisation: `datasets/tools/out/vatican_map_sicilia_footprints.jpg`.

## portonaccio_sarcophagus

**Category:** 3 - challenging: clearly non-planar (deep relief, shifted viewpoints)  
**Subject:** Portonaccio sarcophagus, Roman battle sarcophagus, c. AD 180; Museo Nazionale Romano, Palazzo Massimo alle Terme, Rome. Marble, very deep undercut relief in several depth layers, lid frieze above the chest, projecting corner masks. Roughly 2.4 m long (not measured).

One photographer (Miguel Hermoso Cuesta), one camera (Canon EOS 600D, focal lengths 27-55 mm), 110 seconds (2014-02-28): near-frontal overview, then ten close-ups from varying positions and angles. Dark room with spot lighting, black background. Expected to break a planar model; it is the 'failure / poor consistency is fine' set.

Caveats:

- Non-planar: H/F inlier ratio 0.31-0.78 for eight of ten close-ups (0.95 for closeup_08, where the matched area is a single head). A homography locks onto the dominant depth layer only; expect ghosting and misalignment on the other layers.
- The baseline still finds a plausible footprint for nine of ten close-ups, so the set is 'registers coarsely but not consistently' rather than 'fails outright'. Only closeup_09 fails completely.
- Little overlap between close-ups (01/02 and 05/06 touch, 08/09 show the same mask); they are details, not a covering sweep.
- Three files are stored landscape with an EXIF orientation tag (closeup_02, closeup_08, closeup_09). A loader that ignores EXIF orientation will see them rotated by 90 degrees.

| local file | title (Commons) | author | license | source page | original px | notes |
|---|---|---|---|---|---|---|
| `overview.jpg` | Sarcófago de Portonaccio. 01.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._01.JPG | 5184x3456 (17.9 MP) | front of chest and lid, near-frontal |
| `closeup_01.jpg` | Sarcófago de Portonaccio. 02.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._02.JPG | 5184x3456 (17.9 MP) | left trophy with helmet, cuirass and shields |
| `closeup_02.jpg` | Sarcófago de Portonaccio. 03.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._03.JPG | 3456x5184 (17.9 MP) | left pair of barbarian captives, full height (portrait) [EXIF Orientation=8: pixels stored as 5184x3456] |
| `closeup_03.jpg` | Sarcófago de Portonaccio. 04.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._04.JPG | 5184x3456 (17.9 MP) | centre: charging Roman cavalry around the general |
| `closeup_04.jpg` | Sarcófago de Portonaccio. 05.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._05.JPG | 5184x3456 (17.9 MP) | lid frieze, left scene |
| `closeup_05.jpg` | Sarcófago de Portonaccio. 06.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._06.JPG | 5184x3456 (17.9 MP) | right trophy |
| `closeup_06.jpg` | Sarcófago de Portonaccio. 07.jpg | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._07.jpg | 5184x3456 (17.9 MP) | right pair of captives, heads and shoulders |
| `closeup_07.jpg` | Sarcófago de Portonaccio. 08.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._08.JPG | 5184x3456 (17.9 MP) | battle scene upper left of centre, crossed standards |
| `closeup_08.jpg` | Sarcófago de Portonaccio. 09.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._09.JPG | 3456x5184 (17.9 MP) | right corner mask of the lid, seen close to the overview's direction (portrait) [EXIF Orientation=8: pixels stored as 5184x3456] |
| `closeup_09.jpg` | Sarcófago de Portonaccio. 10.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._10.JPG | 3456x5184 (17.9 MP) | same right corner mask from a clearly different direction (portrait) [EXIF Orientation=8: pixels stored as 5184x3456] |
| `closeup_10.jpg` | Sarcófago de Portonaccio. 11.JPG | Miguel Hermoso Cuesta | CC BY-SA 3.0 | https://commons.wikimedia.org/wiki/File:Sarc%C3%B3fago_de_Portonaccio._11.JPG | 5184x3456 (17.9 MP) | lid frieze, right scene, taken obliquely |

Sanity check vs `overview.jpg` (overview EXIF: Canon EOS 600D, 2014:02:28 17:34:01, f=27mm). Scale = close-up px per overview px at the close-up centre, original pixel units.

| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `closeup_01.jpg` | Canon EOS 600D, 2014:02:28 17:34:14, f=42mm | 389 | 265 | 0.703 | 4.90 | 4.78-5.02 | 4.2 | 0.812 | yes | yes (own EXIF timestamp, 4.9x more px per subject unit) | registers cleanly |
| `closeup_02.jpg` | Canon EOS 600D, 2014:02:28 17:34:23, f=32mm | 219 | 112 | 0.544 | 3.48 | 3.38-3.58 | 8.2 | 0.672 | yes | yes (own EXIF timestamp, 3.5x more px per subject unit) | registers cleanly |
| `closeup_03.jpg` | Canon EOS 600D, 2014:02:28 17:34:34, f=33mm | 2043 | 772 | 0.384 | 4.03 | 3.94-4.12 | 6.2 | 0.746 | yes | yes (own EXIF timestamp, 4.0x more px per subject unit) | registers cleanly; but only 38% of the geometrically consistent matches fit the plane |
| `closeup_04.jpg` | Canon EOS 600D, 2014:02:28 17:34:43, f=47mm | 1198 | 780 | 0.672 | 5.09 | 4.83-5.36 | 3.9 | 0.82 | yes | yes (own EXIF timestamp, 5.1x more px per subject unit) | registers cleanly |
| `closeup_05.jpg` | Canon EOS 600D, 2014:02:28 17:34:56, f=47mm | 248 | 188 | 0.78 | 6.22 | 5.88-6.57 | 2.6 | 0.74 | yes | yes (own EXIF timestamp, 6.2x more px per subject unit) | registers cleanly |
| `closeup_06.jpg` | Canon EOS 600D, 2014:02:28 17:35:02, f=55mm | 215 | 126 | 0.615 | 6.89 | 5.78-8.06 | 2.1 | 0.681 | yes | yes (own EXIF timestamp, 6.9x more px per subject unit) | registers cleanly |
| `closeup_07.jpg` | Canon EOS 600D, 2014:02:28 17:35:14, f=55mm | 1806 | 1012 | 0.569 | 4.65 | 4.51-4.79 | 4.6 | 0.876 | yes | yes (own EXIF timestamp, 4.7x more px per subject unit) | registers cleanly |
| `closeup_08.jpg` | Canon EOS 600D, 2014:02:28 17:35:34, f=55mm | 463 | 428 | 0.947 | 5.37 | 4.87-5.89 | 3.5 | 0.927 | yes | yes (own EXIF timestamp, 5.4x more px per subject unit) | registers cleanly |
| `closeup_09.jpg` | Canon EOS 600D, 2014:02:28 17:35:43, f=55mm | - | 5 | - | - | - | - | - | NO | yes (own EXIF timestamp) | does NOT register with the single-homography baseline (5 inliers); expected: large viewpoint change on a fully 3D head |
| `closeup_10.jpg` | Canon EOS 600D, 2014:02:28 17:35:51, f=55mm | 175 | 44 | 0.31 | 3.86 | 2.76-5.07 | 7.2 | 0.582 | yes | yes (own EXIF timestamp, 3.9x more px per subject unit) | registers, weak support (44 inliers); oblique view; footprint skewed (corner scales 2.8-5.1), homography fits under a third of the consistent matches |

Summary: 9/10 close-ups register with the baseline; scale factors 3.48-6.89; inliers 44-1012.
Footprint visualisation: `datasets/tools/out/portonaccio_sarcophagus_footprints.jpg`.

## claudian_table

**Category:** 2 - text / document-like (inscription); harder, mixed-session variant (delivered as the optional 4th set)  
**Subject:** Claudian Table / Lyon Tablet (Table claudienne), bronze plate with Claudius' speech of AD 48, 1.93 x 1.39 m (literature); Lugdunum museum, Lyon. Flat bronze with engraved capitals; appearance depends strongly on lighting.

Mixed photographers and sessions, assembled to get dense text with readable close-ups. `overview.jpg` (Phyrexian, 2025-06-24, tablet fills the frame) and closeup_01-04 (Sukkoria, 2025-06-22, a compact camera zoomed onto ligatures in the lower right column) evidently show the tablet in the same display and lighting, two days apart (venue per the overview's Commons title; not stated for the close-ups). closeup_05 (Marie-Lan Nguyen, D850) and closeup_06 (Romainbehar, phone) were taken in January 2019 under different lighting, apparently at a temporary exhibition at the Musee des Beaux-Arts de Lyon (stated in the Commons title of closeup_06; assumed for the Nguyen photos because closeup_06 matches their lighting, not confirmed). `overview_alt.jpg` is the 34.7 MP overview from the same photographer and session as closeup_05 (two minutes earlier), included so the 2019 close-ups also have a same-lighting overview. closeup_01 lies inside closeup_02; closeup_05 overlaps closeup_02.

Caveats:

- Deviation from the requested layout: this directory contains a second overview, `overview_alt.jpg`. Ignore it, or use it instead of `overview.jpg` for closeup_05/06.
- Against `overview.jpg`: the four same-display close-ups register (two with only 32 and 40 inliers), closeup_05 registers weakly (38 inliers), closeup_06 stays below the threshold (23 inliers). Against `overview_alt.jpg` the picture flips: closeup_05/06 get 475/444 inliers, the 2025 close-ups do not register. The two overviews give mutually consistent scales for every close-up that produced a homography against both (ratio 1.657 +/- 0.01), so the weak registrations are very likely correct; this is a cross-check, not ground truth.
- Why it is hard: engraved strokes flip between bright and dark with the light direction (NCC -0.01 for closeup_06 against overview.jpg despite a consistent homography), specular bronze, and highly repetitive lettering.
- Large scale gaps against overview.jpg (5.4-10.4x for the 2025 close-ups) because that overview is only 11 MP.
- closeup_05 is 7878x5251 = 41.4 MP, marginally over the 40 MP guideline; original kept. closeup_06 is stored landscape with an EXIF orientation tag.
- Licences are mixed: CC BY-SA 4.0 (overview, closeup_01-04), public domain (overview_alt, closeup_05), CC0 (closeup_06).

| local file | title (Commons) | author | license | source page | original px | notes |
|---|---|---|---|---|---|---|
| `overview.jpg` | Lyon - Lugdunum Musée et théâtres romains 6746.jpg | Phyrexian | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Lyon_-_Lugdunum_Mus%C3%A9e_et_th%C3%A9%C3%A2tres_romains_6746.jpg | 3931x2832 (11.1 MP) | whole tablet, Lugdunum museum display, 2025; frame-filling |
| `overview_alt.jpg` | Tabula Claudiana Lugdunum AD12 n1.jpg | Marie-Lan Nguyen | Public domain | https://commons.wikimedia.org/wiki/File:Tabula_Claudiana_Lugdunum_AD12_n1.jpg | 6808x5103 (34.7 MP) | ALTERNATIVE overview: whole tablet, January 2019 session of closeup_05, 34.7 MP |
| `closeup_01.jpg` | Table claudienne - ligatures - 01.jpg | Sukkoria | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Table_claudienne_-_ligatures_-_01.jpg | 5184x3888 (20.2 MP) | ligatures, lower right column (17.8 mm zoom) |
| `closeup_02.jpg` | Table claudienne - ligatures - 02.jpg | Sukkoria | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Table_claudienne_-_ligatures_-_02.jpg | 5184x3888 (20.2 MP) | ligatures, lower right column, wider (contains closeup_01) |
| `closeup_03.jpg` | Table claudienne - ligatures - 03.jpg | Sukkoria | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Table_claudienne_-_ligatures_-_03.jpg | 5184x3888 (20.2 MP) | ligatures, bottom right corner of the text |
| `closeup_04.jpg` | Table claudienne - ligatures - 04.jpg | Sukkoria | CC BY-SA 4.0 | https://commons.wikimedia.org/wiki/File:Table_claudienne_-_ligatures_-_04.jpg | 5184x3888 (20.2 MP) | ligatures, right edge of the right column |
| `closeup_05.jpg` | Tabula Claudiana Lugdunum AD12 n2.jpg | Marie-Lan Nguyen | Public domain | https://commons.wikimedia.org/wiki/File:Tabula_Claudiana_Lugdunum_AD12_n2.jpg | 7878x5251 (41.4 MP) | middle of the right column, 2019 lighting; 41.4 MP |
| `closeup_06.jpg` | MBA Lyon - Claude 2018 - Table claudienne, haut de la fracture entre les plaques.jpg | Romainbehar | CC0 | https://commons.wikimedia.org/wiki/File:MBA_Lyon_-_Claude_2018_-_Table_claudienne,_haut_de_la_fracture_entre_les_plaques.jpg | 3096x4128 (12.8 MP) | top of the fracture between the two plates, 2019, phone (portrait) [EXIF Orientation=6: pixels stored as 4128x3096] |

Sanity check vs `overview.jpg` (overview EXIF: NIKON D7500, 2025:06:24 14:27:01, f=24mm). Scale = close-up px per overview px at the close-up centre, original pixel units.

| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `closeup_01.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:05, f=17.762mm | 232 | 187 | 0.989 | 8.27 | 8.15-8.39 | 2.6 | 0.908 | yes | yes (own EXIF timestamp, different camera, 8.3x more px per subject unit) | registers cleanly |
| `closeup_02.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:09, f=11.862mm | 393 | 219 | 0.936 | 5.37 | 5.25-5.50 | 6.3 | 0.848 | yes | yes (own EXIF timestamp, different camera, 5.4x more px per subject unit) | registers cleanly |
| `closeup_03.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:26, f=12.539mm | 69 | 32 | 0.889 | 10.44 | 9.57-11.34 | 1.7 | 0.875 | yes | yes (own EXIF timestamp, different camera, 10.4x more px per subject unit) | registers, weak support (32 inliers); 10x scale gap |
| `closeup_04.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:31, f=12.539mm | 79 | 40 | 0.851 | 9.88 | 9.61-10.15 | 1.9 | 0.802 | yes | yes (own EXIF timestamp, different camera, 9.9x more px per subject unit) | registers, weak support (40 inliers); 10x scale gap |
| `closeup_05.jpg` | NIKON D850, 2019:01:26 12:27:51, f=70mm | 98 | 38 | 0.844 | 6.92 | 6.77-7.07 | 7.8 | 0.681 | yes | yes (own EXIF timestamp, different camera, 6.9x more px per subject unit) | registers, weak support (38 inliers); different session and lighting (2019); 475 inliers against overview_alt.jpg |
| `closeup_06.jpg` | SM-J500FN, 2019:01:20 11:21:02, f=3.7mm | 68 | 23 | 0.885 | 2.41 | 2.13-2.70 | 19.9 | -0.012 | NO | yes (own EXIF timestamp, different camera, 2.4x more px per subject unit) | does NOT pass the baseline threshold (23 inliers); different session and lighting (2019); homography is consistent with the overview_alt result but support is too thin; 444 inliers against overview_alt.jpg |

Same close-ups vs `overview_alt.jpg` (EXIF: NIKON D850, 2019:01:26 12:25:58, f=58mm). Scale factors here are relative to the 6808 px alternative overview.

| close-up | EXIF (camera, time, focal) | ratio matches | H inliers | H/F inliers | scale factor | scale range at corners | footprint (% of overview frame) | NCC | registers | independent capture? | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `closeup_01.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:05, f=17.762mm | 64 | 11 | 0.846 | 4.97 | 4.88-5.05 | 2.4 | 0.672 | NO | yes (own EXIF timestamp, different camera, 5.0x more px per subject unit) | does NOT pass the baseline threshold (11 inliers) |
| `closeup_02.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:09, f=11.862mm | 117 | 16 | 0.727 | 3.23 | 3.13-3.33 | 5.6 | 0.552 | NO | yes (own EXIF timestamp, different camera, 3.2x more px per subject unit) | does NOT pass the baseline threshold (16 inliers) |
| `closeup_03.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:26, f=12.539mm | - | 6 | - | - | - | - | - | NO | yes (own EXIF timestamp, different camera) | does NOT register with the single-homography baseline (6 inliers) |
| `closeup_04.jpg` | Canon PowerShot SX720 HS, 2025:06:22 10:46:31, f=12.539mm | - | 6 | - | - | - | - | - | NO | yes (own EXIF timestamp, different camera) | does NOT register with the single-homography baseline (6 inliers) |
| `closeup_05.jpg` | NIKON D850, 2019:01:26 12:27:51, f=70mm | 548 | 475 | 0.983 | 4.17 | 4.09-4.26 | 6.8 | 0.839 | yes | yes (own EXIF timestamp, 4.2x more px per subject unit) | registers cleanly |
| `closeup_06.jpg` | SM-J500FN, 2019:01:20 11:21:02, f=3.7mm | 693 | 444 | 0.809 | 1.45 | 1.26-1.65 | 17.6 | 0.86 | yes | yes (own EXIF timestamp, different camera, 1.5x more px per subject unit) | registers cleanly |

Summary: 5/6 close-ups register with the baseline; scale factors 5.37-10.44; inliers 32-219.
Footprint visualisation: `datasets/tools/out/claudian_table_footprints.jpg`.

## Totals

39 files, 291.7 MB (278.2 MiB).

## General caveats

- No ground-truth registration exists for any set. Inlier counts and scale factors come from the baseline described above.
- CC BY-SA / CC BY files require attribution (and share-alike for derivatives) if images or mosaics made from them are published; keep this file with the data.
- The photographed objects are ancient or 16th-century works (no copyright in the artwork itself). Italian cultural-heritage rules can restrict commercial reuse of images of objects in Italian state museums (Naples mosaic, Rome sarcophagus) independently of copyright; not relevant for internal evaluation, not checked further.
- Four files carry an EXIF orientation tag other than 1 (flagged in the tables). OpenCV's imread applies it by default; Pillow and many Android decoders do not.
- Re-downloading: upload.wikimedia.org throttles scripted downloads of originals (HTTP 429 with Retry-After 600 after roughly 6-9 files); `fetch_originals.sh` waits and resumes.

## Candidates considered but not delivered

- Alexander Mosaic, series by Benjamín Núñez González (Commons 'Mosaico de Issos, Nápoles, Italia, 2016 01.jpg' to '... 29.jpg', CC BY-SA 4.0, 4000x3000 each, one six-minute session; no. 10 is the overview): 28 close-ups, many overlapping, going down to tessera-level macro shots. Looked at thumbnails only; not downloaded (same subject as set 1, and about 145 MB would exceed the size budget) and NOT sanity-checked. Good next candidate for a more extreme zoom hierarchy.
- Other Garrisi map series from the same gallery (Sardinia: overview + 4 'particolare' files; Corsica: 4 details): same structure as the Sicilia set; listed via the API only, not downloaded or checked.
- Rosetta Stone (Commons has several visitor series): behind glass with reflections; listed only, not tested.
- Repetitive-pattern subject (tiled facade / brick wall): not searched; the non-planar option was chosen for set 3.
- The Met, National Gallery of Art, Rijksmuseum, Smithsonian, Library of Congress: not searched. Their 'detail' images usually come without EXIF, so separate exposures cannot be told apart from crops of one high-resolution capture as reliably as with the Commons visitor photos used here.

## Not verified

- Licence statements are taken from the Commons API as displayed on 2026-11-12; the uploaders' right to license was not independently checked.
- Physical dimensions of the subjects are from general literature / memory, not measured; do not use them for metric scale.
- Whether weak registrations (under about 50 inliers: claudian_table closeup_03-06, portonaccio closeup_10) are pixel-accurate. Their footprints were only checked for plausibility on the overlay images and, for the Claudian table, by scale consistency between the two overviews.
- The cause of the 0.7-0.9 H/F inlier ratio on the (nominally flat) Alexander Mosaic.
- Exactly how the Sicilia overview was processed (perspective correction is evident; stitching or blending is suspected from doubled edges, not confirmed).
