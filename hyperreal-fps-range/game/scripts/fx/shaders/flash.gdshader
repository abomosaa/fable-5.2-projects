shader_type spatial;
// One-frame muzzle gas flash: small unshaded additive sprite, kept below bloom levels in daylight.
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, shadows_disabled;

uniform sampler2D atlas : source_color, filter_linear, repeat_disable;
uniform vec2 cell = vec2(0.0);
uniform float intensity = 1.0;
uniform float roll = 0.0;
uniform vec2 flip = vec2(1.0);

void vertex() {
	mat4 mat_world = mat4(normalize(INV_VIEW_MATRIX[0]), normalize(INV_VIEW_MATRIX[1]), normalize(INV_VIEW_MATRIX[2]), MODEL_MATRIX[3]);
	mat_world = mat_world * mat4(vec4(cos(roll), -sin(roll), 0.0, 0.0), vec4(sin(roll), cos(roll), 0.0, 0.0), vec4(0.0, 0.0, 1.0, 0.0), vec4(0.0, 0.0, 0.0, 1.0));
	MODELVIEW_MATRIX = VIEW_MATRIX * mat_world;
	MODELVIEW_MATRIX = MODELVIEW_MATRIX * mat4(vec4(length(MODEL_MATRIX[0].xyz), 0.0, 0.0, 0.0), vec4(0.0, length(MODEL_MATRIX[1].xyz), 0.0, 0.0), vec4(0.0, 0.0, length(MODEL_MATRIX[2].xyz), 0.0), vec4(0.0, 0.0, 0.0, 1.0));
	MODELVIEW_NORMAL_MATRIX = mat3(MODELVIEW_MATRIX);
}

void fragment() {
	vec2 uv = (UV - 0.5) * flip + 0.5;
	vec4 t = texture(atlas, (cell + uv) / vec2(3.0, 2.0));
	ALBEDO = t.rgb * intensity;
	ALPHA = 1.0;
}
