// Physically based sky: Rayleigh + Mie + ozone atmosphere (transmittance / multiple-scattering /
// sky-view LUTs after Hillaire 2020), sun disc, ray-marched volumetric cloud layer with temporal
// accumulation, environment cube for reflections and SH irradiance for ambient light.

import * as THREE from 'three';
import { NOISE_GLSL } from './shaders/common.glsl.js';

const RG = 6360e3;
const RT = 6460e3;

const ATMO_COMMON = /* glsl */ `
precision highp float;
const float RG = 6360e3;
const float RT = 6460e3;
const float PI = 3.14159265358979;
uniform vec3 uBetaR0;      // Rayleigh scattering
uniform float uBetaM0;     // Mie scattering
uniform float uBetaMa0;    // Mie absorption
uniform vec3 uBetaO0;      // ozone absorption
uniform float uMieG;
float densR(float h){ return exp(-max(h, 0.0) / 8000.0); }
float densM(float h){ return exp(-max(h, 0.0) / 1200.0); }
float densO(float h){ return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }
vec3 extinction(float h){ return uBetaR0 * densR(h) + vec3((uBetaM0 + uBetaMa0) * densM(h)) + uBetaO0 * densO(h); }
// distance to sphere of radius R from point at radius r, direction cos mu; -1 if no hit
float raySphere(float r, float mu, float R){
  float disc = r * r * (mu * mu - 1.0) + R * R;
  if (disc < 0.0) return -1.0;
  float sq = sqrt(disc);
  float t = -r * mu - sq;
  if (t < 0.0) t = -r * mu + sq;
  return t;
}
bool hitsGround(float r, float mu){
  float disc = r * r * (mu * mu - 1.0) + RG * RG;
  return mu < 0.0 && disc >= 0.0;
}
vec2 transUV(float h, float mu){ return vec2(mu * 0.5 + 0.5, sqrt(clamp(h / (RT - RG), 0.0, 1.0))); }
float phaseR(float mu){ return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g){ float g2 = g*g; return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu*mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0*g*mu, 1.5)); }
`;

