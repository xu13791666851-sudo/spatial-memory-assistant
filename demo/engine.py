"""Phone-camera workflow port. State, sampled memories and cloud receipts are real."""
import asyncio
import difflib
import re
import time
import uuid
from collections import deque

from .inference import classes, crop, embedding, iou, jpeg, similarity
from .store import normalize


def intent(text, focus=None):
    value = re.sub(r'[。！？!?]+$', '', text.strip())
    value = re.sub(r'^(?:你好)?(?:小忆|小意|小易)[，,\s]*', '', value)
    value = re.sub(r'^(?:(?:请|帮我|重新|再次|再))+', '', value)
    if value in ['拿到了', '找到了', '已经拿到', '结束寻找', '我找到了']:
        return 'complete', ''
    if value in ['不用找了', '别找了', '停止找物', '取消']:
        return 'cancel', ''
    if re.fullmatch(r'这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|没(?:有)?(?:看见|看到|找到)|已经对准了?|再看(?:一)?下|继续找|现在呢', value) and focus:
        return 'search', focus
    if re.search(r'移到|重新记住|更新.*位置', value) and focus:
        return 'remember', focus
    match = re.fullmatch(r'(?:记住|记录)(?:我(?:的)?|这个|那个)?(.{1,40}?)(?:的样子|的外观|外观|的位置)?', value)
    if match:
        target = match[1].strip('，, ')
        if target in ['它', '这个', '那个', '位置']:
            target = focus
        return 'remember', target or ''
    if re.search(r'记过什么|记住了哪些|记过哪些', value):
        return 'list', ''
    if ('上次' in value or '之前' in value or '以前' in value) and re.search(r'在哪|哪里|位置|放在', value):
        name = re.sub(r'^(?:我)?(?:之前|上次|以前)(?:让你)?(?:记住的)?', '', value)
        name = re.sub(r'(?:上次|之前|以前)?(?:放)?(?:在哪里|在哪儿|在哪|位置).*$', '', name)
        return 'history', name or focus or ''
    match = re.fullmatch(r'(?:找(?:一下)?|寻找|看看)(.{1,40})', value) or re.fullmatch(r'(.{1,40}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)', value)
    if match:
        name = match[1].strip()
        if name in ['周围', '环境', '眼前', '画面', '这里', '什么', '东西', '眼前有什么']:
            return 'describe', text
        return 'search', focus if name in ['它', '这个', '那个', '这个物品'] else name
    if value in ['我在家', '我到家了', '我回家了', '我出门了', '我在外面']:
        return 'scene', value
    return 'describe', text


