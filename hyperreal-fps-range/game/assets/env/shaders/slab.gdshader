shader_type spatial;
// Firing-bay slab: tiling worn concrete + ONE unique detail map over the whole slab (world-space):
// R stains, G cracks/pits, B pale dust & foot polish, A worn red firing-line paint.
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;
uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D orm_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D macro_tex : hint_default_white, filter_linear_mipmap, repeat_enable;
uniform sampler2D detail_tex : hint_default_black, filter_linear_mipmap_anisotropic, repeat_disable;
uniform sampler2D detail_normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_disable;
uniform vec4 slab_rect = vec4(-6.45, -0.9, 8.7, 5.75); // x0, z0, width, depth
uniform vec4 tint : source_color = vec4(1.0);
uniform float brightness = 1.0;
uniform vec3 stain_color : source_color = vec3(0.07, 0.06, 0.05);
uniform vec3 dust_color : source_color = vec3(0.42, 0.38, 0.32);
uniform vec3 paint_color : source_color = vec3(0.45, 0.05, 0.04);
uniform float normal_strength = 1.0;
uniform float detail_normal_strength = 1.0;
varying vec3 wpos;
varying float top_face;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	top_face = smoothstep(0.5, 0.9, NORMAL.y);
}

void fragment() {
	vec4 a = texture(albedo_tex, UV);
	vec3 orm = texture(orm_tex, UV).rgb;
	vec2 duv = (wpos.xz - slab_rect.xy) / slab_rect.zw;
	vec4 d = texture(detail_tex, duv) * top_face;
	vec3 m = texture(macro_tex, wpos.xz * 0.19).rgb;
	vec3 m2 = texture(macro_tex, wpos.xz * 1.3 + vec2(0.2, 0.7)).rgb;
	vec3 col = a.rgb * tint.rgb * brightness * (0.86 + 0.28 * m.r);
	float side_dirt = (1.0 - top_face) * clamp(1.0 + wpos.y * 9.0, 0.0, 1.0);
	col = mix(col, stain_color * 1.6, side_dirt * 0.6);
	col = mix(col, dust_color * (0.8 + 0.4 * m2.g), d.b * 0.55);
	col = mix(col, stain_color * (0.8 + 0.8 * m2.r), d.r * 0.62);
	col = mix(col, paint_color * (0.75 + 0.5 * m2.b) * (0.6 + 0.6 * a.g / max(a.g, 0.2)), d.a * 0.9);
	col *= 1.0 - 0.8 * d.g;
	float rough = orm.g;
	rough = mix(rough, 0.82, d.b * 0.5);
	rough = mix(rough, 0.38, d.r * 0.35 * m2.g);
	rough = mix(rough, 0.55, d.a * 0.7);
	ALBEDO = col;
	ROUGHNESS = clamp(rough, 0.05, 1.0);
	METALLIC = 0.0;
	AO = orm.r * (1.0 - 0.5 * d.g);
	AO_LIGHT_AFFECT = 0.2;
	vec3 n1 = texture(normal_tex, UV).rgb * 2.0 - 1.0;
	vec3 n2 = texture(detail_normal_tex, duv).rgb * 2.0 - 1.0;
	n1.xy *= normal_strength;
	n2.xy *= detail_normal_strength * top_face;
	vec3 n = normalize(vec3(n1.xy + n2.xy, n1.z));
	NORMAL_MAP = n * 0.5 + 0.5;
}
