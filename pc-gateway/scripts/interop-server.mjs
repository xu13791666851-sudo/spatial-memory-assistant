import {createGateway} from '../src/server.mjs';
import {directory,fakeCloud} from '../test/helpers.mjs';
import {writeFileSync} from 'node:fs';
const cloud=fakeCloud();
const providers={describe:async f=>({f:f.frameId,v:true,d:'合成流程检查',l:'桌面上',i:['测试杯']}),review:async()=>({box:[.3,.2,.7,.8],location:{location:'桌面上',anchor:'桌面'}})};
const gateway=await createGateway({root:directory(),port:8767,host:'127.0.0.1',providers,detector:{ready:false,started:Promise.resolve(),close(){}},backupOptions:{root:'http://127.0.0.1/',fetcher:cloud.fetcher}});
writeFileSync(process.argv[2],gateway.links[0],{mode:0o600});
console.log('Isolated Android interoperability server ready; cloud API replaced by local test data.');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await gateway.close();process.exit(0);});
