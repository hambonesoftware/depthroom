const create=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};
const clamp=v=>Math.max(0,Math.min(1,v));
const smooth=(lo,hi,v)=>{let t=clamp((v-lo)/(hi-lo));return t*t*(3-2*t)};
function maskToPixels(src,w,h){
 const c=create(w,h),ctx=c.getContext('2d',{willReadFrequently:true});
 ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(src,0,0,w,h);
 const bytes=ctx.getImageData(0,0,w,h).data,alpha=new Uint8Array(w*h);
 let people=0;
 for(let i=0;i<alpha.length;i++){
   alpha[i]=Math.round(255*smooth(48,209,bytes[i*4]));
   if(alpha[i]>127)people++;
 }
 if(people<alpha.length*.004||people>alpha.length*.88)throw Error('Person mask was unreliable');
 return alpha;
}
function inpaint(photo,alpha,w,h){
 const sw=Math.min(340,w),sh=Math.max(2,Math.round(sw*h/w));
 const small=create(sw,sh),sctx=small.getContext('2d',{willReadFrequently:true});
 sctx.drawImage(photo,0,0,sw,sh);
 const pix=sctx.getImageData(0,0,sw,sh),raw=new Uint8ClampedArray(pix.data);
 const mc=create(w,h),mctx=mc.getContext('2d'),rgba=mctx.createImageData(w,h);
 for(let i=0;i<alpha.length;i++){const j=i*4;rgba.data[j]=rgba.data[j+1]=rgba.data[j+2]=alpha[i];rgba.data[j+3]=255}
 mctx.putImageData(rgba,0,0);
 const sm=create(sw,sh),smctx=sm.getContext('2d',{willReadFrequently:true});
 smctx.drawImage(mc,0,0,sw,sh);
 const m=smctx.getImageData(0,0,sw,sh).data;
 const count=sw*sh,holes=new Uint8Array(count);
 for(let i=0;i<count;i++)holes[i]=m[i*4]>70?1:0;
 for(let k=0;k<2;k++){
   const expanded=holes.slice();
   for(let y=1;y<sh-1;y++)for(let x=1;x<sw-1;x++){
     const i=y*sw+x;if(!holes[i])continue;
     expanded[i-1]=expanded[i+1]=expanded[i-sw]=expanded[i+sw]=1;
   }
   holes.set(expanded);
 }
 // True two-dimensional nearest-color propagation, not line-by-line streaking.
 const nearest=new Int32Array(count);nearest.fill(-1);
 const queue=new Int32Array(count);let tail=0;
 for(let i=0;i<count;i++)if(!holes[i]){nearest[i]=i;queue[tail++]=i}
 if(tail===0)return photo;
 for(let q=0;q<tail;q++){
   const p=queue[q],x=p%sw,y=(p/sw)|0;
   const n=[x?p-1:-1,x+1<sw?p+1:-1,y?p-sw:-1,y+1<sh?p+sw:-1];
   for(let j=0;j<4;j++)if(n[j]>=0&&nearest[n[j]]===-1){
     nearest[n[j]]=nearest[p];queue[tail++]=n[j];
   }
 }
 const filled=new Uint8ClampedArray(raw);
 for(let i=0;i<count;i++){
   if(!holes[i])continue;
   const source=nearest[i]*4,dest=i*4;
   filled[dest]=raw[source];filled[dest+1]=raw[source+1];filled[dest+2]=raw[source+2];filled[dest+3]=255;
 }
 for(let pass=0;pass<6;pass++){
   const source=new Uint8ClampedArray(filled);
   for(let y=1;y<sh-1;y++)for(let x=1;x<sw-1;x++){
     const i=y*sw+x;if(!holes[i])continue;const j=i*4;
     for(let c=0;c<3;c++)filled[j+c]=(source[j+c]+source[j+c-4]+source[j+c+4]+source[j+c-sw*4]+source[j+c+sw*4])/5;
   }
 }
 pix.data.set(filled);sctx.putImageData(pix,0,0);
 const bg=create(w,h),ctx=bg.getContext('2d');
 ctx.drawImage(small,0,0,w,h);
 // Restore original pixels anywhere that no subject was removed.
 const original=photo.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
 const overlay=create(w,h),octx=overlay.getContext('2d');
 const data=octx.createImageData(w,h);
 for(let i=0;i<alpha.length;i++){
   const j=i*4;data.data[j]=original[j];data.data[j+1]=original[j+1];data.data[j+2]=original[j+2];
   data.data[j+3]=Math.round(255*(1-smooth(20,110,alpha[i])));
 }
 octx.putImageData(data,0,0);ctx.drawImage(overlay,0,0);
 return bg;
}
export function composePhotoScene(photoCanvas,maskCanvas,{mobile=false}={}){
 const maxSide=mobile?800:1200,scale=Math.min(1,maxSide/Math.max(photoCanvas.width,photoCanvas.height));
 const width=Math.max(2,Math.round(photoCanvas.width*scale)),height=Math.max(2,Math.round(photoCanvas.height*scale));
 const photo=create(width,height);photo.getContext('2d').drawImage(photoCanvas,0,0,width,height);
 if(!maskCanvas)return {width,height,quality:'original',layers:[{name:'whole-photo',canvas:photo,z:0,parallax:0,scale:1.02}]};
 const alpha=maskToPixels(maskCanvas,width,height);
 const background=inpaint(photo,alpha,width,height);
 const foreground=create(width,height),fctx=foreground.getContext('2d');
 const image=fctx.createImageData(width,height);
 const original=photo.getContext('2d',{willReadFrequently:true}).getImageData(0,0,width,height).data;
 for(let i=0;i<alpha.length;i++){
   const j=i*4;image.data[j]=original[j];image.data[j+1]=original[j+1];image.data[j+2]=original[j+2];image.data[j+3]=alpha[i];
 }
 fctx.putImageData(image,0,0);
 return {width,height,quality:'subject',layers:[
   {name:'clean-scenery',canvas:background,z:-.15,parallax:-.16,scale:1.07},
   {name:'intact-people',canvas:foreground,z:.23,parallax:1.0,scale:1.008},
 ]};
}
