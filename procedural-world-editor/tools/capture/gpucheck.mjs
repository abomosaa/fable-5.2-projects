import { chromium } from 'playwright';
const variants = [
  ['--use-angle=vulkan','--enable-features=Vulkan','--enable-gpu','--ignore-gpu-blocklist'],
  ['--use-gl=angle','--use-angle=gl','--enable-gpu','--ignore-gpu-blocklist'],
  ['--use-gl=egl','--enable-gpu','--ignore-gpu-blocklist'],
];
for (const args of variants) {
  for (const headless of [true]) {
    try {
      const b = await chromium.launch({ headless, args, channel: 'chromium' });
      const p = await b.newPage();
      const info = await p.evaluate(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        if (!gl) return 'no webgl2';
        const e = gl.getExtension('WEBGL_debug_renderer_info');
        return [gl.getParameter(e.UNMASKED_RENDERER_WEBGL), gl.getParameter(gl.MAX_TEXTURE_SIZE), !!gl.getExtension('EXT_color_buffer_float'), !!gl.getExtension('OES_texture_float_linear'), !!gl.getExtension('EXT_float_blend'), gl.getParameter(gl.MAX_SAMPLES)].join(' | ');
      });
      console.log(args[0], 'headless', headless, '=>', info);
      await b.close();
    } catch (e) { console.log(args[0], 'ERR', e.message.split('\n')[0]); }
  }
}
