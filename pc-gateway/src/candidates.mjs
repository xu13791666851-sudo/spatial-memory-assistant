function vector(value) {
 if(typeof value!=='string')return null;
 const b=Buffer.from(value,'base64');if(b.length!==192)return null;
 const v=Array.from({length:48},(_,i)=>b.readFloatLE(i*4));
 return v.every(Number.isFinite)&&v.some(x=>x!==0)?v:null;
}
function cosine(a,b) {
 return a.reduce((s,x,i)=>s+x*b[i],0)/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));
}
export function rankCandidates(candidates,photos=[]) {
 const refs=photos.map(p=>vector(p.embedding)).filter(Boolean);
 return candidates.map(c=>{
  const v=vector(c.embedding);
  return {...c,appearanceSimilarity:v&&refs.length?Math.max(...refs.map(r=>cosine(v,r))):null};
 }).sort((a,b)=>(b.appearanceSimilarity??-1)-(a.appearanceSimilarity??-1)||b.score-a.score);
}