const FS_VERT = /* glsl */ `
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const TRANS_FRAG = ATMO_COMMON + /* glsl */ `
in vec2 vUv; out vec4 outColor;
void main(){
  float mu = vUv.x * 2.0 - 1.0;
  float h = vUv.y * vUv.y * (RT - RG);
  float r = RG + h;
  vec3 od = vec3(0.0);
  if (hitsGround(r, mu)) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float tmax = raySphere(r, mu, RT);
  const int N = 48;
  float dt = tmax / float(N);
  for (int i = 0; i < N; i++) {
    float t = (float(i) + 0.5) * dt;
    float hh = sqrt(r*r + t*t + 2.0*r*mu*t) - RG;
    od += extinction(hh) * dt;
  }
  outColor = vec4(exp(-od), 1.0);
}`;

const MS_FRAG = ATMO_COMMON + /* glsl */ `
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTrans;
void main(){
  float sunMu = vUv.x * 2.0 - 1.0;
  float h = vUv.y * (RT - RG);
  float r = RG + h + 1.0;
  vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - sunMu*sunMu)), sunMu, 0.0);
  vec3 lum = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++) {
    float u = (float(i) + 0.5) / float(SQ), v = (float(j) + 0.5) / float(SQ);
    float ct = 1.0 - 2.0 * u; float st = sqrt(max(0.0, 1.0 - ct*ct)); float ph = 2.0 * PI * v;
    vec3 d = vec3(st * cos(ph), ct, st * sin(ph));
    float mu = d.y;
    bool ground = hitsGround(r, mu);
    float tmax = ground ? raySphere(r, mu, RG) : raySphere(r, mu, RT);
    const int N = 20;
    float dt = tmax / float(N);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    for (int k = 0; k < N; k++) {
      float t = (float(k) + 0.5) * dt;
      vec3 p = vec3(0.0, r, 0.0) + d * t;
      float rr = length(p); float hh = rr - RG;
      vec3 ext = extinction(hh);
      vec3 sca = uBetaR0 * densR(hh) + vec3(uBetaM0 * densM(hh));
      float sMu = dot(p, sunDir) / rr;
      vec3 Ts = hitsGround(rr, sMu) ? vec3(0.0) : texture(uTrans, transUV(hh, sMu)).rgb;
      vec3 stepT = exp(-ext * dt);
      vec3 S = sca * Ts / (4.0 * PI);
      L += T * (S - S * stepT) / max(ext, vec3(1e-9));
      F += T * (sca - sca * stepT) / max(ext, vec3(1e-9));
      T *= stepT;
    }
    if (ground) {
      vec3 p = vec3(0.0, r, 0.0) + d * tmax;
      float sMu = dot(normalize(p), sunDir);
      L += T * texture(uTrans, transUV(0.0, sMu)).rgb * max(sMu, 0.0) * 0.3 / PI;
    }
    lum += L; fms += F;
  }
  lum /= float(SQ * SQ); fms /= float(SQ * SQ);
  outColor = vec4(lum / (1.0 - fms), 1.0);
}`;

const SKYVIEW_FRAG = ATMO_COMMON + /* glsl */ `
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTrans; uniform sampler2D uMS;
uniform vec3 uSunDirA; uniform float uCamH; uniform vec3 uSunE;
void main(){
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float s = vUv.y * 2.0 - 1.0;
  float el = sign(s) * s * s * (PI * 0.5);
  vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  float r = RG + max(uCamH, 2.0);
  float mu = d.y;
  bool ground = hitsGround(r, mu);
  float tmax = ground ? raySphere(r, mu, RG) : raySphere(r, mu, RT);
  float cosT = dot(d, uSunDirA);
  float pR = phaseR(cosT), pM = phaseM(cosT, uMieG);
  const int N = 40;
  vec3 T = vec3(1.0), L = vec3(0.0);
  float tPrev = 0.0;
  for (int k = 0; k < N; k++) {
    // quadratic distribution: more samples near the camera
    float f = (float(k) + 0.5) / float(N);
    float t = tmax * f * f;
    float tn = tmax * pow((float(k) + 1.0) / float(N), 2.0);
    float dt = tn - tPrev; tPrev = tn;
    vec3 p = vec3(0.0, r, 0.0) + d * t;
    float rr = length(p); float hh = rr - RG;
    vec3 ext = extinction(hh);
    vec3 sR = uBetaR0 * densR(hh); float sM = uBetaM0 * densM(hh);
    float sMu = dot(p, uSunDirA) / rr;
    vec3 Ts = hitsGround(rr, sMu) ? vec3(0.0) : texture(uTrans, transUV(hh, sMu)).rgb;
    vec3 ms = texture(uMS, vec2(sMu * 0.5 + 0.5, clamp(hh / (RT - RG), 0.0, 1.0))).rgb;
    vec3 S = (sR * pR + vec3(sM * pM)) * Ts + (sR + vec3(sM)) * ms;
    vec3 stepT = exp(-ext * dt);
    L += T * (S - S * stepT) / max(ext, vec3(1e-9));
    T *= stepT;
  }
  outColor = vec4(L * uSunE, 1.0);
}`;

// ---- cloud density shared by the cloud pass and the low-quality in-dome march ----
const CLOUD_COMMON = /* glsl */ `
uniform highp sampler3D uCloudNoise;
uniform vec4 uCloudParams;  // x = coverage, y = base altitude, z = thickness, w = density
uniform vec3 uCloudWind;    // xy = offset (m), z = time
uniform vec3 uSunDirC;
uniform vec3 uSunColC;
uniform vec3 uSkyTop;
uniform vec3 uSkyBot;
float remap(float v, float a, float b, float c, float d){ return c + (v - a) / (b - a) * (d - c); }
float cloudDensity(vec3 p, bool cheap){
  float h = (p.y - uCloudParams.y) / uCloudParams.z;
  if (h < 0.0 || h > 1.0) return 0.0;
  vec3 q = p; q.xz += uCloudWind.xy;
  // coverage field: large weather patterns + cumulus cells
  vec4 lowf = textureLod(uCloudNoise, q * (1.0 / 6200.0) + vec3(0.0, 0.0, 0.13), 0.0);
  float weather = textureLod(uCloudNoise, vec3(q.xz / 31000.0, 0.37), 0.0).r;
  float cov = clamp(uCloudParams.x * 1.2 + (weather - 0.3) * 0.8, 0.0, 1.0);
  // height profile: flat base, rounded top that rises with local coverage
  float topH = mix(0.35, 1.0, cov);
  float prof = smoothstep(0.0, 0.08, h) * smoothstep(topH, topH * 0.45, h);
  float base = clamp((lowf.r * 0.65 + lowf.g * 0.35 - 0.16) / 0.52, 0.0, 1.0);
  float d = remap(base, 1.0 - cov, 1.0, 0.0, 1.0) * prof;
  if (d <= 0.0) return 0.0;
  if (!cheap) {
    // two octaves of erosion carve billows into the edges (wispier towards the base)
    vec4 hi = textureLod(uCloudNoise, q * (1.0 / 1300.0) + vec3(0.0, uCloudWind.z * 0.004, 0.0), 0.0);
    vec4 hi2 = textureLod(uCloudNoise, q * (1.0 / 410.0) + vec3(0.3, uCloudWind.z * 0.009, 0.1), 0.0);
    float er = hi.g * 0.5 + hi.b * 0.3 + hi2.b * 0.2;
    d = remap(d, er * 0.5 * (1.0 - h * 0.35), 1.0, 0.0, 1.0);
  }
  return max(d, 0.0) * uCloudParams.w;
}
float hg(float mu, float g){ float g2 = g*g; return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0*g*mu, 1.5)); }
// returns premultiplied radiance in rgb, transmittance in a
vec4 marchClouds(vec3 ro, vec3 rd, float jitter, int steps, float maxDist){
  if (uCloudParams.x <= 0.001) return vec4(0.0, 0.0, 0.0, 1.0);
  // intersect the shell [base, base+thickness] on a sphere so the layer curves down to the horizon
  const float R = 6360e3;
  float r0 = R + ro.y;
  float mu = rd.y;
  float rb = R + uCloudParams.y, rt = R + uCloudParams.y + uCloudParams.z;
  float t0, t1;
  float db = r0*r0*(mu*mu - 1.0) + rb*rb;
  float dtp = r0*r0*(mu*mu - 1.0) + rt*rt;
  if (r0 < rb) { if (dtp < 0.0) return vec4(0,0,0,1); t0 = -r0*mu + sqrt(max(db, 0.0)); t1 = -r0*mu + sqrt(dtp); }
  else if (r0 > rt) { if (mu >= 0.0 || dtp < 0.0) return vec4(0,0,0,1); t0 = -r0*mu - sqrt(dtp); t1 = db > 0.0 ? -r0*mu - sqrt(db) : -r0*mu + sqrt(dtp); }
  else { t0 = 0.0; t1 = (mu < 0.0 && db > 0.0) ? -r0*mu - sqrt(db) : -r0*mu + sqrt(dtp); }
  if (t0 > maxDist || t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, maxDist);
  float dt = (t1 - t0) / float(steps);
  float cosT = dot(rd, uSunDirC);
  float phase = mix(hg(cosT, 0.8), hg(cosT, -0.25), 0.3) + 0.06;
  vec3 L = vec3(0.0); float T = 1.0;
  float tAvg = 0.0, wAvg = 0.0;
  for (int i = 0; i < steps; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    p.y = length(vec3(p.x, p.y + R, p.z)) - R;
    float d = cloudDensity(p, false);
    if (d > 0.001) {
      // light march towards the sun
      float od = 0.0; float ls = uCloudParams.z * 0.16;
      for (int k = 1; k <= 5; k++) {
        vec3 lp = p + uSunDirC * ls * (float(k) - 0.5);
        od += cloudDensity(lp, true) * ls;
        ls *= 1.35;
      }
      float ext = d * 0.045;
      float beers = exp(-od * 0.045);
      // multiple-scattering approximation: a second, softer octave of Beer's law + powder effect
      float ms = exp(-od * 0.045 * 0.25) * 0.55;
      float powder = 1.0 - exp(-d * 0.09 * 2.0);
      float h = clamp((p.y - uCloudParams.y) / uCloudParams.z, 0.0, 1.0);
      vec3 amb = mix(uSkyBot, uSkyTop, h) * (0.55 + 0.45 * h);
      vec3 S = uSunColC * (beers * phase * 2.2 + ms * 0.2) * mix(1.0, powder, 0.5) + amb * 0.36;
      float stepT = exp(-ext * dt);
      L += T * S * (1.0 - stepT);
      tAvg += t * T * (1.0 - stepT); wAvg += T * (1.0 - stepT);
      T *= stepT;
      if (T < 0.01) { T = 0.0; break; }
    }
  }
  float dist = wAvg > 0.0 ? tAvg / wAvg : t0;
  return vec4(L, T) * vec4(1.0, 1.0, 1.0, 1.0) + vec4(0.0, 0.0, 0.0, 0.0) * dist;
}
`;

const NOISE3D_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform float uLayer; uniform float uSize;
vec3 hash33(vec3 p){ p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453123); }
float worley(vec3 p, float freq){
  p *= freq; vec3 id = floor(p), f = fract(p); float md = 1.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(x, y, z);
    vec3 h = hash33(mod(id + o, freq));
    vec3 d = o + h - f; md = min(md, dot(d, d));
  }
  return 1.0 - sqrt(md);
}
float gnoise(vec3 p, float freq){
  p *= freq; vec3 i = floor(p), f = fract(p); vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float r = 0.0;
  float n[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 g = hash33(mod(i + o, freq)) * 2.0 - 1.0;
    n[k] = dot(g, f - o);
  }
  r = mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
  return r * 0.5 + 0.5;
}
void main(){
  vec3 p = vec3(vUv, uLayer);
  float perlin = 0.0, a = 0.5, fq = 4.0;
  for (int i = 0; i < 4; i++) { perlin += a * gnoise(p, fq); fq *= 2.0; a *= 0.5; }
  perlin = clamp((perlin - 0.22) / 0.56, 0.0, 1.0);
  float w1 = worley(p, 4.0) * 0.625 + worley(p, 8.0) * 0.25 + worley(p, 16.0) * 0.125;
  float pw = clamp((perlin - (1.0 - w1) * 0.55) / (1.0 - (1.0 - w1) * 0.55), 0.0, 1.0);
  float w2 = worley(p, 6.0) * 0.625 + worley(p, 12.0) * 0.25 + worley(p, 24.0) * 0.125;
  float w3 = worley(p, 12.0) * 0.625 + worley(p, 24.0) * 0.25 + worley(p, 48.0) * 0.125;
  float w4 = worley(p, 24.0) * 0.7 + worley(p, 48.0) * 0.3;
  outColor = vec4(pw, w2, w3, w4);
}`;

