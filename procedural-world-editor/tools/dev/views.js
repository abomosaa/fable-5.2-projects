// Dev helpers injected into the page by app-shot steps: window.__v.*
window.__v = {
  river(t = 0.5, up = 1.2, back = 6, side = 0) {
    const a = window.__app, w = a.world;
    const n = w.project.water.rivers[0].nodes;
    const f = t * (n.length - 1), i = Math.min(n.length - 2, Math.floor(f)), u = f - i;
    const x = n[i].x + (n[i + 1].x - n[i].x) * u, z = n[i].z + (n[i + 1].z - n[i].z) * u;
    let dx = n[i + 1].x - n[i].x, dz = n[i + 1].z - n[i].z; const d = Math.hypot(dx, dz); dx /= d; dz /= d;
    const px = x - dx * back - dz * side, pz = z - dz * back + dx * side;
    const ws = w.waterSurfaceAt(px, pz); const g = w.heightAt(px, pz);
    const base = ws > -5e4 ? Math.max(ws, g) : g;
    a.cam.setPose({ mode: 'fly', position: [px, base + up, pz], lookAt: [x + dx * 6, (ws > -5e4 ? ws : g) + Math.min(up, 0) * 0.6, z + dz * 6] });
    return { x, z, ws, g, depth: ws - g };
  },
  at(x, z, up, lx, lz, ly = 0) {
    const a = window.__app, w = a.world; const ws = w.waterSurfaceAt(x, z); const g = w.heightAt(x, z); const base = ws > -5e4 ? Math.max(ws, g) : g;
    a.cam.setPose({ mode: 'fly', position: [x, base + up, z], lookAt: [lx, (w.waterSurfaceAt(lx, lz) > -5e4 ? w.waterSurfaceAt(lx, lz) : w.heightAt(lx, lz)) + ly, lz] });
    return { ws, g };
  },
  cam0() { const c = window.__app.world.project.cameras[0]; return c; },
};
1;
