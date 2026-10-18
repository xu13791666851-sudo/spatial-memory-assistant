import {rememberCommand,vagueName,nameSimilarity} from './memory.mjs';
import {details,describeRecord} from './spatial-record.mjs';

const tidy=text=>String(text||'').trim().replace(/[。！？!?，,\s]/g,'');
const yes=text=>/^(好|好的|好啊|可以|要|需要|想听|听一下|是|是的|就是|就是它|对|对的|没错|确认|确认更新|更新|帮我更新|好帮我更新|好更新吧|更新吧|记住吧|需要听一下)$/.test(tidy(text));
const no=text=>/^(不|不要|不用|不需要|不是|不是它|不对|取消|算了|先不用|不用了|别更新)$/.test(tidy(text));
const historical=r=>`你上次记录${r.name}在${describeRecord(r)}，记录时间是${new Date(r.recorded_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}。这是历史位置，不能确认现在还在那里。`;

// Own one explicit follow-up at a time. Nothing here infers identity or writes
// a visual position until the user has answered the relevant question.
export class MemoryCompanion{
  constructor(memory,clock=()=>Date.now()){this.memory=memory;this.clock=clock;this.reset();}
  reset(){this.pending=null;this.seen=new Set();}
  clearObservation(){if(['identity','update'].includes(this.pending?.kind))this.pending=null;}
  ask(kind,data,answer){this.memory.pending=null;this.pending={kind,...data,expires:this.clock()+120000};return {...this.memory.result(answer),focus:kind==='observe'?data.record?.name:undefined};}
  choose(query,action={kind:'history'},offset=0){
    const all=this.memory.search(query,10000),candidates=all.slice(offset,offset+5);
    if(!candidates.length)return this.memory.result('没有找到相近的记录。你还记得它的颜色、用途，或放在哪个区域吗？');
    const options=candidates.map((r,i)=>`${i+1}，${r.name}`).join('；');
    return this.ask('choose',{candidates,action,query,offset,total:all.length},`我找到这些历史记录：${options}。你说的是哪一件？可以说名称或第几个。${offset+5<all.length?'也可以说“下一批”。':''}`);
  }
  update(record,location,sceneAt,spatial={}){
    return this.ask('update',{record,location,sceneAt,spatial},`之前记的是${describeRecord(record)}，这次画面中是${describeRecord({location,...spatial})}。要把${record.name}的位置更新为${location}吗？`);
  }
  handle(text,{focus='',scene=null,cameraActive=false}={}){
    const value=tidy(text);let p=this.pending;
    if(p&&p.expires<=this.clock()){this.pending=null;if(yes(text)||no(text))return this.memory.result('刚才的问题已过期。请重新告诉我想找或记录什么。');p=null;}
    if(p&&no(text)){this.pending=null;return this.memory.result(p.kind==='choose'?'好，再说一个颜色、用途或名称，我继续帮你找。':'好的，先保留原记录。你可以继续问，或告诉我想找什么。');}
    if(p?.kind==='choose'){
      if(/^(还有呢|还有什么|下一批|下几个|继续列出)$/.test(value))return p.offset+5<p.total?this.choose(p.query,p.action,p.offset+5):this.memory.result('这些就是剩余记录了。可以说名称、颜色、用途，或第几个。');
      let record;
      const ordinal=value.match(/^(?:第)?([1-5一二三四五])(?:个|件)?$/);
      if(ordinal)record=p.candidates[Number(ordinal[1])?Number(ordinal[1])-1:'一二三四五'.indexOf(ordinal[1])];
      else if(yes(text)&&p.candidates.length===1)record=p.candidates[0];
      else record=p.candidates.find(r=>tidy(r.name)===value||value==='是'+tidy(r.name));
      if(record){this.pending=null;this.memory.last=record.name;
        if(p.action.kind==='remember')return this.memory.prepare({action:this.memory.get(record.name)?'move':'record',name:record.name,location:p.action.location});
        if(p.action.kind==='find')return {observe:true,goal:'找'+record.name};
        return this.ask('observe',{record},historical(record)+' 要看看现在的画面确认一下吗？');
      }
      // A new question replaces the old clarification; a bare yes cannot select
      // between several candidates.
      if(yes(text))return this.memory.result('有几件相近的物品，请说名称或第几个，我再继续。');
      const close=this.memory.search(value);if(close.length&&value.length>1)return this.choose(value,p.action);
      this.pending=null;
    }else if(p&&yes(text)){
      this.pending=null;
      if(p.kind==='observe')return {observe:true,goal:'找'+p.record.name};
      if(p.kind==='history')return this.memory.result(historical(p.record)+' 可以把镜头转向那个区域，再让我看一下。');
      if(p.kind==='identity')return {...this.update(p.record,p.location,p.sceneAt,p.spatial),focus:p.record.name};
      if(p.kind==='update'){
        if(!cameraActive||!scene||scene.observedAt!==p.sceneAt||this.clock()-Date.parse(p.sceneAt)>120000)return this.memory.result('画面已经变化或过期，先重新看一下再确认位置吧。');
        const current=this.memory.get(p.record.name);
        if(!current||current.recorded_at!==p.record.recorded_at)return this.memory.result('这件物品的记录刚刚变化了，请重新核对后再更新。');
        this.memory.prepare({action:'move',name:p.record.name,location:p.location,...p.spatial,event_time:'刚刚，经用户确认画面中的物品'});
        return this.memory.confirm(this.memory.pending.token);
      }
    }else if(p&&/^(?:重新看|再看|找|帮我找|记住|停止|结束)/.test(value))this.pending=null;
    if(this.memory.pending&&(yes(text)||no(text))){
      const pending=this.memory.pending;
      if(!no(text)&&pending.sceneAt&&(!cameraActive||!scene||scene.observedAt!==pending.sceneAt||this.clock()-Date.parse(pending.sceneAt)>300000)){this.memory.pending=null;return this.memory.result('画面已变化或过期，请重新看一下再保存。');}
      return this.memory.confirm(pending.token,no(text));
    }
    if(/(?:记过什么|记住过什么|记住了什么|记住的什么|记了什么|有哪些记忆|有什么记录|列出.*记忆|忘.*(?:物品|名字|名称|叫什么)|不记得.*(?:名字|名称|记过))/.test(value))return this.choose('');
    const command=rememberCommand(text);
    if(command&&vagueName(command.name)){
      const selected=this.memory.get(focus);
      if(selected)return this.memory.prepare({action:'move',name:selected.name,location:command.location});
      if(cameraActive&&scene&&this.clock()-Date.parse(scene.observedAt)<30000&&scene.objects?.length===1&&!vagueName(scene.objects[0].name))return this.memory.prepare({action:'record',name:scene.objects[0].name,location:command.location});
      if(!this.memory.all().length)return this.memory.result('还没有物品记录。你可以用颜色或用途给它起个名字，比如“蓝色杯子”；画面里有多件东西时，我会先确认是哪一件。');
      return this.choose('',{kind:'remember',location:command.location});
    }
    if(/(?:之前|上次|记忆|记录|记得|记过|忘了)/.test(value)){
      const query=value.replace(/(?:帮我|请|查一下|查询|找一下|查找|之前|上次|记忆|记录|记得|记过|忘了|的|在(?:哪里|哪儿|哪)|放哪了|是什么|那个)/g,'');
      const exact=this.memory.get(query);
      if(exact){this.memory.last=exact.name;return this.ask('observe',{record:exact},historical(exact)+' 要看看现在的画面确认一下吗？');}
      return this.choose(query);
    }
    const finding=value.match(/^(?:请|帮我)?(?:找(?:一下)?|寻找)(.+)$/);
    if(finding&&!this.memory.get(finding[1])&&this.memory.search(finding[1]).length)return this.choose(finding[1],{kind:'find'});
    return null;
  }
  observe(scene,focus,goal){
    this.pending=null;
    const record=this.memory.get(focus);
    if(record&&goal.includes(focus)&&scene.target_visible===false){
      return this.ask('history',{record},`${scene.answer} 我找到你上次记的${record.name}位置，要听一下吗？`).answer;
    }
    const objects=scene.objects||[];
    for(const item of objects){
      const matches=this.memory.search(item.name);
      if(matches.length!==1)continue;
      const saved=matches[0],sameKind=objects.filter(o=>nameSimilarity(o.name,saved.name)>0);
      // Only stable, visible landmarks are proposed as a saved location.
      if(sameKind.length!==1||!item.position||!/(桌|柜|架|抽屉|盒|箱|床|沙发|椅|台|包|篮|地面|地上)/.test(item.position))continue;
      if(item.position.includes(saved.location)||saved.location.includes(item.position))continue;
      const signature=saved.name+'|'+item.position;if(this.seen.has(signature))continue;this.seen.add(signature);
      return this.ask('identity',{record:saved,location:item.position,sceneAt:scene.observedAt,spatial:details(item)},`${scene.answer} 画面里这个${item.name}，是你之前记住的“${saved.name}”吗？`).answer;
    }
    return scene.answer;
  }
}
