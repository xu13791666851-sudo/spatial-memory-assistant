import fs from 'node:fs/promises';

export async function buildYoloAssets(){
 await fs.mkdir('dist/static/yolo',{recursive:true});
 await fs.cp('models/yolo','dist/static/yolo',{recursive:true});
 for(const name of ['yolo-core.mjs','yolo-local.mjs','yolo-config.mjs','yolo-focus.mjs','target-overlay.mjs'])await fs.copyFile('web/'+name,'dist/static/'+name);
 await fs.copyFile('web/yolo-worker.js','dist/static/yolo-worker.js');
 const tf='dist/static/vendor/tfjs-4.9.0',lite='dist/static/vendor/tflite-0.0.1-alpha.10';
 await fs.mkdir(tf,{recursive:true});await fs.mkdir(lite,{recursive:true});
 await fs.copyFile('node_modules/@tensorflow/tfjs-core/dist/tf-core.min.js',tf+'/tf-core.min.js');
 await fs.copyFile('node_modules/@tensorflow/tfjs-backend-cpu/dist/tf-backend-cpu.min.js',tf+'/tf-backend-cpu.min.js');
 await fs.copyFile('node_modules/@tensorflow/tfjs-tflite/dist/tf-tflite.min.js',lite+'/tf-tflite.min.js');
 await fs.cp('node_modules/@tensorflow/tfjs-tflite/wasm',lite,{recursive:true});
 for(const [pkg,dest] of [['tfjs-core',tf+'/README-core'],['tfjs-backend-cpu',tf+'/README-cpu'],['tfjs-tflite',lite+'/README']])await fs.copyFile(`node_modules/@tensorflow/${pkg}/README.md`,dest+'.md');
 await fs.copyFile('models/yolo/THIRD_PARTY_NOTICES.md','dist/static/vendor/THIRD_PARTY_NOTICES.md');
}
