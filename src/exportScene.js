/** Portable interactive export: the photo and depth map are embedded into the HTML. */
export function makeInteractiveHTML(photoDataURL, depthDataURL, settings) {
  const embedded = JSON.stringify({
    photo: photoDataURL,
    depth: depthDataURL,
    strength: settings.strength,
    motion: settings.motion,
    title: 'My Depthroom Scene',
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>My Depthroom Scene</title>
<style>
  *{box-sizing:border-box}html,body{height:100%;width:100%;margin:0;overflow:hidden}
  body{background:radial-gradient(ellipse at center,#34424a,#101923 72%);font-family:system-ui,-apple-system,sans-serif;color:#eaf2e6}
  #scene{position:absolute;inset:0;cursor:grab;touch-action:none}#scene:active{cursor:grabbing}
  #scene canvas{display:block;height:100%;width:100%;touch-action:none}
  .brand{position:absolute;top:24px;left:24px;z-index:2;font-size:15px;font-weight:750;letter-spacing:-.5px;pointer-events:none}
  .brand b{color:#d3e9ae}.hint{position:absolute;bottom:25px;width:100%;left:0;text-align:center;z-index:2;font-size:11px;letter-spacing:1.4px;color:#d4e5d4;pointer-events:none}
  .error{position:absolute;left:20px;right:20px;top:50%;transform:translateY(-50%);text-align:center;color:#eee;line-height:1.6}
</style>
</head>
<body>
<div id="scene"></div>
<div class="brand">depthroom<b>.</b></div>
<div class="hint">MOVE OR DRAG TO EXPLORE · MADE WITH DEPTHROOM</div>
<script id="scene-data" type="application/json">${embedded}</script>
<script type="module">
  import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
  const config = JSON.parse(document.getElementById('scene-data').textContent);
  const mount = document.getElementById('scene');
  const loadImage = (url) => new Promise((resolve,reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url;
  });
  try {
    const [photo, depth] = await Promise.all([loadImage(config.photo), loadImage(config.depth)]);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36,1,.1,100);
    const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
    renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    const ac = document.createElement('canvas');ac.width=depth.naturalWidth;ac.height=depth.naturalHeight;
    const cx=ac.getContext('2d',{willReadFrequently:true});cx.drawImage(depth,0,0);
    const raw=cx.getImageData(0,0,ac.width,ac.height).data;
    const ratio=photo.naturalWidth/photo.naturalHeight,w=ratio*4,h=4;
    const geo=new THREE.PlaneGeometry(w,h,Math.round(Math.min(210,155*Math.sqrt(ratio))),Math.round(Math.min(210,155/Math.sqrt(ratio))));
    const pos=geo.attributes.position,uv=geo.attributes.uv;
    function sample(u,v){
      const x=Math.min(ac.width-1,Math.max(0,Math.round(u*(ac.width-1))));
      const y=Math.min(ac.height-1,Math.max(0,Math.round((1-v)*(ac.height-1))));
      return raw[(y*ac.width+x)*4]/255;
    }
    for(let i=0;i<pos.count;i++)pos.setZ(i,config.strength*.78*(sample(uv.getX(i),uv.getY(i))-.42));
    geo.computeVertexNormals();
    const texture=new THREE.Texture(photo);texture.needsUpdate=true;texture.colorSpace=THREE.SRGBColorSpace;
    const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));scene.add(mesh);
    const border=new THREE.Mesh(new THREE.PlaneGeometry(w+.07,h+.07),new THREE.MeshBasicMaterial({color:0x9aa69c,side:THREE.DoubleSide}));border.position.z=-.075;scene.add(border);
    let baseZ=8;
    function resize(){
      const width=Math.max(1,mount.clientWidth),height=Math.max(1,mount.clientHeight);
      renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
      baseZ=Math.max(h,w/camera.aspect)/(2*Math.tan((camera.fov*Math.PI/180)/2))*1.18;
    }
    resize();window.addEventListener('resize',resize);
    const p={x:0,y:0};const eased={x:0,y:0};let last=0;let dragging=false;
    function point(e){const r=mount.getBoundingClientRect();p.x=Math.max(-1,Math.min(1,2*(e.clientX-r.left)/r.width-1));p.y=Math.max(-1,Math.min(1,1-2*(e.clientY-r.top)/r.height));last=performance.now();}
    renderer.domElement.addEventListener('pointerdown',e=>{dragging=true;renderer.domElement.setPointerCapture(e.pointerId);point(e)});
    renderer.domElement.addEventListener('pointermove',e=>{if(dragging||e.pointerType!=='touch')point(e)});
    renderer.domElement.addEventListener('pointerup',()=>dragging=false);
    renderer.domElement.addEventListener('pointercancel',()=>dragging=false);
    function frame(t){
      requestAnimationFrame(frame);
      const idle=t-last>4000;
      const x=idle?Math.sin(t*.00075)*.75:p.x;
      const y=idle?Math.cos(t*.00075)*.45:p.y;
      eased.x+=(x-eased.x)*.08;eased.y+=(y-eased.y)*.08;
      mesh.rotation.y=-eased.x*config.motion*.16;mesh.rotation.x=eased.y*config.motion*.115;
      camera.position.set(eased.x*config.motion*.36,eased.y*config.motion*.22,baseZ);camera.lookAt(0,0,0);
      renderer.render(scene,camera);
    }
    requestAnimationFrame(frame);
  } catch(err){
    console.error(err);const node=document.createElement('p');node.className='error';
    node.textContent='This interactive scene needs WebGL and an internet connection to load its 3D viewer library.';
    document.body.append(node);
  }
</script>
</body>
</html>`;
}