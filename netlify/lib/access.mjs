// Public access: provider credentials stay on the server.
export const serverReady=env=>!!(env.DASHSCOPE_API_KEY&&env.DASHSCOPE_WORKSPACE_ID);
