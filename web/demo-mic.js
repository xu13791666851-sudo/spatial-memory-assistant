class DemoMic extends AudioWorkletProcessor{
 constructor(){super();this.buffer=new Float32Array(2048);this.offset=0;}
 process(inputs,outputs){const source=inputs[0]?.[0];if(source){for(const value of source){this.buffer[this.offset++]=value;if(this.offset===this.buffer.length){this.port.postMessage(this.buffer);this.buffer=new Float32Array(2048);this.offset=0;}}}for(const channel of outputs[0]||[])channel.fill(0);return true;}
}
registerProcessor('demo-mic',DemoMic);
