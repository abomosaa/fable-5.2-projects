shader_type spatial;
// two-sided variant: thin sheet steel (roof / siding) and open pails
render_mode blend_mix, depth_draw_opaque, cull_disabled, diffuse_burley, specular_schlick_ggx;
#include "env_pbr.gdshaderinc"
