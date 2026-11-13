// Shared GLSL chunks. All opaque materials shade through `shadeSurface` so that terrain,
// vegetation, rocks and structures respond identically to sun, sky, shadows, clouds, fog and water.

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*vnoise(p); p = p*2.03 + 17.7; a *= 0.5; } return s; }
float ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

export const DEPTH_GLSL = /* glsl */ `
uniform vec4 uProjInfo; // x = proj[2][2], y = proj[3][2], z = tan(fov/2)*aspect, w = tan(fov/2)
// view-space distance along -Z from a depth-buffer value
float linearDepth(float d){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return uProjInfo.y / (d + uProjInfo.x);
#else
  float ndc = d * 2.0 - 1.0;
  return uProjInfo.y / (ndc + uProjInfo.x);
#endif
}
bool isSkyDepth(float d){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return d <= 0.0;
#else
  return d >= 1.0;
#endif
}
`;

export const GLOBALS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSH[9];
uniform samplerCube uEnvMap;
uniform float uEnvMaxMip;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uClipY;       // > -1e8: reflection pass, discard below this height
uniform vec4 uWorldRect;    // x = half size, y = 1/size, z = texel (1/res), w = cell size
// atmosphere / fog
uniform sampler2D uSkyLUT;
uniform vec3 uBetaR;        // Rayleigh scattering at datum (1/m)
uniform vec4 uHaze;         // x = Mie extinction at datum, y = scale height, z = ground fog density, w = ground fog height
uniform float uDatum;       // altitude of the atmosphere reference level (m)
uniform vec4 uCloudShadow;  // x = coverage, y = cloud base altitude, z = strength, w = scale
uniform vec2 uCloudOffset;
// water (for underwater shading / wetness of opaque surfaces)
uniform highp sampler2D uWaterA;  // r = surface elevation, g/b = velocity, a = shore distance
uniform vec4 uSea;          // x = enabled, y = level, z = swash amplitude, w = swash phase speed
uniform vec3 uWaterAbsorb;
uniform vec3 uWaterScatter;
uniform sampler2D uCaustics;
uniform vec4 uCausticParams; // x = strength, y = tile size, z = time, w = turbidity
uniform float uWetness;      // global rain wetness 0..1
`;

export const SHADOW_GLSL = /* glsl */ `
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uShadowMat[4];
uniform vec4 uShadowSplits;
uniform vec4 uShadowTexel;   // x = 1/atlas, y = world texel size of cascade 0, z = fade distance, w = enabled
uniform float uShadowTexW[4]; // world texel size of each cascade

float shadowCascade(int c, vec3 wp, vec3 N, float NoL){
  // Receiver offset in world space, proportional to the cascade's texel size: along the normal
  // (grows with the sine of the incidence angle) and towards the sun (slope-scaled depth bias,
  // grows with the tangent) so grazing light does not produce acne stripes in the far cascades.
  float texelW = uShadowTexW[c];
  float sinT = sqrt(max(1.0 - NoL * NoL, 0.0));
  float tanT = min(sinT / max(NoL, 0.03), 14.0);
  vec3 p = wp + N * texelW * (1.0 + 2.4 * sinT) + uSunDir * texelW * (0.35 + 0.8 * tanT);
  vec4 sc = uShadowMat[c] * vec4(p, 1.0);
  vec3 uvz = sc.xyz;
  vec2 tile = vec2(float(c & 1), float(c >> 1)) * 0.5;
  vec2 uv = uvz.xy * 0.5 + tile;
  vec2 lo = tile + uShadowTexel.x * 1.5, hi = tile + 0.5 - uShadowTexel.x * 1.5;
  if (uv.x < lo.x || uv.y < lo.y || uv.x > hi.x || uv.y > hi.y) return 1.0;
#ifdef USE_REVERSED_DEPTH_BUFFER
  float ref = uvz.z + 0.00003;
  if (ref > 1.0) return 1.0;
#else
  float ref = uvz.z - 0.00003;
  if (ref < 0.0) return 1.0;
#endif
  // 3x3 tent PCF using bilinear hardware comparisons
  vec2 t = uShadowTexel.xx;
  float s = 0.0;
  s += texture(uShadowMap, vec3(uv + vec2(-1.0, -1.0) * t, ref));
  s += texture(uShadowMap, vec3(uv + vec2( 1.0, -1.0) * t, ref));
  s += texture(uShadowMap, vec3(uv + vec2(-1.0,  1.0) * t, ref));
  s += texture(uShadowMap, vec3(uv + vec2( 1.0,  1.0) * t, ref));
  s += texture(uShadowMap, vec3(uv, ref)) * 2.0;
  s += texture(uShadowMap, vec3(uv + vec2(-1.5, 0.0) * t, ref)) * 0.75;
  s += texture(uShadowMap, vec3(uv + vec2( 1.5, 0.0) * t, ref)) * 0.75;
  s += texture(uShadowMap, vec3(uv + vec2(0.0, -1.5) * t, ref)) * 0.75;
  s += texture(uShadowMap, vec3(uv + vec2(0.0,  1.5) * t, ref)) * 0.75;
  return s / 9.0;
}

