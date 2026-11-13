package dev.pocket3d.viewer.gl

/**
 * All GLSL of the viewer. Plain GLSL ES 3.00, no extensions (except the external-image sampler of
 * the AR camera background), explicit precision everywhere.
 */
internal object Shaders {
    const val MODE_TEXTURED = 0
    const val MODE_SOLID = 1
    const val MODE_EVIDENCE = 2
    const val MODE_FLAT = 3

    const val CROP_OFF = 0
    const val CROP_BOX = 1
    const val CROP_PLANE = 2

    val MESH_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec3 aPos;
        layout(location = 1) in vec3 aNormal;
        layout(location = 2) in vec2 aUv;
        layout(location = 3) in float aConf;
        uniform mat4 uMvp;
        uniform mat3 uNormalMat;
        out vec3 vModelPos;
        out vec3 vNormalV;
        out vec2 vUv;
        out float vConf;
        void main() {
            vModelPos = aPos;
            vNormalV = uNormalMat * aNormal;
            vUv = aUv;
            vConf = aConf;
            gl_Position = uMvp * vec4(aPos, 1.0);
        }
    """.trimIndent()

    /*
     * Honesty rules implemented here:
     *  - MODE_TEXTURED is unlit: scan textures already contain the lighting of the scene.
     *  - Back faces are darkened so open scans read as open.
     *  - uStripe (repaired / synthetic surface) overrides the colour with diagonal stripes in
     *    every mode.
     *  - MODE_EVIDENCE uses a ramp with monotonic lightness (dark blue -> grey -> yellow, safe for
     *    colour-vision deficiencies) and adds hatching below the "weak" limit and cross-hatching
     *    below the "no evidence" limit, so the classes do not depend on colour alone.
     */
    val MESH_FS = """
        #version 300 es
        precision highp float;
        precision highp int;
        uniform sampler2D uTex;
        uniform int uMode;
        uniform int uHasTex;
        uniform int uStripe;
        uniform int uBackTint;
        uniform int uPattern;
        uniform vec4 uColor;
        uniform float uExposure;
        uniform int uCropMode;
        uniform vec3 uCropCenter;
        uniform mat3 uCropAxes;
        uniform vec3 uCropHalf;
        uniform vec4 uPlane;
        uniform float uWeakLimit;
        uniform float uNoneLimit;
        in vec3 vModelPos;
        in vec3 vNormalV;
        in vec2 vUv;
        in float vConf;
        out vec4 fragColor;

        float shade(vec3 n) {
            float hemi = 0.5 + 0.5 * n.y;
            float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
            float fill = max(dot(n, normalize(vec3(-0.60, 0.10, 0.50))), 0.0);
            float head = max(n.z, 0.0);
            return 0.26 + 0.22 * hemi + 0.36 * key + 0.12 * fill + 0.10 * head;
        }

        vec3 ramp(float c) {
            vec3 lo = vec3(0.00, 0.14, 0.33);
            vec3 mid = vec3(0.49, 0.48, 0.47);
            vec3 hi = vec3(1.00, 0.91, 0.27);
            return c < 0.5 ? mix(lo, mid, c * 2.0) : mix(mid, hi, c * 2.0 - 1.0);
        }

