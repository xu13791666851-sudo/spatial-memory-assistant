// The isolated gateway only accepts this preview origin. Other deployments use
// the existing same-origin HTTP observation path without failed handshakes.
export const PREVIEW_VISION_STREAM_URL='wss://spatial-memory-vision-preview.xu13791666851.workers.dev/api/vision-stream';
export function visionStreamUrlFor(origin){
  return origin==='https://deploy-preview-8--spatial-memory-xuziyi.netlify.app'?PREVIEW_VISION_STREAM_URL:'';
}
export const VISION_STREAM_URL=visionStreamUrlFor(globalThis.location?.origin);
