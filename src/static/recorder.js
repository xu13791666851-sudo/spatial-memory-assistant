class MicRecorder extends AudioWorkletProcessor {
  constructor(){super();this.phase=0;this.sum=0;this.count=0;this.samples=[];}
  process(inputs){
    const input=inputs[0]?.[0];
    if(input){for(const value of input){this.sum+=value;this.count++;this.phase+=16000/sampleRate;
      if(this.phase>=1){this.phase-=1;this.samples.push(Math.max(-1,Math.min(1,this.sum/this.count)));this.sum=0;this.count=0;}
      if(this.samples.length>=1600){const pcm=new Int16Array(this.samples.map(v=>Math.round(v*(v<0?32768:32767))));this.port.postMessage(pcm.buffer,[pcm.buffer]);this.samples=[];}
    }}return true;
  }
}
registerProcessor('mic-recorder',MicRecorder);
