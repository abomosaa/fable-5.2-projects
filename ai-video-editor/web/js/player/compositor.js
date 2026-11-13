// Compositor: draws the resolved layers of one frame.
//
// All geometry is expressed in *project pixels* (the export canvas, W×H); the
// compositor maps that space onto whatever backing resolution the preview uses, so
// the layout is identical to the FFmpeg export at every preview size.
//
// Two implementations with the same interface:
//   * WebGL2 (default): premultiplied-alpha textured quads, colour controls in the
//     fragment shader — the exact colour math of crates/core/src/render.rs.
//   * Canvas 2D fallback: same layout; colour controls approximated with ctx.filter.
//
// Interface
//   kind                    'webgl' | '2d'
//   resize(bw, bh)          backing-store size in device pixels
//   begin(W, H, background) start a frame for a project canvas of W×H
//   draw(source, quad)      source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
//                           quad: { cx, cy, w, h, rotation, flipH, flipV, opacity,
//                                   crop:{left,top,right,bottom}, color:{brightness,contrast,saturation,temperature},
//                                   dynamic, version }
//                           `dynamic` sources (video) are re-uploaded when `version` changes;
//                           static ones (images, text) are uploaded once per `version`.
//   end()                   finish the frame (also garbage-collects stale textures)
//   release(source)         drop the texture of a source that will not be drawn again
//   readPixels(x,y,w,h)     RGBA bytes, origin top-left, backing-store pixels (call right after end())
//   destroy()

const VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_m;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  vec3 p = u_m * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = u_uv.xy + (a_pos + 0.5) * u_uv.zw;
}`;

// Colour math mirrors render.rs: gamma-encoded RGB, clamp after every step.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_adjust;
uniform vec4 u_color; // temperature, brightness, contrast, saturation
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_adjust > 0.5) {
    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    rgb.r = clamp(rgb.r * (1.0 + 0.25 * u_color.x), 0.0, 1.0);
    rgb.b = clamp(rgb.b * (1.0 - 0.25 * u_color.x), 0.0, 1.0);
    rgb = clamp(rgb * u_color.y, 0.0, 1.0);
    rgb = clamp((rgb - 0.5) * u_color.z + 0.5, 0.0, 1.0);
    float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = clamp(vec3(l) + (rgb - vec3(l)) * u_color.w, 0.0, 1.0);
    c.rgb = rgb * c.a;
  }
  o = c * u_opacity;
}`;

const TEX_MAX_IDLE_FRAMES = 900;

export function parseColor(hex, fallback = [0, 0, 0, 1]) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return fallback;
  const n = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) : 1];
}

const isNeutral = (c) => !c || (c.brightness === 1 && c.contrast === 1 && c.saturation === 1 && c.temperature === 0);

function sourceSize(src) {
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  return [src.width, src.height];
}

