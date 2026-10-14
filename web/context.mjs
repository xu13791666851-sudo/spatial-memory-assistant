const PLACE_LABEL={explore:'普通场景',home:'家'};
const cleanText=value=>String(value||'').trim().replace(/[。！？!?]+$/,'');

export function placeIntent(text){
  const value=cleanText(text).replace(/^(?:你好)?(?:小忆|小意|小易)[，,\s]*/,'').replace(/\s/g,'');
  if(/^(我到家了|我在家了?|切换到家|切到家|进入家中场景|使用家中记忆)$/.test(value))return 'home';
  if(/^(我出门了|我在外面|切换到普通场景|切到普通场景|退出家中场景)$/.test(value))return 'explore';
  return null;
}

function targetFrom(text){
  const value=cleanText(text).replace(/^(?:小忆[，,]?)?(?:请|帮我)?/,'');
  const match=value.match(/^(?:找(?:一下)?|寻找|看看)(.{1,30})$/)||value.match(/^(.{1,30}?)(?:在哪里|在哪儿|在哪|放哪了)$/);
  if(!match)return null;
  const target=match[1].replace(/^(?:那个|这个|一只|一个|一些)/,'').trim();
  if(!target||/^(它|他|她|这个|那个|眼前|周围|这里|那里|什么|东西|环境)$/.test(target))return null;
  return target.slice(0,40);
}

export class SessionContext{
  constructor(){this.place='explore';this.focus='';this.scene=null;this.recent=[];}
  setPlace(place){
    if(!Object.hasOwn(PLACE_LABEL,place))throw Error('未知使用场景。');
    if(this.place!==place){this.place=place;this.focus='';this.scene=null;this.recent=[];}
    return this.place;
  }
  note(text){
    text=cleanText(text).slice(0,160);
    if(!text)return;
    this.recent.push(text);this.recent=this.recent.slice(-4);
    const target=targetFrom(text);if(target)this.focus=target;
  }
  resolve(text){
    text=String(text||'').trim();
    if(!this.focus)return text;
    return text.replace(/^(?:它|他|她|那个|这个)(?=在哪|在哪里|在哪儿|旁边|附近|呢)/,this.focus);
  }
  observe(scene){this.scene=scene;}
  summary(){return {place:this.place,place_label:PLACE_LABEL[this.place],focus:this.focus||null,recent_user_turns:this.recent,scene_observed_at:this.scene?.observedAt||null};}
}
