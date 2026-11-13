shader_type spatial;
// Range terrain: four photo-scanned PBR layers (compacted dirt base, churned soil, patchy grass, gravel)
// blended by a control map (R grass, G gravel, B soil, A damp) with per-layer height blending, a second
// larger-scale albedo sample to hide tiling at distance and a macro tint. UVs are world-space (xz).
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;
uniform sampler2D control_tex : hint_default_black, filter_linear_mipmap, repeat_disable;
uniform vec4 control_window = vec4(-42.0, -94.0, 88.0, 134.0); // x0, z0, width, depth
uniform sampler2D macro_tex : hint_default_white, filter_linear_mipmap, repeat_enable;
uniform sampler2D dirt_a : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D dirt_n : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D dirt_o : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D soil_a : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D soil_n : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D soil_o : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D grass_a : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D grass_n : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D grass_o : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D gravel_a : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D gravel_n : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D gravel_o : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform float tile_dirt = 2.2;
uniform float tile_soil = 1.5;
uniform float tile_grass = 2.4;
uniform float tile_gravel = 1.6;
uniform vec3 tint_dirt : source_color = vec3(1.0);
uniform vec3 tint_soil : source_color = vec3(1.0);
uniform vec3 tint_grass : source_color = vec3(1.0);
uniform vec3 tint_gravel : source_color = vec3(1.0);
uniform float normal_strength = 1.0;
varying vec3 wpos;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	// world-space UV = xz -> tangent +X, binormal -Z (OpenGL normal maps)
	TANGENT = normalize(vec3(1.0, 0.0, 0.0) - NORMAL * NORMAL.x);
	BINORMAL = normalize(cross(NORMAL, TANGENT));
}

void fragment() {
	vec2 p = wpos.xz;
	vec4 c = texture(control_tex, (p - control_window.xy) / control_window.zw);
	vec3 mac = texture(macro_tex, p * 0.017).rgb;
	vec3 mac2 = texture(macro_tex, p * 0.11 + vec2(0.37, 0.11)).rgb;
	vec3 mac3 = texture(macro_tex, p * 0.71 + vec2(0.13, 0.67)).rgb;
	float dist = length(VERTEX);
	float farw = smoothstep(14.0, 55.0, dist) * 0.65;

	vec2 uv_d = p / tile_dirt;
	vec2 uv_s = p / tile_soil;
	vec2 uv_g = p / tile_grass;
	vec2 uv_v = p / tile_gravel;
	vec3 o_d = texture(dirt_o, uv_d).rgb;
	vec3 o_s = texture(soil_o, uv_s).rgb;
	vec3 o_g = texture(grass_o, uv_g).rgb;
	vec3 o_v = texture(gravel_o, uv_v).rgb;
	vec3 a_d = mix(texture(dirt_a, uv_d).rgb, texture(dirt_a, uv_d * 0.19 + 0.3).rgb, farw) * tint_dirt;
	vec3 a_s = mix(texture(soil_a, uv_s).rgb, texture(soil_a, uv_s * 0.23 + 0.6).rgb, farw) * tint_soil;
	vec3 a_g = mix(texture(grass_a, uv_g).rgb, texture(grass_a, uv_g * 0.17 + 0.1).rgb, farw) * tint_grass;
	vec3 a_v = texture(gravel_a, uv_v).rgb * tint_gravel;
	vec3 n_d = texture(dirt_n, uv_d).rgb;
	vec3 n_s = texture(soil_n, uv_s).rgb;
	vec3 n_g = texture(grass_n, uv_g).rgb;
	vec3 n_v = texture(gravel_n, uv_v).rgb;

	// edge break-up at four scales (9 m, 1.4 m, 35 cm, texture height) so no patch has a smooth outline
	vec3 mac4 = texture(macro_tex, p * 2.9 + vec2(0.71, 0.23)).rgb;
	float brk = (mac2.r - 0.5) * 0.55 + (mac3.g - 0.5) * 0.50 + (mac4.b - 0.5) * 0.35;
	float w_s = smoothstep(0.40, 0.60, c.b + (o_s.b - o_d.b) * 0.35 + brk * 0.8);
	float w_g = smoothstep(0.43, 0.57, c.r + (o_g.b - 0.5) * 0.55 + brk * 1.25 - (o_d.b - 0.5) * 0.25);
	float w_v = smoothstep(0.42, 0.58, c.g + (o_v.b - 0.5) * 0.45 + brk * 0.7);
	// sparse tufts inside the bare dirt and thin bald spots inside the turf
	w_g = max(w_g, smoothstep(0.80, 0.92, mac4.r * 0.6 + mac3.b * 0.5) * smoothstep(0.15, 0.4, c.r) * 0.85);
	w_g *= 1.0 - smoothstep(0.82, 0.95, mac4.g * 0.55 + mac3.r * 0.55) * 0.8 * (1.0 - smoothstep(0.75, 0.95, c.r));

	vec3 col = mix(a_d, a_s, w_s);
	vec3 orm = mix(o_d, o_s, w_s);
	vec3 nm = mix(n_d, n_s, w_s);
	// grass: lush / dry drift
	a_g = mix(a_g, a_g * vec3(1.32, 1.12, 0.72), smoothstep(0.35, 0.75, mac.b * 0.6 + mac2.g * 0.5));
	a_g *= 0.8 + 0.4 * mac3.r;
	col = mix(col, a_g, w_g); orm = mix(orm, o_g, w_g); nm = mix(nm, n_g, w_g);
	// darker ring of soil where the turf ends (roots / shadowed crumbs)
	col *= 1.0 - 0.22 * (1.0 - abs(w_g * 2.0 - 1.0)) * (1.0 - w_v);
	col = mix(col, a_v, w_v); orm = mix(orm, o_v, w_v); nm = mix(nm, n_v, w_v);

	// macro colour drift (dry / lush patches) and damp darkening
	col *= 0.80 + 0.40 * mac.r;
	col *= 0.90 + 0.20 * mac2.b;
	col = mix(col, col * vec3(1.06, 0.98, 0.84), (mac.g - 0.5) * 0.8 * w_g);
	float damp = c.a * (0.7 + 0.6 * mac3.b);
	col *= 1.0 - 0.48 * damp;
	ALBEDO = col;
	ROUGHNESS = clamp(0.62 + orm.g * 0.38 - 0.15 * damp, 0.5, 1.0);
	METALLIC = 0.0;
	SPECULAR = 0.22;
	AO = orm.r;
	AO_LIGHT_AFFECT = 0.25;
	NORMAL_MAP = nm;
	NORMAL_MAP_DEPTH = normal_strength * (1.0 - 0.6 * smoothstep(25.0, 80.0, dist));
}
