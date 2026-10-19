// Interface requests are deliberately narrow: ordinary object descriptions must
// continue through the existing visual/memory dialogue.
export function interfaceCommand(text){
  const value=String(text||'').trim().replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'').replace(/^(?:请|帮我)/,'').replace(/[，。！？!?\s]/g,'');
  if(/^(?:打开|查看|展开)(?:对话)?记录$/.test(value))return {type:'records',tab:'chat'};
  if(/^(?:打开|查看)(?:物品记忆|物品记录)$|^(?:我)?(?:记过什么|记住了哪些物品|记过哪些物品)$/.test(value))return {type:'records',tab:'memory',read:true};
  if(/^(?:关闭|收起)记录$|^(?:回到|返回)首页$/.test(value))return {type:'close-records'};
  if(/^放大画面$/.test(value))return {type:'camera',view:'video'};
  if(/^(?:缩小|还原|恢复)画面$/.test(value))return {type:'camera',view:'home'};
  if(/^收起画面$/.test(value))return {type:'camera',view:'collapsed'};
  if(/^展开画面$/.test(value))return {type:'camera',view:'home'};
  if(/^(?:刚才(?:你)?说了什么|读一下上一条|读上一条|重听|再听一遍|再说一遍)$/.test(value))return {type:'replay'};
  if(/^(?:详细一点|详细说一下|展开回答)$/.test(value))return {type:'detail'};
  if(/^(?:停一下|暂停|暂停对话)$/.test(value))return {type:'pause'};
  if(/^(?:继续|恢复)(?:对话)?$/.test(value))return {type:'resume'};
  if(/^(?:结束对话|退出对话)$/.test(value))return {type:'end'};
  if(/^(?:确认|确认执行)$/.test(value))return {type:'confirm'};
  if(/^取消$/.test(value))return {type:'cancel-confirmation'};
  return null;
}
