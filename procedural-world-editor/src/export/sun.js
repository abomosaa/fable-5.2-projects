// DOM-free copy of the sun-position formula used by the renderer (Atmosphere.sunDirection in
// src/render/Atmosphere.js). Kept separate because Atmosphere.js pulls in the three.js renderer.
// World axes: +x east, +z south, +y up. The returned vector points from the scene TOWARDS the sun.

export function sunDirection(env) {
  const lat = ((env.latitude ?? 46) * Math.PI) / 180;
  const decl = ((23.44 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * ((env.dayOfYear ?? 172) - 81));
  const ha = (((env.timeOfDay ?? 12) - 12) * 15 * Math.PI) / 180;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // azimuth measured from south, positive towards west
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
  // sunAzimuth rotates the whole sun path (compass offset, degrees)
  const rot = (((env.sunAzimuth ?? 180) - 180) * Math.PI) / 180;
  const a = az + rot;
  const v = [-Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Elevation (degrees above the horizon) and compass bearing (degrees, 0 = north (-z), 90 = east (+x)) of a direction. */
export function directionAngles(v) {
  const elevationDeg = (Math.asin(Math.max(-1, Math.min(1, v[1]))) * 180) / Math.PI;
  let bearingDeg = (Math.atan2(v[0], -v[2]) * 180) / Math.PI;
  if (bearingDeg < 0) bearingDeg += 360;
  return { elevationDeg, bearingDeg };
}
