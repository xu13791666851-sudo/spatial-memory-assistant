// Keep the visitor's URL, Origin, cookies and streaming body intact.
// The private binding reaches the current deployment without workers.dev DNS.
export default {
 fetch(request,env){
  return env.MEMORY_API.fetch(request);
 }
};