float sunShadow(vec3 wp, vec3 N, float viewDepth){
  if (uShadowTexel.w < 0.5) return 1.0;
  float NoL = clamp(dot(N, uSunDir), 0.0, 1.0);
  int c = viewDepth < uShadowSplits.x ? 0 : viewDepth < uShadowSplits.y ? 1 : viewDepth < uShadowSplits.z ? 2 : 3;
  float s = shadowCascade(c, wp, N, NoL);
  // blend into the next cascade near the split to hide the resolution change
  float splitD = c == 0 ? uShadowSplits.x : c == 1 ? uShadowSplits.y : c == 2 ? uShadowSplits.z : uShadowSplits.w;
  float f = smoothstep(splitD * 0.86, splitD, viewDepth);
  if (f > 0.0) {
    float s2 = c < 3 ? shadowCascade(c + 1, wp, N, NoL) : 1.0;
    s = mix(s, s2, f);
  }
  return s;
}
`;

export const ATMOS_GLSL = /* glsl */ `
vec2 skyLutUV(vec3 d){
  float az = atan(d.z, d.x);
  float el = asin(clamp(d.y, -1.0, 1.0));
  // non-linear elevation mapping concentrating texels at the horizon
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
  return vec2(az / 6.2831853 + 0.5, v);
}
vec3 skyLutSmooth(sampler2D lut, vec2 uv){
  // cubic B-spline in elevation (two bilinear taps): piecewise-linear filtering of the stretched
  // elevation axis shows as thin horizontal lines (Mach bands) in a clear sky
  float H = float(textureSize(lut, 0).y);
  float y = uv.y * H - 0.5; float iy = floor(y); float f = y - iy;
  float f2 = f * f, f3 = f2 * f;
  float w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0, w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  float g0 = w0 + w1, g1 = w2 + w3;
  float y0 = (iy - 0.5 + w1 / g0) / H, y1 = (iy + 1.5 + w3 / g1) / H;
  return g0 * textureLod(lut, vec2(uv.x, clamp(y0, 0.5 / H, 1.0 - 0.5 / H)), 0.0).rgb + g1 * textureLod(lut, vec2(uv.x, clamp(y1, 0.5 / H, 1.0 - 0.5 / H)), 0.0).rgb;
}
vec3 skyRadiance(vec3 d){ return skyLutSmooth(uSkyLUT, skyLutUV(d)); }

float cloudShadowAt(vec3 wp){
  if (uCloudShadow.z <= 0.0) return 1.0;
  // project along the sun direction to the cloud base
  float t = (uCloudShadow.y - wp.y) / max(uSunDir.y, 0.08);
  vec2 p = (wp.xz + uSunDir.xz * t) * uCloudShadow.w + uCloudOffset;
  float n = fbm2(p) * 0.65 + fbm2(p * 2.7 + 9.1) * 0.35;
  float cov = uCloudShadow.x;
  float d = smoothstep(1.0 - cov - 0.08, 1.0 - cov + 0.22, n * 1.25);
  return 1.0 - d * uCloudShadow.z;
}

// optical depth of an exponential-height medium along a segment
float expOpticalDepth(float density0, float invH, float y0, float dy, float len){
  float a = dy * invH;
  float f = abs(a) < 1e-3 ? 1.0 : (1.0 - exp(-a)) / a;
  return density0 * exp(-(y0 - uDatum) * invH) * len * f;
}