class Session:
    def __init__(self, owner, store, detector, cloud):
        self.owner, self.store, self.detector, self.cloud = owner, store, detector, cloud
        self.epoch = 0
        self.rev = 0
        self.events = deque(maxlen=256)
        self.event_id = 0
        self.samples = []
        self.last_sample = 0
        self.last_check = 0
        self.last_frame = 0
        self.last_frame_id = 0
        self.last_image = None
        self.focus = None
        self.memory = None
        self.references = []
        self.previous = None
        self.hits = 0
        self.job = None
        self.frame_busy = False
        self.seen = time.monotonic()
        self.pending_choices = []
        self.offer_history = False
        self.reset_state()

    def reset_state(self):
        self.state = dict(running=False, paused=False, target=None, searchState='IDLE', source='PHONE', message='识别后台已就绪', error=None, learningSamples=0, rememberedObjectId=None, verifiedBox=None, verifiedAt=0)

    def change(self, **values):
        self.state.update(values)
        self.rev += 1

    def emit(self, kind, data):
        self.event_id += 1
        self.events.append(dict(id=self.event_id, type=kind, data=data))

    def say(self, text, **extra):
        self.emit('answer', dict(text=text, **extra))

    def snapshot(self, since=0):
        return dict(state={**self.state, 'epoch': self.epoch}, rev=self.rev, events=[e for e in self.events if e['id']>since], memories=self.store.all(self.owner), labels=80, connection='CONNECTED' if self.cloud.key else 'DISCONNECTED')

    def invalidate(self):
        self.epoch += 1
        if self.job:
            self.job.cancel()
            self.job = None
        self.samples = []
        self.previous = None
        self.hits = 0
        self.last_check = 0
        self.offer_history = False
        self.change(verifiedBox=None, verifiedAt=0, error=None)

    def matches(self, name):
        all_items = self.store.all(self.owner)
        exact = [r for r in all_items if normalize(r['name']) == normalize(name)]
        if exact:
            return exact
        similar = [r for r in all_items if name and (name in r['name'] or r['name'] in name)]
        return similar or [r for r in all_items if name and difflib.SequenceMatcher(None, name, r['name']).ratio() >= .6]

    async def command(self, method, params):
        self.seen = time.monotonic()
        if method == 'status':
            return dict(labels=80, connection='CONNECTED' if self.cloud.key else 'DISCONNECTED')
        if method == 'start':
            self.invalidate()
            self.change(running=True, paused=False, target=None, searchState='IDLE', message='正在聆听，请说出你想做的事。')
            self.last_frame = time.monotonic()
            self.say('你好，我是小忆。可以让我看看周围，记住物品，或者帮你找东西。')
            return True
        if method in ['stop', 'pause']:
            target, stage = self.state['target'], self.state['searchState']
            self.invalidate()
            self.last_image = None
            self.change(running=False, paused=method=='pause', target=target if method=='pause' else None, searchState=stage if method=='pause' else 'IDLE', message='已暂停' if method=='pause' else '已结束，相机和麦克风已关闭。')
            return True
        if method == 'resume':
            target, stage = self.state['target'], self.state['searchState']
            self.invalidate()
            self.change(running=True, paused=False)
            self.last_frame = time.monotonic()
            if target:
                await self.begin('remember' if stage=='LEARNING' else 'search', target)
            return True
        if method in ['editMemory', 'deleteMemory']:
            if self.state['rememberedObjectId'] == params.get('id'):
                self.invalidate()
                self.change(target=None, searchState='IDLE', rememberedObjectId=None)
            self.store.edit(self.owner, params, delete=method=='deleteMemory')
            return dict(items=self.store.all(self.owner), answer='已保存修改。' if method=='editMemory' else '已删除这条记忆。')
        if method == 'cancel':
            self.invalidate()
            self.change(target=None, searchState='CANCELLED', message='已取消寻找', rememberedObjectId=None)
            self.say('已取消寻找。')
            return True
        if method in ['search', 'remember']:
            await self.begin(method, str(params.get('target', '')))
            return True
        if method != 'text':
            raise ValueError('这个操作未包含在手机摄像头演示中。')
        if not self.state['running'] or self.state['paused']:
            raise ValueError('请先点击开始。')
        text = str(params.get('text', '')).strip()
        if not 0 < len(text) <= 400:
            raise ValueError('请输入不超过400字的内容。')
        if self.offer_history and text.strip('。！？!? ') in ['需要','要','好','好的','是','听一下','上次的位置']:
            self.offer_history=False
            record=next((r for r in self.store.all(self.owner) if self.memory and r['id']==self.memory['id']),None)
            self.say(record['name']+'上次记录：'+record['location']+'。这是历史位置，尚未由当前画面确认。' if record else '这条历史记忆已经变化，请重新打开记录查看。')
            return True
        if self.offer_history and text.strip('。！？!? ') in ['不需要','不要','不用了']:
            self.offer_history=False
            self.say('好，继续看当前画面。')
            return True
        if self.pending_choices:
            choices = [r for r in self.pending_choices if text in r['name'] or r['name'] in text]
            if len(choices)==1:
                self.pending_choices = []
                await self.begin('search', choices[0]['name'])
                return True
        action, value = intent(text, self.focus)
        if action in ['search', 'remember']:
            await self.begin(action, value)
        elif action == 'complete':
            self.invalidate()
            self.change(searchState='COMPLETED', message='本轮寻找已完成。')
            self.say('本轮寻找已完成。')
        elif action == 'cancel':
            await self.command('cancel', {})
        elif action == 'list':
            names = [r['name'] for r in self.store.all(self.owner)]
            self.say('你记住过：'+'、'.join(names[:10])+'。你想找哪一件？' if names else '还没有保存的物品。')
        elif action == 'history':
            records = self.matches(value)
            if len(records)==1:
                self.focus = records[0]['name']
                self.say(records[0]['name']+'上次记录：'+records[0]['location']+'。这是历史位置，尚未由当前画面确认。')
            else:
                self.say('请说明要查询哪件物品。'+('已有记录：'+'、'.join(r['name'] for r in records[:5]) if records else '没有找到相近记录。'))
        elif action == 'scene':
            self.say('已切换场景，物品记忆仍然保留。')
        else:
            self.invalidate()
            self.change(searchState='IDLE', target=None)
            token = self.epoch
            async def describe():
                try:
                    # Wait for a frame from this started camera, never use a prior session.
                    for _ in range(30):
                        if self.epoch!=token: return
                        if self.last_image and time.monotonic()-self.last_frame<3: break
                        await asyncio.sleep(.1)
                    if not self.last_image:
                        self.say('还没有收到当前画面，请检查摄像头权限。')
                        return
                    answer = await self.cloud.describe(self.last_image, text, self.store.all(self.owner))
                    if self.epoch==token and self.state['running']:
                        self.say(answer, cloud=True)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    if self.epoch==token:
                        self.say('这次画面理解没有完成，请稍后再试；没有保存或更新任何记忆。')
            self.job = asyncio.create_task(describe())
        return True

    async def begin(self, action, target):
        target = str(target or '').strip()
        if not 1 <= len(target) <= 40 or target in ['这个', '那个', '它', '东西']:
            self.say('请先告诉我一个物品名称，例如绿色水杯，并把它放在画面中央。')
            return
        self.invalidate()
        records = self.matches(target)
        if action=='search' and len(records)>1:
            self.pending_choices = records
            self.change(target=None, searchState='IDLE')
            self.say('记忆里有：'+'、'.join(r['name'] for r in records[:5])+'。你想找哪一件？')
            return
        self.pending_choices = []
        self.memory = records[0] if len(records)==1 and action=='search' else None
        self.references = self.store.references(self.owner, self.memory['id']) if self.memory else []
        if self.memory:
            target = self.memory['name']
        self.focus = target
        message = f'请把{target}放在画面中央，缓慢转动。将采集三个外观样本。' if action=='remember' else f'正在结合已保存外观寻找{target}。请缓慢移动镜头。' if self.memory else f'还没有{target}的外观记忆，先根据名称寻找；找到后可以说记住它。'
        self.change(target=target, searchState='LEARNING' if action=='remember' else 'SEARCHING', learningSamples=0, rememberedObjectId=self.memory['id'] if self.memory else None, message=message)
        self.say(message)

    async def frame(self, picture, raw, frame_id, captured_at, epoch):
        self.seen = self.last_frame = time.monotonic()
        if not self.state['running'] or self.state['paused'] or epoch!=self.epoch:
            return None
        if frame_id<=self.last_frame_id:
            raise ValueError('重复或过期的画面已忽略。')
        self.last_frame_id = frame_id
        detections, latency = await asyncio.to_thread(self.detector.detect, picture)
        if epoch!=self.epoch or not self.state['running']:
            return None
        self.last_image = raw
        self.change(yoloLatencyMs=latency)
        target = self.state['target']
        eligible = [d for d in detections if d['label'] in classes(target or '') and d['confidence']>=.5]
        stage = self.state['searchState']
        if stage=='LEARNING' and len(self.samples)<3 and time.monotonic()-self.last_sample >= .6:
            # Same handoff rule: nearest supported target, otherwise center crop.
            box = min(eligible, key=lambda d: abs((d['box'][0]+d['box'][2])/2-.5)+abs((d['box'][1]+d['box'][3])/2-.5))['box'] if eligible else [.25, .25, .75, .75]
            sample = crop(picture, box)
            self.samples.append(dict(jpeg=jpeg(sample), embedding=embedding(sample)))
            self.last_sample = time.monotonic()
            self.change(learningSamples=len(self.samples), message=f'正在记住{target}：已采集{len(self.samples)}/3个样本。')
            if len(self.samples)==3:
                samples = list(self.samples)
                self.change(message='三个样本已采集，正在核对名称和外观；尚未保存。')
                async def enrich():
                    try:
                        detail = await self.cloud.memory_description(raw, samples, target)
                        if self.epoch!=epoch: return
                        if detail.get('target_matches') is not True:
                            self.samples=[]
                            self.change(target=None,searchState='IDLE',learningSamples=0,message='尚未保存：样本外观与名称没有核对一致。')
                            self.say('还没有保存。没有确认三个样本都是'+target+'，请把物品放在中央、拍清颜色和外形，再说记住物品。')
                            return
                        location=detail['location'] if detail.get('location') and detail.get('anchor') else '已记住外观，尚未记录位置'
                        ident=self.store.save(self.owner,target,samples,detail.get('appearance',''),location)
                        self.samples=[]
                        self.change(target=None,searchState='IDLE',rememberedObjectId=ident,message=f'已经记住{target}，已实际保存三个外观样本。')
                        self.say(self.state['message']+('这次记录的位置是：'+location+'。以后查询会说明这是历史位置。' if location!='已记住外观，尚未记录位置' else '这次没有确认清楚位置，外观样本已经保存。'),saved=True)
                        self.emit('memories',dict(items=self.store.all(self.owner)))
                    except asyncio.CancelledError: raise
                    except Exception:
                        if self.epoch==epoch:
                            self.samples=[]
                            self.change(target=None,searchState='IDLE',learningSamples=0,message='尚未保存：这次外观核对没有完成。')
                            self.say('还没有保存。这次外观核对没有完成，旧记忆保持原样，请稍后重新采集。')
                self.job = asyncio.create_task(enrich())
        elif stage=='SEARCHING':
            candidates = []
            for detection in eligible:
                part = crop(picture, detection['box'])
                score = max((similarity(embedding(part), r['embedding']) for r in self.references), default=None)
                combined = detection['confidence'] if score is None else .35*detection['confidence']+.65*score
                if combined>=.5:
                    candidates.append({**detection, 'score':combined, 'crop':jpeg(part)})
            candidate = max(candidates, key=lambda c: c['score'], default=None)
            if candidate:
                self.hits = self.hits+1 if self.previous and self.previous['label']==candidate['label'] and iou(self.previous['box'],candidate['box'])>=.2 else 1
                self.previous = candidate
            else:
                self.hits, self.previous = 0, None
            elapsed = time.monotonic()-self.last_check
            # A supported-class miss is also checked occasionally: absence of a
            # local box is not proof that a close-up remembered object is absent.
            if elapsed>=6 and ((candidate and self.hits>=2) or not candidate):
                self.last_check = time.monotonic()
                self.change(searchState='VERIFYING', message='正在根据实际外观样本核对当前画面。', verifiedBox=candidate['box'] if candidate else None, verifiedAt=0)
                self.job = asyncio.create_task(self.verify(raw, candidate, epoch, frame_id))
        return dict(image='', width=picture.width, height=picture.height, capturedAt=captured_at, detections=detections)

    async def verify(self, raw, candidate, epoch, frame_id):
        try:
            result = await self.cloud.verify(raw, candidate['crop'] if candidate else None, self.references, self.focus, self.memory['appearance'] if self.memory else '')
            if self.epoch!=epoch or not self.state['running']:
                return
            if result['visible'] and result['same'] and result['confidence']>=.7:
                detail = '，'.join(v for v in [result['direction'], result['anchor'], result['state']] if v)
                self.change(searchState='GUIDING', verifiedBox=candidate['box'] if candidate else None, verifiedAt=int(time.time()*1000), message='已核对当前画面中的'+self.focus)
                self.say('看到了'+self.focus+('，'+detail if detail else '')+'。左右以镜头画面为准。')
            else:
                self.change(searchState='SEARCHING', verifiedBox=None, verifiedAt=0, message='当前画面还没有确认是记住的物品，继续寻找。')
                self.offer_history=bool(self.memory)
                self.say('还没有确认是你要找的'+self.focus+'。可以换一个角度，把物品和周围的桌面一起拍进来。'+('需要听听上次记住的位置吗？' if self.memory else ''))
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.epoch==epoch and self.state['running']:
                self.change(searchState='SEARCHING', verifiedBox=None, verifiedAt=0, error='这次千问核对没有完成，继续识别；没有判断为找不到。', message='确认暂未完成，继续寻找。')
                self.say('这次确认没有完成，我会继续看新画面。')
