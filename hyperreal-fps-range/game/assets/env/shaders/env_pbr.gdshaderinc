// Shared body of the architecture PBR shader (see env_pbr.gdshader / env_pbr_2s.gdshader).
// Vertex colour: R ground grime, G per-piece random, B weather exposure. UV2 -> unique wear atlas.
uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D orm_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D macro_tex : hint_default_white, filter_linear_mipmap, repeat_enable;
uniform sampler2D wear_tex : source_color, hint_default_transparent, filter_linear_mipmap_anisotropic, repeat_disable;
uniform vec4 tint : source_color = vec4(1.0);
uniform float brightness = 1.0;
uniform float saturation = 1.0;
uniform float normal_strength = 1.0;
uniform float roughness_mul = 1.0;
uniform float roughness_add = 0.0;
uniform float metallic_mul = 1.0;
uniform float ao_strength = 1.0;
uniform float piece_variation = 0.10;
uniform float macro_variation = 0.12;
uniform vec3 dirt_color : source_color = vec3(0.17, 0.13, 0.095);
uniform float dirt_strength = 0.55;
uniform float bleach_strength = 0.3;
uniform float use_wear = 0.0;
uniform float specular_level = 0.5;
varying vec3 wpos;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec4 a = texture(albedo_tex, UV);
	vec3 orm = texture(orm_tex, UV).rgb;
	vec2 mp = wpos.xz + wpos.yy * vec2(0.61, 0.37);
	vec3 m = texture(macro_tex, mp * 0.13).rgb;
	vec3 m2 = texture(macro_tex, mp * 0.83 + vec2(0.31, 0.57)).rgb;
	vec3 col = a.rgb * tint.rgb * brightness;
	col *= 1.0 + (COLOR.g - 0.5) * 2.0 * piece_variation;
	col *= 1.0 + (m.r - 0.5) * 2.0 * macro_variation;
	float lum = dot(col, vec3(0.3, 0.59, 0.11));
	col = mix(vec3(lum), col, saturation);
	float bleach = clamp(COLOR.b * bleach_strength * (0.5 + m.g), 0.0, 1.0);
	col = mix(col, vec3(lum) * 1.18 + 0.015, bleach);
	float dirt = clamp(COLOR.r * dirt_strength * (0.35 + 1.3 * m2.b), 0.0, 1.0);
	col = mix(col, dirt_color * (0.7 + 0.6 * m2.g), dirt);
	float rough = clamp(orm.g * roughness_mul + roughness_add + dirt * 0.15 + bleach * 0.1, 0.04, 1.0);
	vec4 w = texture(wear_tex, UV2);
	float wa = w.a * use_wear;
	col = mix(col, w.rgb, wa);
	rough = mix(rough, 0.92, wa * 0.6);
	ALBEDO = col;
	ROUGHNESS = rough;
	METALLIC = orm.b * metallic_mul * (1.0 - dirt) * (1.0 - wa);
	AO = mix(1.0, orm.r, ao_strength);
	AO_LIGHT_AFFECT = 0.2;
	SPECULAR = specular_level;
	NORMAL_MAP = texture(normal_tex, UV).rgb;
	NORMAL_MAP_DEPTH = normal_strength;
}
