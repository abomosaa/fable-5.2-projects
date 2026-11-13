// Self-contained offline deep-zoom viewer embedded into exported tile packages (no external libraries).
namespace dc {
extern const char* kViewerHtml;
const char* kViewerHtml = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Detailed Capture viewer</title>
<style>
html,body{margin:0;height:100%;background:#101214;color:#e8eaed;font:14px system-ui,sans-serif;overflow:hidden}
canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
#hud{position:absolute;left:12px;bottom:12px;background:rgba(16,18,20,.78);padding:8px 12px;border-radius:10px;line-height:1.5;max-width:70vw}
#hud b{font-weight:600}
</style></head><body>
<canvas id="c"></canvas><div id="hud"></div>
<script>
const CFG=/*CONFIG*/;
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),hud=document.getElementById('hud');
let dpr=1,vw=0,vh=0,scale=1,ox=0,oy=0;const cache=new Map();
function levelW(L){return Math.max(1,Math.ceil(CFG.width/Math.pow(2,CFG.maxLevel-L)))}
function levelH(L){return Math.max(1,Math.ceil(CFG.height/Math.pow(2,CFG.maxLevel-L)))}
function fit(){scale=Math.min(vw/CFG.width,vh/CFG.height)*0.96;ox=(vw-CFG.width*scale)/2;oy=(vh-CFG.height*scale)/2}
function resize(){dpr=window.devicePixelRatio||1;vw=innerWidth;vh=innerHeight;cv.width=vw*dpr;cv.height=vh*dpr;draw()}
function tile(L,c,r){const k=L+'/'+c+'_'+r;let t=cache.get(k);if(!t){t=new Image();t.onload=()=>{t.ok=true;draw()};
 t.src='image_files/'+k+'.'+CFG.format;cache.set(k,t);if(cache.size>400){const f=cache.keys().next().value;cache.delete(f)}}return t}
function drawLevel(L,need){const f=Math.pow(2,CFG.maxLevel-L),ts=CFG.tileSize,lw=levelW(L),lh=levelH(L);
 const x0=Math.max(0,Math.floor((-ox/scale)/f/ts)),y0=Math.max(0,Math.floor((-oy/scale)/f/ts));
 const x1=Math.min(Math.ceil(lw/ts)-1,Math.floor(((vw-ox)/scale)/f/ts)),y1=Math.min(Math.ceil(lh/ts)-1,Math.floor(((vh-oy)/scale)/f/ts));
 let all=true;for(let r=y0;r<=y1;r++)for(let c=x0;c<=x1;c++){const t=need?tile(L,c,r):cache.get(L+'/'+c+'_'+r);
  if(t&&t.ok){ctx.drawImage(t,ox+c*ts*f*scale,oy+r*ts*f*scale,t.width*f*scale+0.5,t.height*f*scale+0.5)}else all=false}return all}
function draw(){ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#101214';ctx.fillRect(0,0,vw,vh);
 let L=Math.min(CFG.maxLevel,Math.max(0,Math.ceil(CFG.maxLevel+Math.log2(scale*dpr))));
 ctx.imageSmoothingEnabled=scale*dpr<3;
 for(let l=Math.max(0,L-4);l<L;l++)drawLevel(l,l==Math.max(0,L-4));drawLevel(L,true);
 hud.innerHTML='<b>'+CFG.title+'</b><br>'+CFG.width+' × '+CFG.height+' px ('+CFG.outputMP.toFixed(1)+' MP grid) · estimated genuine detail ≈ '+
  CFG.estimatedDetailMP.toFixed(1)+' MP<br>zoom '+(scale*dpr*100).toFixed(0)+'% of output pixels'}
function zoomAt(px,py,k){const ns=Math.min(32,Math.max(Math.min(vw/CFG.width,vh/CFG.height)*0.5,scale*k));ox=px-(px-ox)*ns/scale;oy=py-(py-oy)*ns/scale;scale=ns;draw()}
const pts=new Map();let lastD=0;
cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);pts.set(e.pointerId,[e.clientX,e.clientY]);lastD=0});
cv.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId))return;const p=pts.get(e.pointerId);
 if(pts.size==1){ox+=e.clientX-p[0];oy+=e.clientY-p[1];pts.set(e.pointerId,[e.clientX,e.clientY]);draw()}
 else{pts.set(e.pointerId,[e.clientX,e.clientY]);const a=[...pts.values()];const d=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);
  if(lastD)zoomAt((a[0][0]+a[1][0])/2,(a[0][1]+a[1][1])/2,d/lastD);lastD=d}});
['pointerup','pointercancel'].forEach(n=>cv.addEventListener(n,e=>{pts.delete(e.pointerId);lastD=0}));
cv.addEventListener('wheel',e=>{e.preventDefault();zoomAt(e.clientX,e.clientY,Math.exp(-e.deltaY*0.0015))},{passive:false});
cv.addEventListener('dblclick',e=>zoomAt(e.clientX,e.clientY,2));
addEventListener('resize',resize);vw=innerWidth;vh=innerHeight;fit();resize();
</script></body></html>
)HTML";
}  // namespace dc
