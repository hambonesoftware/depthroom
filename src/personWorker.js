const WASM='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL='https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';
const progress=message=>self.postMessage({type:'progress',message});
self.onmessage=async({data})=>{
 if(data?.type!=='segment')return;
 let segmenter,bitmap;
 try{
   progress('Loading local people-segmentation model…');
   const {ImageSegmenter,FilesetResolver}=await import('@mediapipe/tasks-vision');
   const vision=await FilesetResolver.forVisionTasks(WASM);
   segmenter=await ImageSegmenter.createFromOptions(vision,{
     baseOptions:{modelAssetPath:MODEL,delegate:'CPU'},
     runningMode:'IMAGE',outputCategoryMask:true,outputConfidenceMasks:true,
   });
   const blob=await(await fetch(data.image)).blob();
   bitmap=await createImageBitmap(blob);
   progress('Identifying whole people…');
   const result=segmenter.segment(bitmap);
   const labels=segmenter.getLabels?.()||[];
   const classIndex=labels.findIndex(x=>/^(person|people)$/i.test(x));
   const personIndex=classIndex<0?15:classIndex;
   const category=result.categoryMask;
   const confidence=result.confidenceMasks?.[personIndex];
   const width=category?.width||confidence?.width,height=category?.height||confidence?.height;
   if(!width||!height)throw Error('No valid subject mask was returned');
   const classes=category?.getAsUint8Array();
   const probabilities=confidence?.getAsFloat32Array();
   const output=new Uint8Array(width*height);let count=0;
   for(let i=0;i<output.length;i++){
     const value=probabilities?probabilities[i]:(classes?.[i]===personIndex?1:0);
     const c=Math.round(255*Math.max(0,Math.min(1,Number.isFinite(value)?value:0)));
     output[i]=c;if(c>127)count++;
   }
   result.close();
   if(count<width*height*.004)throw Error('No people were detected confidently');
   self.postMessage({type:'result',width,height,buffer:output.buffer},[output.buffer]);
 }catch(error){
   self.postMessage({type:'error',message:error?.message||String(error)});
 }finally{try{bitmap?.close()}catch{};try{segmenter?.close()}catch{}}
};