// aerial perspective: returns transmittance in a, in-scattered radiance in rgb
vec4 aerialPerspective(vec3 wp, out vec3 trans){
  vec3 v = wp - uCamPos;
  float len = length(v);
  vec3 dir = v / max(len, 1e-3);
  float dy = v.y;
  float odR = expOpticalDepth(1.0, 1.0 / 8000.0, uCamPos.y, dy, len);
  float odM = expOpticalDepth(uHaze.x, 1.0 / uHaze.y, uCamPos.y, dy, len);
  float odF = expOpticalDepth(uHaze.z, 1.0 / uHaze.w, uCamPos.y, dy, len);
  trans = exp(-(uBetaR * odR + vec3(odM + odF)));
  // in-scatter colour: sky radiance towards the horizon in the view azimuth, plus the sun's forward lobe in haze
  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.35 + 0.015, dir.z));
  vec3 sky = skyRadiance(hd);
  float mu = dot(dir, uSunDir);
  float g = 0.76;
  float phaseM = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*mu, 1.5) * 0.0796;
  vec3 hazeCol = sky + uSunColor * phaseM * 0.35 * (1.0 - exp(-(odM + odF) * 3.0)) * smoothstep(-0.05, 0.1, uSunDir.y);
  vec3 ins = hazeCol * (1.0 - trans);
  return vec4(ins, dot(trans, vec3(0.3333)));
}

vec3 applyFog(vec3 col, vec3 wp){
  vec3 tr;
  vec4 ap = aerialPerspective(wp, tr);
  return col * tr + ap.rgb;
}
`;

export const LIGHTING_GLSL = /* glsl */ `
struct Surface {
  vec3 albedo;
  vec3 N;         // shading normal
  vec3 Ng;        // geometric / low-frequency normal (shadow offset)
  float roughness;
  float ao;
  float f0;
  float translucency; // 0..1 thin-leaf transmission
  float porosity;     // 0..1 how strongly wetness darkens the albedo
  float wet;          // extra wetness from the caller (0..1)
};

vec3 shIrradiance(vec3 n){
  return uSH[0]
    + uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x
    + uSH[4] * (n.x * n.y) + uSH[5] * (n.y * n.z) + uSH[6] * (3.0 * n.z * n.z - 1.0)
    + uSH[7] * (n.x * n.z) + uSH[8] * (n.x * n.x - n.y * n.y);
}

float D_GGX(float NoH, float a){ float a2 = a*a; float d = NoH*NoH*(a2-1.0)+1.0; return a2 / (3.14159265 * d * d + 1e-6); }
float V_SmithGGX(float NoV, float NoL, float a){ float a2 = a*a; float gv = NoL * sqrt(NoV*NoV*(1.0-a2)+a2); float gl = NoV * sqrt(NoL*NoL*(1.0-a2)+a2); return 0.5 / (gv + gl + 1e-5); }
vec3 envBRDFApprox(vec3 f0, float rough, float NoV){
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022), c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x*r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * AB.x + AB.y;
}

// Water state at a world position. Returns surface elevation (or very low if none).
float waterSurfaceAt(vec3 wp, out float shoreDist){
  vec2 uv = (wp.xz + uWorldRect.x) * uWorldRect.y;
  shoreDist = -64.0;
  float surf = -1e5;
  if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
    vec4 w = textureLod(uWaterA, uv, 0.0);
    // bilinear filtering across the no-water sentinel produces garbage: reject mixed samples
    if (w.r > -5e4) { surf = w.r; shoreDist = w.a; }
    if (w.r <= -5e4 && w.r > -9.9e4) {
      vec2 ts = vec2(textureSize(uWaterA, 0));
      vec4 wn = texelFetch(uWaterA, ivec2(uv * ts), 0);
      if (wn.r > -5e4) { surf = wn.r; shoreDist = wn.a; }
    }
  } else if (uSea.x > 0.5) { surf = uSea.y; shoreDist = 64.0; }
  // open coast: the swash zone can reach beyond the extended surface stored in the texture;
  // low ground next to the sea is treated as within reach of the sea level
  if (surf <= -5e4 && uSea.x > 0.5 && wp.y < uSea.y + uSea.z + 0.9) { surf = uSea.y; shoreDist = -6.0; }
  return surf;
}

