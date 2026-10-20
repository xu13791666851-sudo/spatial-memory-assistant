// Keep this experiment on its own site; existing origins retain their behavior.
export function localYoloEnabled(origin){
 try{const url=new URL(origin);return ['localhost','127.0.0.1','i-see-you-yolo-preview.pages.dev','i-see-you-yolo-preview.xu13791666851.workers.dev'].includes(url.hostname)||/^[a-z0-9-]+\.i-see-you-yolo-preview\.pages\.dev$/.test(url.hostname)||/^[a-z0-9-]+-i-see-you-yolo-preview\.xu13791666851\.workers\.dev$/.test(url.hostname);}catch{return false;}
}
