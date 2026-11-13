import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan','--enable-features=Vulkan','--enable-gpu','--ignore-gpu-blocklist'] });
const p = await b.newPage();
console.log(await p.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  return { ver: navigator.userAgent, clip: !!gl.getExtension('EXT_clip_control'), exts: gl.getSupportedExtensions().join(' '), maxArr: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), maxTexUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), maxVertTex: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), maxDraw: gl.getParameter(gl.MAX_DRAW_BUFFERS), maxUBO: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE), maxFragUni: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) };
}));
await b.close();
