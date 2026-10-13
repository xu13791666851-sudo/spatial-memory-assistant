export async function* readEvents(body){
  const reader=body.getReader(),decoder=new TextDecoder();let buffer='',data=[];
  const event=()=>{const raw=data.join('\n');data=[];return !raw||raw==='[DONE]'?null:JSON.parse(raw);};
  try{
    for(;;){
      const chunk=await reader.read();buffer+=chunk.done?decoder.decode():decoder.decode(chunk.value,{stream:true});
      let end;
      while((end=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
        if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
        else if(!line){const value=event();if(value)yield value;}
      }
      if(buffer.length>20000||data.join('\n').length>20000)throw Error('Stream event too large');
      if(chunk.done){if(buffer.startsWith('data:'))data.push(buffer.slice(5).trimStart());const value=event();if(value)yield value;break;}
    }
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}
