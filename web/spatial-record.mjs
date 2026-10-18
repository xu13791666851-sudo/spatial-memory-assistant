const text=(value,max=300)=>typeof value==='string'?value.trim().slice(0,max):'';
const unique=values=>[...new Set(values.filter(Boolean))];
export function details(value={}){
  value=value||{};
  return {
    appearance:text(value.appearance,300),
    aliases:unique((Array.isArray(value.aliases)?value.aliases:[]).map(x=>text(x,60))).slice(0,10),
    relations:(Array.isArray(value.relations)?value.relations:[]).filter(r=>r&&typeof r.reference==='string'&&typeof r.relation==='string').map(r=>({reference:text(r.reference,80),relation:text(r.relation,80)})).filter(r=>r.reference&&r.relation).slice(0,12)
  };
}
export function mergeDetails(old={},next={},append=false){
  const a=details(old),b=details(next);
  const changed=new Set(b.relations.map(r=>r.reference));
  const relations=append?[...a.relations.filter(r=>!changed.has(r.reference)),...b.relations]:b.relations;
  return {appearance:b.appearance||a.appearance,aliases:unique([...a.aliases,...b.aliases]).slice(0,10),relations:[...new Map(relations.map(r=>[r.reference+'|'+r.relation,r])).values()].slice(0,12)};
}
export function describeRecord(record){
  const d=details(record),parts=[record.location,...d.relations.map(r=>r.reference+'的'+r.relation)];
  return unique(parts).join('；')+(d.appearance?'。外观：'+d.appearance:'');
}
