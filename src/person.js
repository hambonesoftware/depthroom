let active=null;
export function cancelPeopleSegmentation(){
 if(active)active.fail(new DOMException('Cancelled','AbortError'));
}
export function segmentPeople(photoCanvas,onProgress=()=>{}){
 cancelPeopleSegmentation();
 return new Promise((resolve,reject)=>{
   let worker;
   try{worker=new Worker(new URL('./personWorker.js',import.meta.url),{type:'module'})}
   catch(error){reject(error);return}
   let ended=false;
   const cleanup=()=>{clearTimeout(timer);worker.terminate()};
   const fail=error=>{if(ended)return;ended=true;if(active?.worker===worker)active=null;cleanup();reject(error)};
   const timer=setTimeout(()=>fail(Error('Person detection timed out')),85000);
   active={worker,fail};
   worker.onerror=e=>fail(Error(e.message||'Person worker crashed'));
   worker.onmessageerror=()=>fail(Error('Person worker returned invalid data'));
   worker.onmessage=({data})=>{
     if(ended)return;
     if(data?.type==='progress')onProgress(data.message);
     if(data?.type==='error')fail(Error(data.message||'Person detection failed'));
     if(data?.type==='result'){
       try{
         const {width,height}=data;
         if(!width||!height||width*height>2000000)throw Error('Invalid person mask dimensions');
         const values=new Uint8Array(data.buffer);
         if(values.length!==width*height)throw Error('Invalid person mask length');
         const surface=document.createElement('canvas');surface.width=width;surface.height=height;
         const ctx=surface.getContext('2d');
         const image=ctx.createImageData(width,height);
         for(let i=0;i<values.length;i++){
           const j=i*4;image.data[j]=image.data[j+1]=image.data[j+2]=values[i];image.data[j+3]=255;
         }
         ctx.putImageData(image,0,0);
         ended=true;active=null;cleanup();resolve(surface);
       }catch(error){fail(error)}
     }
   };
   try{
     const s=Math.min(1,720/Math.max(photoCanvas.width,photoCanvas.height));
     const tmp=document.createElement('canvas');
     tmp.width=Math.round(photoCanvas.width*s);tmp.height=Math.round(photoCanvas.height*s);
     tmp.getContext('2d').drawImage(photoCanvas,0,0,tmp.width,tmp.height);
     const image=tmp.toDataURL('image/jpeg',.83);
     tmp.width=0;tmp.height=0;
     worker.postMessage({type:'segment',image});
   }catch(error){fail(error)}
 });
}
