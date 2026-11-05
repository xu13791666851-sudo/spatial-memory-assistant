// Names resolve records; category and coarse colour only narrow candidates, never prove identity.
const groups = [
 ['cup', ['保温杯','马克杯','水杯','茶杯','杯子','杯']],
 ['bottle', ['矿泉水瓶','水瓶','瓶子']], ['mouse', ['鼠标']],
 ['remote', ['遥控器']], ['cell phone', ['手机']], ['book', ['书本','书']],
 ['bus', ['公交车']], ['car', ['汽车']], ['fan', ['小风扇','风扇']],
];
export function objectName(value='') {
 const name=value.trim().replace(/^(?:(?:那|这)?我的|这个|那个|这只|那只|这件|那件|之前说过的|刚才说的)+/,'').replace(/的$/,'');
 const group=groups.find(([,words])=>words.some(w=>name.endsWith(w)));
 const colour=/(蓝|红|白|黑|绿|黄|紫|粉|橙|灰|棕|透明)/.exec(name)?.[1]??null;
 return {name,category:group?.[0]??null,colour};
}
export function detectionLabel(value) {
 const category=objectName(value).category;
 return category==='fan'?null:category;
}
export function matchingObjects(objects, query) {
 const q=objectName(query);if(!q.name)return [];
 const exact=objects.filter(o=>[o.name,...o.aliases].some(n=>objectName(n).name===q.name));
 // A generic query must include all members, even when one old record is named just "水杯".
 const generic=q.category&&!q.colour&&groups.find(([c])=>c===q.category)[1].includes(q.name);
 if(exact.length&&!generic)return exact;
 return objects.filter(o=>[o.name,...o.aliases].some(n=>{
  const p=objectName(n);
  return p.name===q.name||q.category&&q.category===p.category&&(!q.colour||q.colour===p.colour);
 }));
}

// Everyday “water cup” can be a capped bottle. This broadens only the shortlist;
// the saved identity and Jev reference comparison still decide the individual.
export function detectionLabels(name, primary=detectionLabel(name)) {
 return /水杯|保温杯|随行杯|运动杯/.test(name)?['cup','bottle']:primary?[primary]:[];
}