// Caustic intensity (1 = no modulation) for a point below the water surface.
float causticsAt(vec3 wp, float depth){
  if (uCausticParams.x <= 0.0) return 1.0;
  // refracted sun direction (Snell, n = 1.333)
  vec3 L = refract(-uSunDir, vec3(0.0, 1.0, 0.0), 0.75);
  vec2 p = wp.xz - L.xz / max(-L.y, 0.2) * depth;
  // focus: sharpest around 0.3 - 1.5 m, defocused with depth and turbidity
  // Deeper water is lit by longer waves: the pattern grows with depth (focal length) instead of
  // only blurring, so a bed two metres down still shows a clear, coarser net of light.
  float grow = 0.8 + 0.22 * min(depth, 7.0);
  float lod = clamp(depth * 0.05 + uCausticParams.w * 0.9, 0.0, 6.0);
  vec2 uv = p / (uCausticParams.y * grow);
  float c = textureLod(uCaustics, uv, lod).r;
  float c2 = textureLod(uCaustics, uv * 0.37 + 0.31, lod + 0.5).r;
  // the map stores light concentration (mean ~1); compress the peaks so filaments stay plausible
  float k = c * mix(1.0, c2, 0.25);
  k = 0.42 + 0.98 * k / (1.0 + 0.3 * k);   // dark network with bright filaments (0.42 .. ~3), mean near 1
  float shallow = smoothstep(0.0, 0.25, depth);
  float fade = exp(-depth * (0.1 + uCausticParams.w * 0.5));
  float sunUp = smoothstep(0.05, 0.35, uSunDir.y);
  return mix(1.0, k, clamp(uCausticParams.x * shallow * fade * sunUp, 0.0, 1.0));
}