const CLOUD_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv; out vec4 outColor;
${NOISE_GLSL}
${CLOUD_COMMON}
uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj;
uniform vec3 uCamPosC; uniform sampler2D uHistory; uniform float uFrame; uniform float uBlend;
uniform sampler2D uSkyLUTc;
vec2 skyLutUV(vec3 d){ float az = atan(d.z, d.x); float el = asin(clamp(d.y, -1.0, 1.0)); float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963); return vec2(az / 6.2831853 + 0.5, v); }
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

void main(){
  vec4 f = uInvViewProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
  vec3 rd = normalize(f.xyz / f.w - uCamPosC);
  float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803398875);
  vec4 c = marchClouds(uCamPosC, rd, jit, 64, 70000.0);
  // distance haze: fade cloud radiance into the sky colour near the horizon
  float hz = smoothstep(0.16, 0.0, rd.y);
  vec3 sky = skyLutSmooth(uSkyLUTc, skyLutUV(rd));
  c.rgb = mix(c.rgb, sky * (1.0 - c.a), hz * 0.85);
  // temporal accumulation: reproject a far point along this view ray into the previous frame
  vec4 pc = uPrevViewProj * vec4(uCamPosC + rd * 30000.0, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float valid = (pc.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) ? 1.0 : 0.0;
  vec4 h = texture(uHistory, puv);
  outColor = mix(c, h, valid * (1.0 - uBlend));
}`;

const SKY_VERT = /* glsl */ `
out vec3 vDir;
uniform mat4 uInvProj; uniform mat4 uInvView;
void main(){
  vec4 v = uInvProj * vec4(position.xy, 0.5, 1.0);
  vDir = mat3(uInvView) * (v.xyz / v.w);
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position = vec4(position.xy, 0.0, 1.0);
#else
  gl_Position = vec4(position.xy, 1.0, 1.0);
#endif
}`;

const SKY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec3 vDir; out vec4 outColor;
${NOISE_GLSL}
${CLOUD_COMMON}
uniform sampler2D uSkyLUT; uniform sampler2D uCloudTex; uniform vec2 uResolution;
uniform vec3 uSunDir; uniform vec3 uSunDisc; uniform vec3 uGroundCol; uniform vec3 uCamPos;
uniform float uUseCloudTex;
vec2 skyLutUV(vec3 d){ float az = atan(d.z, d.x); float el = asin(clamp(d.y, -1.0, 1.0)); float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963); return vec2(az / 6.2831853 + 0.5, v); }
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

void main(){
  vec3 d = normalize(vDir);
  vec3 col = skyLutSmooth(uSkyLUT, skyLutUV(d));
  // below the horizon: far ground / sea colour seen through the atmosphere (already in the LUT as dark) -> blend
  float below = smoothstep(0.0, -0.06, d.y);
  col = mix(col, uGroundCol, below * 0.85);
  vec4 cl;
  if (uUseCloudTex > 0.5) cl = texture(uCloudTex, gl_FragCoord.xy / uResolution);
  else {
    cl = marchClouds(uCamPos, d, 0.5, 20, 60000.0);
    float hz = smoothstep(0.16, 0.0, d.y);
    cl.rgb = mix(cl.rgb, col * (1.0 - cl.a), hz * 0.85);
  }
  // sun disc with limb darkening
  float mu = dot(d, uSunDir);
  float ang = acos(clamp(mu, -1.0, 1.0));
  const float SUN_R = 0.00465 * 1.6;
  float disc = smoothstep(SUN_R, SUN_R * 0.82, ang);
  float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - pow(ang / SUN_R, 2.0))));
  vec3 sun = uSunDisc * disc * limb * step(0.0, d.y + 0.01);
  float glow = exp(-ang * 55.0) * 0.012 + exp(-ang * 9.0) * 0.0006;
  col += (sun + uSunDisc * glow * 0.02) * cl.a * cl.a;
  col = col * cl.a + cl.rgb;
  outColor = vec4(col, 0.0);
}`;

function fsQuadGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

export class FullscreenPass {
  constructor(material) {
    this.mesh = new THREE.Mesh(fsQuadGeometry(), material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  set material(m) {
    this.mesh.material = m;
  }
  get material() {
    return this.mesh.material;
  }
  render(renderer, target, layerOrFace) {
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    if (layerOrFace !== undefined) renderer.setRenderTarget(target, layerOrFace);
    else renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  }
}

export class Atmosphere {
  constructor(renderer, globals) {
    this.renderer = renderer;
    this.G = globals; // shared uniform objects
    const f = (w, h, type = THREE.HalfFloatType) =>
      new THREE.WebGLRenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.transRT = f(256, 64, THREE.FloatType);
    this.msRT = f(32, 32, THREE.FloatType);
    this.skyRT = f(256, 144, THREE.FloatType);
    this.skyRT.texture.wrapS = THREE.RepeatWrapping;
    const atmoU = {
      uBetaR0: { value: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6) },
      uBetaM0: { value: 3.996e-6 },
      uBetaMa0: { value: 4.4e-6 },
      uBetaO0: { value: new THREE.Vector3(0.65e-6, 1.881e-6, 0.085e-6) },
      uMieG: { value: 0.8 },
    };
    this.atmoU = atmoU;
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: frag, uniforms: { ...atmoU, ...uniforms }, depthTest: false, depthWrite: false });
    this.transPass = new FullscreenPass(mk(TRANS_FRAG, {}));
    this.msPass = new FullscreenPass(mk(MS_FRAG, { uTrans: { value: this.transRT.texture } }));
    this.skyU = { uTrans: { value: this.transRT.texture }, uMS: { value: this.msRT.texture }, uSunDirA: { value: new THREE.Vector3(0, 1, 0) }, uCamH: { value: 100 }, uSunE: { value: new THREE.Vector3(1, 1, 1) } };
    this.skyPass = new FullscreenPass(mk(SKYVIEW_FRAG, this.skyU));

    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
    this.sunE = 22.0; // solar irradiance scale (scene units)
    this.sunColor = new THREE.Vector3(1, 1, 1);
    this.turbidity = 2.2;
    this.lutDirty = true;
    this.skyDirty = true;
    this.envDirty = true;
    this.frame = 0;

