import {PREVIEW_VISION_STREAM_URL as VISION_STREAM_URL} from '../../web/vision-stream-config.mjs';

// Keep the document's connection policy tied to this preview's transport even
// when the site has inherited global static-header rules from another deploy.
export default async function previewHeaders(request,context){
  const response=await context.next();
  if(new URL(request.url).hostname!=='deploy-preview-8--spatial-memory-xuziyi.netlify.app'||!VISION_STREAM_URL||!response.headers.get('Content-Type')?.includes('text/html'))return response;
  const headers=new Headers(response.headers),origin=new URL(VISION_STREAM_URL).origin;
  const policy=headers.get('Content-Security-Policy')||"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'";
  const connection="connect-src 'self' "+origin;
  headers.set('Content-Security-Policy',/(?:^|;)\s*connect-src\b/.test(policy)?policy.replace(/connect-src[^;]*/,connection):policy+'; '+connection);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export const config={path:'/video/*'};