// Returns shaded colour in rgb and the fraction of radiance due to direct sun in a.
vec4 shadeSurface(Surface s, vec3 wp, float viewDepth, float extraShadow){
  vec3 V = normalize(uCamPos - wp);
  vec3 N = s.N;
  float NoV = clamp(abs(dot(N, V)), 0.02, 1.0);

  // ---- water interaction: wet banks above the waterline, absorption + caustics below ----
  float shoreDist = -64.0;
#ifdef NO_WATER_FX
  float surf = -1e5;
#else
  float surf = waterSurfaceAt(wp, shoreDist);
#endif
  float depth = surf - wp.y;                 // > 0 under water
  float wet = max(s.wet, uWetness);
  vec3 sunAtten = vec3(1.0);
  float caust = 1.0;
  if (surf > -5e4) {
    // capillary fringe + splash zone: wider on the open coast where swash runs up the beach
    float swash = uSea.x > 0.5 && abs(surf - uSea.y) < 0.01 ? uSea.z : 0.0;
    // (lake and river margins: capillary rise in gravel plus the reach of wavelets, a hand's width or two)
    float fringe = 0.16 + swash + 0.16 * vnoise(wp.xz * 0.9) + 0.05 * vnoise(wp.xz * 4.3);
    float w = 1.0 - smoothstep(fringe * 0.35, fringe, -depth);
    w *= smoothstep(-10.0 - swash * 60.0, -0.5, shoreDist);
    wet = max(wet, w);
    if (depth > 0.0) {
      wet = 1.0;
      // downwelling sunlight travels depth / cos(refracted angle) through water
      float pathLen = depth / max(0.35, refract(-uSunDir, vec3(0.0,1.0,0.0), 0.75).y * -1.0);
      sunAtten = exp(-(uWaterAbsorb + uWaterScatter * 0.5) * pathLen);
      caust = causticsAt(wp, depth);
    }
  }
  vec3 albedo = s.albedo;
  float rough = s.roughness;
  float f0 = s.f0;
  if (wet > 0.0) {
    // wet porous materials darken and saturate; a thin water film makes them glossier
    float dark = mix(1.0, 0.30 + 0.3 * (1.0 - s.porosity), wet * min(1.0, s.porosity * 1.25));
    vec3 sat = mix(vec3(dot(albedo, vec3(0.299, 0.587, 0.114))), albedo, 1.0 + 0.12 * wet);
    albedo = max(sat, 0.0) * dark;
    rough = mix(rough, min(rough, 0.16 + 0.25 * (1.0 - s.porosity)), wet * 0.9);
    f0 = mix(f0, 0.025, wet);
    // A submerged surface has no air interface: the index step water -> mineral is small, so there
    // is no glossy sun highlight on the bed (it would show through the water as a glowing patch).
    float sub = smoothstep(0.0, 0.04, depth);
    f0 = mix(f0, 0.003, sub);
    rough = mix(rough, max(s.roughness, 0.6), sub);
  }

  // ---- direct sun ----
  float NoLraw = dot(N, uSunDir);
  float NoL = clamp(NoLraw, 0.0, 1.0);
  float shadow = sunShadow(wp, s.Ng, viewDepth) * extraShadow;
  float cs = cloudShadowAt(wp);
  vec3 sun = uSunColor * shadow * cs * sunAtten * caust;
  vec3 H = normalize(V + uSunDir);
  float NoH = clamp(dot(N, H), 0.0, 1.0);
  float VoH = clamp(dot(V, H), 0.0, 1.0);
  float a = max(rough * rough, 0.003);
  float F = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
  vec3 direct = albedo * (1.0 - F) * NoL / 3.14159265 + vec3(D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a) * F * NoL);
  // thin translucent foliage: light transmitted through the leaf, tinted
  if (s.translucency > 0.0) {
    float back = clamp(-NoLraw, 0.0, 1.0) * 0.6 + 0.15;
    float viewT = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 3.0) * 0.6 + 0.4;
    direct += albedo * vec3(1.05, 1.15, 0.55) * s.translucency * back * viewT / 3.14159265;
  }
  vec3 Ld = direct * sun;

  // ---- ambient: sky irradiance (SH) + specular environment ----
  vec3 irr = max(shIrradiance(N), vec3(0.0));
  // underwater ambient is attenuated by the water column
  vec3 ambAtten = depth > 0.0 ? exp(-(uWaterAbsorb + uWaterScatter * 0.5) * depth * 1.2) : vec3(1.0);
  vec3 R = reflect(-V, N);
  float specOcc = clamp(pow(NoV + s.ao, exp2(-16.0 * rough - 1.0)) - 1.0 + s.ao, 0.0, 1.0);
  vec3 envSpec = textureLod(uEnvMap, R, rough * uEnvMaxMip).rgb * envBRDFApprox(vec3(f0), rough, NoV);
  // reflections of the sky are occluded where the reflection vector dives below the local horizon
  float horizon = clamp(1.0 + 1.3 * dot(R, s.Ng), 0.0, 1.0);
  vec3 La = (albedo * irr / 3.14159265 * s.ao + envSpec * specOcc * horizon * horizon) * ambAtten * mix(1.0, cs, 0.35);
  if (s.translucency > 0.0) La += albedo * max(shIrradiance(-N), vec3(0.0)) / 3.14159265 * s.translucency * 0.5 * s.ao;

  vec3 col = Ld + La;
  float sunFrac = dot(Ld, vec3(0.3)) / max(dot(col, vec3(0.3)), 1e-5);
  // ---- in-water scattering between the surface point and the eye is added by the water pass;
  //      aerial perspective for above-water geometry ----
  vec3 tr;
  vec4 ap = aerialPerspective(wp, tr);
  col = col * tr + ap.rgb;
  return vec4(col, clamp(sunFrac * dot(tr, vec3(0.333)), 0.0, 1.0));
}
`;

export const TONEMAP_GLSL = /* glsl */ `
// AgX (Troy Sobotka), minimal fit by Benjamin Wrensch - restrained highlight roll-off
vec3 agxDefaultContrastApprox(vec3 x){
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 val){
  const mat3 agx_mat = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                            0.0784335999999992, 0.878468636469772, 0.0784336,
                            0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float min_ev = -12.47393, max_ev = 4.026069;
  val = agx_mat * val;
  val = clamp(log2(max(val, 1e-10)), min_ev, max_ev);
  val = (val - min_ev) / (max_ev - min_ev);
  return agxDefaultContrastApprox(val);
}
vec3 agxEotf(vec3 val){
  const mat3 agx_mat_inv = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                                -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                                -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  val = agx_mat_inv * val;
  return val; // already display-referred (sRGB-encoded 2.2) per the minimal fit
}
vec3 agxLook(vec3 val, float sat, float contrast){
  float luma = dot(val, vec3(0.2126, 0.7152, 0.0722));
  val = pow(val, vec3(contrast));
  return luma + sat * (val - luma);
}
`;