        void main() {
            vec3 n = normalize(vNormalV);
            bool back = !gl_FrontFacing;
            if (back) n = -n;
            float alpha = uColor.a;
            vec3 col;
            if (uMode == 0) {
                col = uColor.rgb;
                if (uHasTex == 1) col *= texture(uTex, vUv).rgb;
                col *= uExposure;
            } else if (uMode == 1) {
                col = vec3(0.74) * shade(n);
            } else if (uMode == 2) {
                float c = clamp(vConf, 0.0, 1.0);
                col = ramp(c) * (0.72 + 0.28 * shade(n));
                if (c < uWeakLimit) {
                    float d1 = mod(gl_FragCoord.x - gl_FragCoord.y, 12.0);
                    if (d1 < 2.5) col = mix(col, vec3(1.0), 0.8);
                    if (c < uNoneLimit) {
                        float d2 = mod(gl_FragCoord.x + gl_FragCoord.y, 12.0);
                        if (d2 < 2.5) col = mix(col, vec3(1.0), 0.8);
                    }
                }
            } else {
                col = uColor.rgb;
                if (uPattern == 1) {
                    float chk = mod(floor(gl_FragCoord.x / 4.0) + floor(gl_FragCoord.y / 4.0), 2.0);
                    if (chk < 1.0) alpha *= 0.35;
                }
            }
            if (uStripe == 1) {
                float s = mod(gl_FragCoord.x + gl_FragCoord.y, 22.0);
                vec3 stripe = s < 11.0 ? vec3(0.95, 0.30, 0.62) : vec3(0.12, 0.10, 0.16);
                col = stripe * (uMode == 0 ? 1.0 : 0.7 + 0.3 * shade(n));
            }
            if (back && uBackTint == 1) col = mix(col * 0.42, vec3(0.10, 0.12, 0.20), 0.25);
            if (uCropMode != 0) {
                bool outside;
                if (uCropMode == 1) {
                    vec3 l = (vModelPos - uCropCenter) * uCropAxes;
                    outside = any(greaterThan(abs(l), uCropHalf));
                } else {
                    outside = dot(uPlane.xyz, vModelPos) + uPlane.w < 0.0;
                }
                if (outside) {
                    if (mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;
                    float g = dot(col, vec3(0.299, 0.587, 0.114));
                    col = mix(vec3(g), vec3(0.38), 0.55);
                }
            }
            fragColor = vec4(col, alpha);
        }
    """.trimIndent()

    /** Thin lines (GL_LINES): wireframe edges and the ground grid. */
    val LINE_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec3 aPos;
        uniform mat4 uMvp;
        void main() {
            gl_Position = uMvp * vec4(aPos, 1.0);
        }
    """.trimIndent()

    val COLOR_FS = """
        #version 300 es
        precision mediump float;
        uniform vec4 uColor;
        out vec4 fragColor;
        void main() {
            fragColor = uColor;
        }
    """.trimIndent()

    /** Constant-pixel-width lines built from two triangles per segment. */
    val WIDE_LINE_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec3 aA;
        layout(location = 1) in vec3 aB;
        layout(location = 2) in vec2 aParam;
        layout(location = 3) in vec4 aColor;
        uniform mat4 uMvp;
        uniform vec2 uViewport;
        uniform float uWidth;
        uniform float uDepthBias;
        out vec4 vColor;
        void main() {
            vec4 ca = uMvp * vec4(aA, 1.0);
            vec4 cb = uMvp * vec4(aB, 1.0);
            float eps = 1e-4;
            if (ca.w < eps && cb.w < eps) {
                gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                vColor = aColor;
                return;
            }
            if (ca.w < eps) ca = mix(ca, cb, (eps - ca.w) / (cb.w - ca.w));
            if (cb.w < eps) cb = mix(cb, ca, (eps - cb.w) / (ca.w - cb.w));
            vec2 half_vp = uViewport * 0.5;
            vec2 sa = ca.xy / ca.w * half_vp;
            vec2 sb = cb.xy / cb.w * half_vp;
            vec2 d = sb - sa;
            float len = length(d);
            vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
            vec2 nrm = vec2(-dir.y, dir.x);
            vec4 c = aParam.y < 0.5 ? ca : cb;
            vec2 off = nrm * aParam.x * uWidth * 0.5 + dir * (aParam.y - 0.5) * uWidth * 0.5;
            c.xy += off / half_vp * c.w;
            c.z -= uDepthBias * c.w;
            gl_Position = c;
            vColor = aColor;
        }
    """.trimIndent()

    val VERTEX_COLOR_FS = """
        #version 300 es
        precision mediump float;
        in vec4 vColor;
        out vec4 fragColor;
        void main() {
            fragColor = vColor;
        }
    """.trimIndent()

    /** Round, coloured points (sparse preview). */
    val POINT_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec3 aPos;
        layout(location = 1) in vec3 aColor;
        uniform mat4 uMvp;
        uniform float uPointSize;
        out vec4 vColor;
        void main() {
            gl_Position = uMvp * vec4(aPos, 1.0);
            gl_PointSize = uPointSize;
            vColor = vec4(aColor, 1.0);
        }
    """.trimIndent()

    val POINT_FS = """
        #version 300 es
        precision mediump float;
        in vec4 vColor;
        out vec4 fragColor;
        void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            if (dot(p, p) > 1.0) discard;
            fragColor = vColor;
        }
    """.trimIndent()

    /** Full-viewport vertical gradient. */
    val BACKGROUND_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec2 aPos;
        out float vT;
        void main() {
            vT = aPos.y * 0.5 + 0.5;
            gl_Position = vec4(aPos, 0.0, 1.0);
        }
    """.trimIndent()

    val BACKGROUND_FS = """
        #version 300 es
        precision mediump float;
        uniform vec3 uTop;
        uniform vec3 uBottom;
        in float vT;
        out vec4 fragColor;
        void main() {
            fragColor = vec4(mix(uBottom, uTop, vT), 1.0);
        }
    """.trimIndent()

    // ---- AR ------------------------------------------------------------------------------------

    val CAMERA_BG_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec2 aPos;
        layout(location = 1) in vec2 aUv;
        out vec2 vUv;
        void main() {
            vUv = aUv;
            gl_Position = vec4(aPos, 0.0, 1.0);
        }
    """.trimIndent()

    val CAMERA_BG_FS = """
        #version 300 es
        #extension GL_OES_EGL_image_external_essl3 : require
        precision mediump float;
        uniform samplerExternalOES uCamera;
        in vec2 vUv;
        out vec4 fragColor;
        void main() {
            fragColor = vec4(texture(uCamera, vUv).rgb, 1.0);
        }
    """.trimIndent()

    /** Detected plane: a subtle grid in the plane's own coordinates, fading towards the polygon edge. */
    val PLANE_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec3 aXzAlpha;
        uniform mat4 uMvp;
        out vec2 vXz;
        out float vAlpha;
        void main() {
            vXz = aXzAlpha.xy;
            vAlpha = aXzAlpha.z;
            gl_Position = uMvp * vec4(aXzAlpha.x, 0.0, aXzAlpha.y, 1.0);
        }
    """.trimIndent()

    val PLANE_FS = """
        #version 300 es
        precision highp float;
        uniform vec4 uColor;
        uniform float uCell;
        in vec2 vXz;
        in float vAlpha;
        out vec4 fragColor;
        void main() {
            vec2 g = abs(fract(vXz / uCell - 0.5) - 0.5) * uCell;
            float lineDist = min(g.x, g.y);
            float line = 1.0 - smoothstep(0.002, 0.006, lineDist);
            float a = (0.10 + 0.55 * line) * vAlpha * uColor.a;
            fragColor = vec4(uColor.rgb, a);
        }
    """.trimIndent()

    /** Soft round contact shadow under the placed model (a unit quad in the XZ plane). */
    val SHADOW_VS = """
        #version 300 es
        precision highp float;
        layout(location = 0) in vec2 aPos;
        uniform mat4 uMvp;
        out vec2 vP;
        void main() {
            vP = aPos;
            gl_Position = uMvp * vec4(aPos.x, 0.0, aPos.y, 1.0);
        }
    """.trimIndent()

    val SHADOW_FS = """
        #version 300 es
        precision mediump float;
        uniform float uStrength;
        in vec2 vP;
        out vec4 fragColor;
        void main() {
            float r = length(vP);
            float a = (1.0 - smoothstep(0.35, 1.0, r)) * uStrength;
            fragColor = vec4(0.0, 0.0, 0.0, a);
        }
    """.trimIndent()
}
