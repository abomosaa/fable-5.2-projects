#!/usr/bin/env python3
"""Independent check of files exported through the UI (see scripts/e2e/04-*.mjs).

Reads the STL / 3MF with trimesh, the DXF with ezdxf and the SVGs with the
standard XML parser, and compares them with expected.json, whose numbers come
from the dimensions typed into the sketch — not from the exported files.

    .venv/bin/python -I scripts/verify_ui_export.py docs/verification/e2e/ui-exports
"""
import json, sys, zipfile, math, os
import xml.etree.ElementTree as ET
import numpy as np, trimesh, ezdxf

d = sys.argv[1] if len(sys.argv) > 1 else 'docs/verification/e2e/ui-exports'
exp = json.load(open(os.path.join(d, 'expected.json')))
fails = 0
lines = []
def check(label, ok, detail=''):
    global fails
    fails += 0 if ok else 1
    line = f"{'PASS' if ok else 'FAIL'}  {label}  {detail}"
    lines.append(line); print(line)

f = exp['files']
# ---- STL
m = trimesh.load(os.path.join(d, f['stl']), process=False, force='mesh')
m.merge_vertices()
ext = m.bounds[1] - m.bounds[0]
check('STL watertight and winding-consistent', bool(m.is_watertight and m.is_winding_consistent), f'faces={len(m.faces)}')
check('STL bounding box = 60 × 20 × 5 mm (±0.02)', bool(np.allclose(ext, exp['bbox'], atol=0.02)), f'measured={np.round(ext, 4).tolist()}')
check('STL volume matches (60·20 − 2·π·2.1²)·5 within 0.5 %', abs(m.volume - exp['volume']) / exp['volume'] < 0.005, f'measured={m.volume:.3f} expected={exp["volume"]:.3f} mm³')
bodies = len(trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)), engine='networkx'))
check('STL is a single body with 2 through-holes (Euler number = 2 − 2·genus)', bodies == 1 and m.euler_number == 2 - 2 * exp['genus'], f'bodies={bodies} euler={m.euler_number}')
# hole diameters measured on the mesh: vertices on the bottom face closest to each expected centre
bottom = m.vertices[np.isclose(m.vertices[:, 2], m.bounds[0][2], atol=1e-6)][:, :2]
origin = m.bounds[0][:2]
for h in exp['holes']:
    c = origin + np.array([h['x'], h['y']])
    r = np.sort(np.linalg.norm(bottom - c, axis=1))[:24]
    check(f"STL hole at ({h['x']}, {h['y']}) has ⌀{h['d']} (±0.02)", abs(2 * r.mean() - h['d']) < 0.02, f'measured ⌀{2 * r.mean():.4f} from {len(r)} rim vertices')
# ---- 3MF
z = zipfile.ZipFile(os.path.join(d, f['3mf']))
model = ET.fromstring(z.read('3D/3dmodel.model'))
check('3MF unit is millimeter', model.attrib.get('unit') == 'millimeter', model.attrib.get('unit', ''))
scene = trimesh.load(os.path.join(d, f['3mf']))
geoms = list(scene.geometry.values()) if hasattr(scene, 'geometry') else [scene]
g0 = geoms[0]; g0.merge_vertices()
check('3MF contains 1 watertight object of the same volume', len(geoms) == 1 and g0.is_watertight and abs(g0.volume - exp['volume']) / exp['volume'] < 0.005, f'objects={len(geoms)} volume={g0.volume:.3f}')
# ---- DXF
doc = ezdxf.readfile(os.path.join(d, f['dxf:profile']))
msp = doc.modelspace()
circles = [(e.dxf.center.x, e.dxf.center.y, e.dxf.radius) for e in msp.query('CIRCLE')]
polys = list(msp.query('POLYLINE LWPOLYLINE'))
check('DXF units are millimetres ($INSUNITS = 4)', doc.header.get('$INSUNITS') == 4, str(doc.header.get('$INSUNITS')))
check('DXF outline polylines are closed', len(polys) >= 1 and all(p.is_closed for p in polys), f'polylines={len(polys)}')
cs = sorted(circles)
if len(cs) == 2:
    spacing = math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1])
    check('DXF has 2 true CIRCLE entities, r = 2.1, centres 40 mm apart (±0.001)', all(abs(c[2] - 2.1) < 1e-3 for c in cs) and abs(spacing - exp['holeSpacing']) < 1e-3, f'circles={[(round(c[0],4), round(c[1],4), round(c[2],4)) for c in cs]} spacing={spacing:.5f}')
else:
    check('DXF has 2 CIRCLE entities', False, f'found {len(cs)}')
xs = [v[0] for p in polys for v in (p.points() if hasattr(p, 'points') else [])]
ys = [v[1] for p in polys for v in (p.points() if hasattr(p, 'points') else [])]
if xs:
    check('DXF outline extents are 60 × 20 mm (±0.02)', abs((max(xs) - min(xs)) - 60) < 0.02 and abs((max(ys) - min(ys)) - 20) < 0.02, f'{max(xs) - min(xs):.4f} × {max(ys) - min(ys):.4f}')
# ---- drawing SVG
root = ET.parse(os.path.join(d, f['svg:drawing'])).getroot()
dims = [float(g.attrib['data-value']) for g in root.iter('{http://www.w3.org/2000/svg}g') if g.attrib.get('class') == 'dim-linear']
holes = [g for g in root.iter('{http://www.w3.org/2000/svg}g') if g.attrib.get('class') == 'hole-centre']
check('drawing SVG is sized in mm and carries the part number', root.attrib.get('width', '').endswith('mm') and root.attrib.get('data-part-number') == 'P1', f"{root.attrib.get('width')} × {root.attrib.get('height')} scale {root.attrib.get('data-scale')}")
check('drawing shows linear dimensions 60 and 20 and two hole centre marks', any(abs(v - 60) < 1e-6 for v in dims) and any(abs(v - 20) < 1e-6 for v in dims) and len(holes) == 2, f'dims={dims} holes={len(holes)}')
# ---- BOM
bom = open(os.path.join(d, [n for n in os.listdir(d) if n.endswith('_bom.csv')][0]), encoding='utf-8').read()
check('BOM lists the sketched part as a custom part', 'custom' in bom and 'Sketched part' in bom, f'{len(bom.splitlines()) - 1} row(s)')
open(os.path.join(d, 'verification.txt'), 'w').write('\n'.join(lines) + f"\n\n{len(lines) - fails}/{len(lines)} checks passed (trimesh {trimesh.__version__}, ezdxf {ezdxf.__version__})\n")
print(f"\n{len(lines) - fails}/{len(lines)} checks passed")
sys.exit(1 if fails else 0)