    // ---- clouds ----
    this.cloudNoise = this._buildCloudNoise();
    this.cloudU = {
      uCloudNoise: { value: this.cloudNoise.texture },
      uCloudParams: { value: new THREE.Vector4(0.4, 1900, 1100, 1.0) },
      uCloudWind: { value: new THREE.Vector3(0, 0, 0) },
      uSunDirC: { value: this.sunDir },
      uSunColC: { value: new THREE.Vector3(1, 1, 1) },
      uSkyTop: { value: new THREE.Vector3(0.3, 0.4, 0.6) },
      uSkyBot: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
    };
    this.cloudRT = [null, null];
    this.cloudIndex = 0;
    this.cloudMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FS_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        ...this.cloudU,
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCamPosC: { value: new THREE.Vector3() },
        uHistory: { value: null },
        uFrame: { value: 0 },
        uBlend: { value: 1 },
        uSkyLUTc: { value: this.skyRT.texture },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.cloudPass = new FullscreenPass(this.cloudMat);
    this.prevViewProj = new THREE.Matrix4();
    this.cloudQuality = 0.5;

    // ---- sky dome (full-screen triangle at the far plane) ----
    this.skyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        ...this.cloudU,
        uSkyLUT: { value: this.skyRT.texture },
        uCloudTex: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uSunDir: { value: this.sunDir },
        uSunDisc: { value: new THREE.Vector3() },
        uGroundCol: { value: new THREE.Vector3(0.1, 0.12, 0.1) },
        uCamPos: { value: new THREE.Vector3() },
        uInvProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uUseCloudTex: { value: 1 },
      },
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
    });
    this.skyMesh = new THREE.Mesh(fsQuadGeometry(), this.skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = 1000;
    this.skyMesh.onBeforeRender = (r, s, camera) => {
      this.skyMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
      this.skyMat.uniforms.uInvView.value.copy(camera.matrixWorld);
      this.skyMat.uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      this.skyMat.uniforms.uCamPos.value.y -= this.datum;
      const rt = r.getRenderTarget();
      const useTex = this._mainPass === true && this.cloudRT[this.cloudIndex];
      this.skyMat.uniforms.uUseCloudTex.value = useTex ? 1 : 0;
      if (rt) this.skyMat.uniforms.uResolution.value.set(rt.width, rt.height);
    };
    this.datum = 0;

    // ---- environment cube (for specular IBL) ----
    this.envRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.envCam = new THREE.CubeCamera(1, 100000, this.envRT);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(fsQuadGeometry(), this.skyMat);
    this.envSky.frustumCulled = false;
    this.envSky.onBeforeRender = this.skyMesh.onBeforeRender;
    this.envScene.add(this.envSky);
    this.sh = [];
    for (let i = 0; i < 9; i++) this.sh.push(new THREE.Vector3());
    this.skyPixels = new Float32Array(256 * 144 * 4);
    this.groundAlbedo = new THREE.Vector3(0.12, 0.14, 0.09);
  }

  _buildCloudNoise() {
    const S = 96;
    const rt = new THREE.WebGL3DRenderTarget(S, S, S, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false });
    rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.RepeatWrapping;
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: NOISE3D_FRAG, uniforms: { uLayer: { value: 0 }, uSize: { value: S } }, depthTest: false, depthWrite: false });
    const pass = new FullscreenPass(mat);
    for (let i = 0; i < S; i++) {
      mat.uniforms.uLayer.value = (i + 0.5) / S;
      pass.render(this.renderer, rt, i);
    }
    mat.dispose();
    return rt;
  }

  /** Compute the sun direction from time of day / latitude / date / compass rotation. */
  static sunDirection(env, out = new THREE.Vector3()) {
    const lat = (env.latitude * Math.PI) / 180;
    const decl = ((23.44 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * (env.dayOfYear - 81));
    const ha = ((env.timeOfDay - 12) * 15 * Math.PI) / 180;
    const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
    const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
    // azimuth measured from south, positive towards west
    const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat));
    // world: +x east, +z south. sunAzimuth rotates the whole sun path (compass offset, degrees)
    const rot = (((env.sunAzimuth ?? 180) - 180) * Math.PI) / 180;
    const a = az + rot;
    out.set(-Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el));
    return out.normalize();
  }

  /** CPU transmittance along a ray from altitude h in direction with cos-zenith mu. */
  transmittance(h, mu) {
    const r = RG + Math.max(1, h);
    const disc = r * r * (mu * mu - 1) + RG * RG;
    if (mu < 0 && disc >= 0) return [0, 0, 0];
    const dT = r * r * (mu * mu - 1) + RT * RT;
    const tmax = -r * mu + Math.sqrt(Math.max(0, dT));
    const N = 64;
    const dt = tmax / N;
    const od = [0, 0, 0];
    const bR = this.atmoU.uBetaR0.value,
      bM = this.atmoU.uBetaM0.value + this.atmoU.uBetaMa0.value,
      bO = this.atmoU.uBetaO0.value;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * dt;
      const hh = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG;
      const dR = Math.exp(-hh / 8000),
        dM = Math.exp(-hh / 1200),
        dO = Math.max(0, 1 - Math.abs(hh - 25000) / 15000);
      od[0] += (bR.x * dR + bM * dM + bO.x * dO) * dt;
      od[1] += (bR.y * dR + bM * dM + bO.y * dO) * dt;
      od[2] += (bR.z * dR + bM * dM + bO.z * dO) * dt;
    }
    return [Math.exp(-od[0]), Math.exp(-od[1]), Math.exp(-od[2])];
  }

  /** Apply environment document settings. */
  setEnvironment(env, datum) {
    this.datum = datum;
    Atmosphere.sunDirection(env, this.sunDir);
    const turb = env.turbidity ?? 2.2;
    if (turb !== this.turbidity) {
      this.turbidity = turb;
      this.lutDirty = true;
    }
    this.atmoU.uBetaM0.value = 3.996e-6 * (0.35 + (turb - 1) * 0.9);
    this.atmoU.uBetaMa0.value = 4.4e-6 * (0.35 + (turb - 1) * 0.9);
    const cp = this.cloudU.uCloudParams.value;
    cp.x = env.cloudCover ?? 0.3;
    cp.y = (env.cloudHeight ?? 1900);
    cp.z = 900 + 700 * cp.x;
    cp.w = 1.0;
    this.cloudSpeed = env.cloudSpeed ?? 6;
    this.windDir = env.windDir ?? 0;
    this.skyDirty = true;
    this.envDirty = true;
    this.env = env;
  }

  update(dt, camera, mainW, mainH) {
    const r = this.renderer;
    const G = this.G;
    this.frame++;
    if (this.lutDirty) {
      this.transPass.render(r, this.transRT);
      this.msPass.render(r, this.msRT);
      this.lutDirty = false;
      this.skyDirty = true;
    }
    const camH = Math.max(2, camera.position.y - this.datum + 200);
    if (Math.abs(camH - this.skyU.uCamH.value) > 25) this.skyDirty = true;
    // sun
    const mu = this.sunDir.y;
    const T = this.transmittance(camH, mu);
    // soft horizon fade as the disc sets
    const fade = Math.min(1, Math.max(0, (mu + 0.035) / 0.07));
    this.sunColor.set(T[0], T[1], T[2]).multiplyScalar(this.sunE * fade);
    G.uSunDir.value.copy(this.sunDir);
    G.uSunColor.value.copy(this.sunColor);
    if (this.skyDirty) {
      this.skyU.uSunDirA.value.copy(this.sunDir);
      this.skyU.uCamH.value = camH;
      this.skyU.uSunE.value.set(this.sunE, this.sunE, this.sunE);
      this.skyPass.render(r, this.skyRT);
      this.skyDirty = false;
      this._computeAmbient();
      this.envDirty = true;
    }
    // sun disc radiance: irradiance / solid angle (scaled down; bloom restores the glare)
    const discScale = 1 / (Math.PI * Math.pow(0.00465 * 1.6, 2));
    this.skyMat.uniforms.uSunDisc.value.copy(this.sunColor).multiplyScalar(discScale * 0.02);
    // clouds
    const cw = this.cloudU.uCloudWind.value;
    cw.x += Math.cos(this.windDir) * this.cloudSpeed * dt;
    cw.y += Math.sin(this.windDir) * this.cloudSpeed * dt;
    cw.z += dt;
    this.cloudU.uSunColC.value.copy(this.sunColor);
    // haze / fog uniforms shared by all materials
    const env = this.env || {};
    G.uBetaR.value.copy(this.atmoU.uBetaR0.value);
    const fog = env.fogDensity ?? 0.2;
    G.uHaze.value.set((this.atmoU.uBetaM0.value + this.atmoU.uBetaMa0.value) * 2.2, 1200, fog * fog * 0.0022, Math.max(20, env.fogHeight ?? 200));
    G.uDatum.value = this.datum - 200;
    G.uCloudShadow.value.set(this.cloudU.uCloudParams.value.x, this.datum + this.cloudU.uCloudParams.value.y, 0.82 * Math.min(1, this.cloudU.uCloudParams.value.x * 3), 1 / 2600);
    G.uCloudOffset.value.set(cw.x / 2600, cw.y / 2600);
    this._renderClouds(camera, mainW, mainH);
    if (this.envDirty || this.frame % 90 === 0) this._renderEnv(camera);
  }

  _renderClouds(camera, mainW, mainH) {
    const w = Math.max(64, Math.round(mainW * this.cloudQuality)),
      h = Math.max(64, Math.round(mainH * this.cloudQuality));
    let reset = false;
    for (let i = 0; i < 2; i++) {
      if (!this.cloudRT[i] || this.cloudRT[i].width !== w || this.cloudRT[i].height !== h) {
        if (this.cloudRT[i]) this.cloudRT[i].dispose();
        this.cloudRT[i] = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
        reset = true;
      }
    }
    const u = this.cloudMat.uniforms;
    const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // clouds live in datum-relative space: shift the camera vertically
    const camRel = camera.position.clone();
    camRel.y -= this.datum;
    const view = camera.matrixWorldInverse.clone();
    const shift = new THREE.Matrix4().makeTranslation(0, this.datum, 0);
    const vpRel = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, new THREE.Matrix4().multiplyMatrices(view, shift));
    u.uInvViewProj.value.copy(vpRel).invert();
    u.uPrevViewProj.value.copy(this.prevViewProj);
    u.uCamPosC.value.copy(camRel);
    u.uFrame.value = this.frame % 64;
    u.uBlend.value = reset || this._resetClouds ? 1 : 0.14;
    this._resetClouds = false;
    const src = this.cloudRT[this.cloudIndex];
    const dst = this.cloudRT[1 - this.cloudIndex];
    u.uHistory.value = src.texture;
    this.cloudPass.render(this.renderer, dst);
    this.cloudIndex = 1 - this.cloudIndex;
    this.prevViewProj.copy(vpRel);
    this.skyMat.uniforms.uCloudTex.value = dst.texture;
    void vp;
  }

  resetTemporal() {
    this._resetClouds = true;
  }

  _renderEnv(camera) {
    this.envCam.position.copy(camera.position);
    const prevMain = this._mainPass;
    this._mainPass = false;
    this.envCam.update(this.renderer, this.envScene);
    this._mainPass = prevMain;
    this.G.uEnvMap.value = this.envRT.texture;
    this.G.uEnvMaxMip.value = Math.log2(128) - 1.5;
    this.envDirty = false;
  }

  /** Project sky radiance (plus cloud dimming and ground bounce) onto SH for diffuse ambient. */
  _computeAmbient() {
    const W = 256,
      H = 144;
    this.renderer.readRenderTargetPixels(this.skyRT, 0, 0, W, H, this.skyPixels);
    const px = this.skyPixels;
    const sh = new Float64Array(27);
    let wsum = 0;
    const cover = this.cloudU.uCloudParams.value.x;
    // mean sky radiance for the overcast blend and the cloud ambient colours
    let top = [0, 0, 0],
      bot = [0, 0, 0],
      tn = 0,
      bn = 0;
    const sunUp = Math.max(0, this.sunDir.y);
    const sunE = [this.sunColor.x, this.sunColor.y, this.sunColor.z];
    let downIrr = [0, 0, 0];
    const samples = [];
    for (let j = 0; j < H; j += 2) {
      const s = ((j + 0.5) / H) * 2 - 1;
      const el = Math.sign(s) * s * s * (Math.PI / 2);
      if (el < 0) continue;
      // solid angle weight: cos(el) * del/dv
      const wEl = Math.cos(el) * Math.abs(s) * 2;
      for (let i = 0; i < W; i += 4) {
        const az = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
        const o = (j * W + i) * 4;
        const d = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
        const c = [px[o], px[o + 1], px[o + 2]];
        samples.push({ d, c, w: wEl });
        if (el > 0.9) {
          top[0] += c[0];
          top[1] += c[1];
          top[2] += c[2];
          tn++;
        } else if (el < 0.25) {
          bot[0] += c[0];
          bot[1] += c[1];
          bot[2] += c[2];
          bn++;
        }
        for (let k = 0; k < 3; k++) downIrr[k] += c[k] * d[1] * wEl;
        wsum += wEl;
      }
    }
    const norm = (2 * Math.PI) / wsum; // upper hemisphere solid angle
    for (let k = 0; k < 3; k++) downIrr[k] = downIrr[k] * norm;
    // clouds: brighten/grey the sky dome proportionally to cover (diffuse white light)
    const mean = [0, 0, 0];
    for (const sm of samples) for (let k = 0; k < 3; k++) mean[k] += sm.c[k] * sm.w;
    for (let k = 0; k < 3; k++) mean[k] /= wsum;
    const cloudL = [0, 0, 0];
    for (let k = 0; k < 3; k++) cloudL[k] = mean[k] * 0.6 + (sunE[k] * sunUp * 0.12) / Math.PI;
    const add = (d, c, w) => {
      const [x, y, z] = d;
      const b = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
      for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) sh[i * 3 + k] += c[k] * b[i] * w;
    };
    for (const sm of samples) {
      const c = [0, 0, 0];
      const cv = cover * 0.75;
      for (let k = 0; k < 3; k++) c[k] = sm.c[k] * (1 - cv) + cloudL[k] * cv;
      add(sm.d, c, sm.w * norm);
    }
    // ground bounce for the lower hemisphere: albedo * (sun + sky irradiance) / pi
    const ga = this.groundAlbedo;
    const bounce = [0, 0, 0];
    const sunVis = 1 - cover * 0.6;
    for (let k = 0; k < 3; k++) bounce[k] = ([ga.x, ga.y, ga.z][k] * (sunE[k] * sunUp * sunVis + downIrr[k])) / Math.PI;
    const NB = 96;
    for (let i = 0; i < NB; i++) {
      const u = (i + 0.5) / NB;
      const y = -u;
      const rr = Math.sqrt(1 - y * y);
      const ph = i * 2.399963;
      add([rr * Math.cos(ph), y, rr * Math.sin(ph)], bounce, (2 * Math.PI) / NB);
    }
    // convolve with the cosine lobe (irradiance): A0 = pi, A1 = 2pi/3, A2 = pi/4, and fold basis constants
    const A = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
    const Bc = [0.282095, 0.488603, 0.488603, 0.488603, 1.092548, 1.092548, 0.315392, 1.092548, 0.546274];
    for (let i = 0; i < 9; i++) {
      this.sh[i].set(sh[i * 3] * A[i] * Bc[i], sh[i * 3 + 1] * A[i] * Bc[i], sh[i * 3 + 2] * A[i] * Bc[i]);
      this.G.uSH.value[i].copy(this.sh[i]);
    }
    if (tn) this.cloudU.uSkyTop.value.set(top[0] / tn, top[1] / tn, top[2] / tn).multiplyScalar(Math.PI);
    if (bn) this.cloudU.uSkyBot.value.set(bot[0] / bn, bot[1] / bn, bot[2] / bn).multiplyScalar(Math.PI * 0.7);
    this.skyMat.uniforms.uGroundCol.value.set(bounce[0], bounce[1], bounce[2]);
    this.skyIrradiance = downIrr;
  }

  dispose() {
    for (const rt of [this.transRT, this.msRT, this.skyRT, this.envRT, this.cloudNoise, ...this.cloudRT]) if (rt) rt.dispose();
  }
}
