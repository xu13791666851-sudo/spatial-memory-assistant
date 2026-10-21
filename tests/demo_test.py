import asyncio
import base64
import io
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from demo.engine import Session, intent
from demo.inference import embedding, jpeg, similarity
from demo.server import create_app
from demo.store import Store


class Detector:
    interpreter = True
    def load(self): pass
    def detect(self, picture):
        return [dict(label='cup',confidence=.9,box=[.2,.2,.8,.8])], 1


class Cloud:
    key = 'test-only-not-a-real-key'
    def __init__(self):
        self.calls=[];self.result=dict(visible=True,same=True,confidence=.95,direction='画面中间',anchor='木桌旁',state='静置')
        self.wait=None;self.learning_matches=True
    async def verify(self, full, candidate, references, target, description):
        self.calls.append(dict(references=references,target=target))
        if self.wait: await self.wait.wait()
        return self.result
    async def memory_description(self,*args): return {'target_matches':self.learning_matches}
    async def describe(self,*args): return '画面中有一个绿色杯子。'


class Core(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.store=Store(str(Path(self.temp.name)/'db.sqlite3'));self.cloud=Cloud();self.session=Session('owner-a',self.store,Detector(),self.cloud)
        self.picture=Image.new('RGB',(160,120),(20,180,40));self.raw=jpeg(self.picture);self.index=0
        await self.session.command('start',{})
    async def asyncTearDown(self):
        await self.session.command('stop',{});self.store.db.close();self.temp.cleanup()
    async def frame(self):
        self.index+=1;self.session.last_sample=0
        return await self.session.frame(self.picture,self.raw,self.index,int(time.time()*1000),self.session.epoch)
    async def learn(self):
        await self.session.command('text',{'text':'帮我记住绿色水杯的位置'})
        for _ in range(3): await self.frame()
        await asyncio.sleep(0)

    async def test_three_real_samples_and_restart_find(self):
        await self.learn();records=self.store.all('owner-a');self.assertEqual(len(records),1);self.assertEqual(records[0]['sample_count'],3)
        self.assertEqual(len(self.store.references('owner-a',records[0]['id'])),3)
        second=Session('owner-a',self.store,Detector(),self.cloud);await second.command('start',{});await second.command('text',{'text':'重新帮我找绿色水杯'})
        self.assertEqual(second.state['rememberedObjectId'],records[0]['id']);self.assertEqual(len(second.references),3)
        for ident in [100,101]: await second.frame(self.picture,self.raw,ident,int(time.time()*1000),second.epoch)
        await asyncio.sleep(.02);self.assertEqual(second.state['searchState'],'GUIDING');self.assertEqual(len(self.cloud.calls[0]['references']),3)
        await second.command('stop',{})

    async def test_rejected_and_cancelled_results_never_announce_found(self):
        await self.learn();self.cloud.result['same']=False
        await self.session.command('text',{'text':'帮我找绿色水杯'})
        await self.frame();await self.frame();await asyncio.sleep(.01)
        self.assertEqual(self.session.state['searchState'],'SEARCHING')
        self.cloud.wait=asyncio.Event();self.cloud.result['same']=True
        await self.session.command('text',{'text':'再帮我找绿色水杯'});await self.frame();await self.frame();await asyncio.sleep(0)
        await self.session.command('cancel',{});self.cloud.wait.set();await asyncio.sleep(.02)
        self.assertEqual(self.session.state['searchState'],'CANCELLED')
        self.assertFalse(any('看到了绿色水杯' in e['data'].get('text','') for e in self.session.events))

    async def test_cancel_learning_retains_prior_memory_and_edit_is_isolated(self):
        await self.learn();record=self.store.all('owner-a')[0]
        await self.session.command('remember',{'target':'绿色水杯'});await self.frame();await self.session.command('stop',{})
        self.assertEqual(self.store.all('owner-a')[0]['recorded_at'],record['recorded_at'])
        with self.assertRaises(ValueError): self.store.edit('owner-b',{**record,'name':'错物品'})
        changed={**record,'location':'电脑左侧','appearance':'绿色杯身'};self.store.edit('owner-a',changed)
        with self.assertRaises(ValueError): self.store.edit('owner-a',changed)
        current=self.store.all('owner-a')[0];self.store.edit('owner-a',current,delete=True);self.assertEqual(self.store.all('owner-a'),[])

    async def test_ambiguous_memory_requires_choice(self):
        await self.learn();refs=self.store.references('owner-a',self.store.all('owner-a')[0]['id']);self.store.save('owner-a','蓝色水杯',refs)
        await self.session.command('text',{'text':'找水杯'});self.assertEqual(self.session.state['searchState'],'IDLE');self.assertEqual(len(self.session.pending_choices),2)
        await self.session.command('text',{'text':'绿色'});self.assertEqual(self.session.state['target'],'绿色水杯')

    async def test_stale_frame_cannot_save_after_stop(self):
        await self.session.command('remember',{'target':'绿色水杯'});epoch=self.session.epoch;await self.session.command('stop',{})
        result=await self.session.frame(self.picture,self.raw,1,int(time.time()*1000),epoch);self.assertIsNone(result);self.assertEqual(self.store.all('owner-a'),[])

    async def test_mismatched_new_samples_do_not_replace_old_or_claim_saved(self):
        await self.learn();before=self.store.all('owner-a')[0];cursor=self.session.event_id;self.cloud.learning_matches=False
        await self.learn();self.assertEqual(self.store.all('owner-a')[0],before)
        self.assertFalse(any(e['data'].get('saved') for e in self.session.events if e['id']>cursor))

    async def test_unsupported_class_still_checks_full_frame_without_inventing_box(self):
        await self.session.command('text',{'text':'记住钥匙'})
        for _ in range(3): await self.frame()
        await asyncio.sleep(0);await self.session.command('text',{'text':'帮我找钥匙'})
        await self.frame();await asyncio.sleep(.02)
        self.assertEqual(self.session.state['searchState'],'GUIDING');self.assertIsNone(self.session.state['verifiedBox'])
        self.assertEqual(len(self.cloud.calls[-1]['references']),3)

    def test_ported_histogram_and_dialogue(self):
        green=embedding(self.picture);red=embedding(Image.new('RGB',(160,120),(220,10,10)))
        self.assertAlmostEqual(similarity(green,green),1);self.assertLess(similarity(green,red),.5)
        self.assertEqual(intent('重新帮我找绿色水杯'),('search','绿色水杯'));self.assertEqual(intent('帮我记住绿色水杯的位置'),('remember','绿色水杯'))
        self.assertEqual(intent('绿色水杯上次放在哪里'),('history','绿色水杯'))


class Http(unittest.TestCase):
    def test_cookie_isolation_csrf_actual_frames_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            app=create_app(folder,Detector(),Cloud())
            with TestClient(app) as a,TestClient(app) as b:
                first=a.get('/api/demo/bootstrap').json();second=b.get('/api/demo/bootstrap').json()
                headers={'X-Demo-CSRF':first['csrf']}
                self.assertNotEqual(first['csrf'],second['csrf'])
                self.assertEqual(a.post('/api/demo/command',json={'method':'start'}).status_code,403)
                self.assertEqual(a.post('/api/demo/command',json={'method':'start'},headers={**headers,'Origin':'https://attacker.test'}).status_code,403)
                self.assertEqual(a.post('/api/demo/command',json={'method':'start'},headers=headers).status_code,200)
                a.post('/api/demo/command',json={'method':'text','params':{'text':'记住绿色水杯'}},headers=headers)
                state=a.get('/api/demo/state').json()['state'];raw=base64.b64encode(jpeg(Image.new('RGB',(160,120),'green'))).decode()
                for i in range(3):
                    for session in app.state.sessions.values(): session.last_sample=0
                    response=a.post('/api/demo/frame',json={'image':raw,'id':i+1,'capturedAt':int(time.time()*1000),'epoch':state['epoch']},headers=headers)
                    self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(a.get('/api/demo/state').json()['memories'][0]['sample_count'],3)
                self.assertEqual(b.get('/api/demo/state').json()['memories'],[])
                cookies=dict(a.cookies)
            app.state.store.db.close()
            another=create_app(folder,Detector(),Cloud())
            with TestClient(another) as c:
                c.cookies.update(cookies);self.assertEqual(c.get('/api/demo/bootstrap').json()['memories'][0]['sample_count'],3)
            another.state.store.db.close()


if __name__=='__main__': unittest.main()
