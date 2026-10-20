const browserPolicy="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'";
const detectorPolicy="default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self'";
export default {
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  // Credentials and model sessions stay in the already configured backend.
  const response=path.startsWith('/api/')?await env.CORE_API.fetch(request):await env.ASSETS.fetch(request);
  const headers=new Headers(response.headers);
  headers.set('Content-Security-Policy',path==='/static/yolo-worker.js'?detectorPolicy:browserPolicy);
  headers.set('Cross-Origin-Opener-Policy','same-origin');headers.set('Cross-Origin-Embedder-Policy','require-corp');headers.set('Cross-Origin-Resource-Policy','same-origin');
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');headers.set('X-Frame-Options','DENY');headers.set('Permissions-Policy','camera=(self), microphone=(self), geolocation=()');
  const cacheable=/^\/static\/yolo\/model-\d+-[a-f0-9]{16}\.bin$/.test(path)||path.startsWith('/static/vendor/');
  headers.set('Cache-Control',cacheable?'public, max-age=31536000, immutable':'no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }
};