function createGl(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  let prog;
  let loc;
  let vao;
  let lost = false;
  let frame = 0;
  let W = 1;
  let H = 1;
  /** @type {Map<any, {tex: WebGLTexture, version: any, used: number, w: number, h: number}>} */
  const textures = new Map();
  const listeners = new Set();

  function init() {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'program link failed');
    loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'),
      m: gl.getUniformLocation(prog, 'u_m'),
      uv: gl.getUniformLocation(prog, 'u_uv'),
      tex: gl.getUniformLocation(prog, 'u_tex'),
      opacity: gl.getUniformLocation(prog, 'u_opacity'),
      adjust: gl.getUniformLocation(prog, 'u_adjust'),
      color: gl.getUniformLocation(prog, 'u_color'),
    };
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    gl.uniform1i(loc.tex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.DEPTH_TEST);
  }
  try {
    init();
  } catch (e) {
    console.warn('[cutline] WebGL initialisation failed, using 2D canvas:', e);
    return null;
  }

  const onLost = (e) => {
    e.preventDefault();
    lost = true;
    textures.clear();
  };
  const onRestored = () => {
    try {
      init();
      lost = false;
      for (const fn of listeners) fn();
    } catch (e) {
      console.error('[cutline] could not restore the WebGL context:', e);
    }
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  function upload(src, q) {
    const [sw, sh] = sourceSize(src);
    if (!sw || !sh) return textures.get(src) || null; // nothing decoded yet: keep the last frame
    let entry = textures.get(src);
    const fresh = !entry;
    if (!entry) {
      entry = { tex: gl.createTexture(), version: undefined, used: frame, w: 0, h: 0 };
      textures.set(src, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    if (fresh || entry.version !== q.version || entry.w !== sw || entry.h !== sh) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } catch (e) {
        // e.g. a video that is not decodable yet
        if (fresh) {
          gl.deleteTexture(entry.tex);
          textures.delete(src);
          return null;
        }
        return entry;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (q.dynamic) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      } else {
        // static pictures are often shown much smaller than they are: mipmaps avoid shimmer
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      }
      entry.version = q.version;
      entry.w = sw;
      entry.h = sh;
    }
    entry.used = frame;
    return entry;
  }

  return {
    kind: 'webgl',
    get lost() {
      return lost;
    },
    onRestore(fn) {
      listeners.add(fn);
    },
    resize(bw, bh) {
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
    },
    begin(w, h, background) {
      if (lost) return;
      W = w;
      H = h;
      frame++;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const [r, g, b] = parseColor(background);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
    },
    draw(src, q) {
      if (lost || !(q.opacity > 0)) return false;
      const entry = upload(src, q);
      if (!entry) return false;
      const rad = ((q.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const w = q.w * (q.flipH ? -1 : 1);
      const h = q.h * (q.flipV ? -1 : 1);
      // project px → clip space (y down → y up), column-major mat3
      gl.uniformMatrix3fv(loc.m, false, [(2 / W) * w * cos, (-2 / H) * w * sin, 0, (2 / W) * -h * sin, (-2 / H) * h * cos, 0, (2 * q.cx) / W - 1, 1 - (2 * q.cy) / H, 1]);
      const c = q.crop || { left: 0, top: 0, right: 0, bottom: 0 };
      gl.uniform4f(loc.uv, c.left, c.top, Math.max(0, 1 - c.left - c.right), Math.max(0, 1 - c.top - c.bottom));
      gl.uniform1f(loc.opacity, Math.min(1, q.opacity));
      if (isNeutral(q.color)) gl.uniform1f(loc.adjust, 0);
      else {
        gl.uniform1f(loc.adjust, 1);
        gl.uniform4f(loc.color, q.color.temperature, q.color.brightness, q.color.contrast, q.color.saturation);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    end() {
      if (lost) return;
      if (frame % 120 === 0) {
        for (const [src, e] of textures) {
          if (frame - e.used > TEX_MAX_IDLE_FRAMES) {
            gl.deleteTexture(e.tex);
            textures.delete(src);
          }
        }
      }
    },
    release(src) {
      const e = textures.get(src);
      if (e) {
        if (!lost) gl.deleteTexture(e.tex);
        textures.delete(src);
      }
    },
    readPixels(x, y, w, h) {
      const out = new Uint8Array(w * h * 4);
      if (lost) return out;
      // GL rows are bottom-up
      gl.readPixels(x, canvas.height - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
      const row = w * 4;
      const tmp = new Uint8Array(row);
      for (let i = 0; i < h >> 1; i++) {
        const a = i * row;
        const b = (h - 1 - i) * row;
        tmp.set(out.subarray(a, a + row));
        out.copyWithin(a, b, b + row);
        out.set(tmp, b);
      }
      return out;
    },
    textureCount: () => textures.size,
    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (!lost) for (const e of textures.values()) gl.deleteTexture(e.tex);
      textures.clear();
    },
  };
}

function create2d(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  let k = 1;
  const hasFilter = 'filter' in ctx;
  return {
    kind: '2d',
    lost: false,
    onRestore() {},
    resize(bw, bh) {
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
    },
    begin(w, _h, background) {
      k = canvas.width / w;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (hasFilter) ctx.filter = 'none';
      ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(background || '') ? background : '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
    },
    draw(src, q) {
      if (!(q.opacity > 0)) return false;
      const [sw, sh] = sourceSize(src);
      if (!sw || !sh) return false;
      const c = q.crop || { left: 0, top: 0, right: 0, bottom: 0 };
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.translate(q.cx, q.cy);
      ctx.rotate(((q.rotation || 0) * Math.PI) / 180);
      ctx.scale(q.flipH ? -1 : 1, q.flipV ? -1 : 1);
      ctx.globalAlpha = Math.min(1, q.opacity);
      if (hasFilter && !isNeutral(q.color)) {
        // approximation of the shader maths (no per-channel temperature in 2D)
        ctx.filter = `brightness(${q.color.brightness}) contrast(${q.color.contrast}) saturate(${q.color.saturation})`;
      }
      try {
        ctx.drawImage(src, c.left * sw, c.top * sh, Math.max(1, (1 - c.left - c.right) * sw), Math.max(1, (1 - c.top - c.bottom) * sh), -q.w / 2, -q.h / 2, q.w, q.h);
      } catch {
        ctx.restore();
        return false;
      }
      ctx.restore();
      return true;
    },
    end() {},
    release() {},
    readPixels(x, y, w, h) {
      return new Uint8Array(ctx.getImageData(x, y, w, h).data.buffer);
    },
    textureCount: () => 0,
    destroy() {},
  };
}

/**
 * Create a compositor for a canvas. `prefer2d` forces the fallback (tests / debugging).
 */
export function createCompositor(canvas, { prefer2d = false } = {}) {
  if (!prefer2d) {
    const gl = createGl(canvas);
    if (gl) return gl;
  }
  const c2d = create2d(canvas);
  if (!c2d) throw new Error('This browser cannot draw the preview (no WebGL2 or 2D canvas).');
  return c2d;
}
