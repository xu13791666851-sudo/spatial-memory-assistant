"""Versioned user intent contract. Models propose; the application authorizes actions."""
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class UserIntent(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)
    schema_version: Literal[1] = 1
    intent: Literal['describe_current_scene', 'find_object', 'recall_location',
                    'remember_object', 'recall_recent_observation', 'continue_search',
                    'complete_search', 'cancel', 'stop_session', 'list_memories', 'scene', 'clarify']
    target_text: str = Field(default='', max_length=40)
    target_reference: Literal['unspecified', 'saved_object', 'current_focus', 'current_view'] = 'unspecified'
    time_scope: Literal['current', 'historical', 'recent', 'unspecified'] = 'unspecified'
    needs_clarification: bool = False
    clarification_question: str = Field(default='', max_length=120)

    @model_validator(mode='after')
    def consistent_time(self):
        expected = {'find_object': 'current', 'describe_current_scene': 'current',
                    'remember_object': 'current', 'recall_location': 'historical',
                    'recall_recent_observation': 'recent'}
        if self.intent in expected and self.time_scope != expected[self.intent]:
            raise ValueError('意图与时间范围不一致')
        if self.intent == 'clarify' and not self.needs_clarification:
            raise ValueError('澄清意图必须标记需要澄清')
        return self


def clarify(question='请说明你想看当前画面、查询上次位置，还是记住物品。'):
    return UserIntent(intent='clarify', needs_clarification=True, clarification_question=question)


def clean(text):
    text = re.sub(r'[。！？!?]+$', '', text.strip())
    text = re.sub(r'^(?:你好)?(?:小忆|小意|小易)[，,\s]*', '', text)
    return re.sub(r'^(?:(?:请|帮我|重新|再次|再|麻烦你?))+', '', text)


def explicit_memory_request(text):
    # A negated or quoted memory instruction never grants a write. Unclear cases ask.
    value = clean(text)
    if re.search(r'不|别|不要|不用|无需|[“”「」"]', value.replace('能不能', '能否')):
        return False
    return bool(re.match(r'^(?:我想(?:让你|请你)?|能不能|可以)?(?:帮我)?(?:把.+?)?(?:记住|记录|记下来|记一下|存下来|保存)', value)
                or re.fullmatch(r'(?:我想)?把.{1,50}(?:记下来|存下来|记一下)', value))


def _target(value):
    saved = bool(re.match(r'^(?:我)?(?:上次|之前|以前|昨天)(?:让你)?(?:记住|记录)', value))
    value = re.sub(r'^(?:我)?(?:上次|之前|以前|昨天)(?:让你)?(?:记住|记录)(?:的)?', '', value)
    value = re.sub(r'^(?:我的|这个|那个|这只|那只)', '', value).strip('，, ')
    return value, 'saved_object' if saved else 'unspecified'


def rule_intent(text, focus=None):
    """Only unambiguous commands bypass the model. Return None for free language."""
    value = clean(text)
    if value in ['拿到了', '找到了', '已经拿到', '结束寻找', '我找到了']:
        return UserIntent(intent='complete_search')
    if value in ['关闭摄像头', '停止观察', '结束对话']:
        return UserIntent(intent='stop_session')
    if value in ['不用找了', '别找了', '停止找物', '取消', '取消寻找']:
        return UserIntent(intent='cancel')
    if re.fullmatch(r'这样(?:呢|可以吗)?|这里(?:呢|没有|也没有)|没(?:有)?(?:看见|看到|找到)|已经对准了?|再看(?:一)?下|继续找|现在呢', value) and focus:
        return UserIntent(intent='continue_search', target_text=focus, target_reference='current_focus', time_scope='current')
    if value in ['我在家', '我到家了', '我回家了', '我出门了', '我在外面']:
        return UserIntent(intent='scene')
    if re.search(r'记过什么|记住了哪些|记过哪些', value):
        return UserIntent(intent='list_memories', time_scope='historical')
    # "Don't remember; just look" is observation-only, never permission to write.
    if re.search(r'不|别|不要|不用', value.replace('能不能', '能否')) and re.search(r'记住|记录|记下来', value):
        if re.search(r'看看|描述|眼前|有什么', value):
            return UserIntent(intent='describe_current_scene', time_scope='current')
        return clarify('不会保存。你是想查看当前画面，还是查询已有记录？')
    if explicit_memory_request(value):
        match = re.fullmatch(r'(?:我想)?把(.{1,40}?)(?:记下来|存下来|记一下)', value)
        match = match or re.fullmatch(r'(?:我想(?:让你|请你)?|能不能|可以)?(?:帮我)?(?:记住|记录)(?:我(?:的)?|这个|那个)?(.{1,40}?)(?:的样子|的外观|外观|的位置)?', value)
        if match:
            target, reference = _target(match[1])
            # Position updates are not equivalent to learning three new appearances.
            if re.search(r'放在|移到|挪到', target):
                return clarify('这句话包含位置更新。请先在物品记忆中修改位置；重新采集外观可以说“记住蓝色水杯”。')
            if target in ['它', '这个', '那个', '位置', '物品', '']:
                target = focus or ''
                reference = 'current_focus'
            return UserIntent(intent='remember_object', target_text=target, target_reference=reference, time_scope='current')
    if re.search(r'刚才|刚刚', value) and re.search(r'看到|看见|画面|描述', value) and not re.search(r'现在|目前|此刻', value):
        return UserIntent(intent='recall_recent_observation', time_scope='recent')
    match = re.fullmatch(r'(.{1,60}?)(现在|目前|此刻|上次|之前|以前|昨天)?(?:放)?(?:在哪里|在哪儿|在哪|放哪了)', value)
    if match:
        target, reference = _target(match[1])
        if len(target) > 40:
            return None
        when = match[2]
        if target in ['它', '这个', '那个']:
            target, reference = focus or '', 'current_focus'
        historical = when in ['上次', '之前', '以前', '昨天']
        return UserIntent(intent='recall_location' if historical else 'find_object', target_text=target,
                          target_reference=reference, time_scope='historical' if historical else 'current')
    if re.search(r'上次|之前|以前|历史', value) and re.search(r'位置|放在', value):
        return None  # Free-form history questions are parsed by the model, not guessed.
    match = re.fullmatch(r'(?:找(?:一下)?|寻找|看看)(.{1,60})', value)
    if match:
        target, reference = _target(match[1])
        if target in ['周围', '环境', '眼前', '画面', '这里', '什么', '东西', '眼前有什么'] or re.search(r'有没有|有什么|有些什么|是否', target):
            return UserIntent(intent='describe_current_scene', time_scope='current')
        if target in ['它', '这个', '那个']:
            target, reference = focus or '', 'current_focus'
        if len(target) <= 40:
            return UserIntent(intent='find_object', target_text=target, target_reference=reference, time_scope='current')
    if re.fullmatch(r'(?:帮我)?(?:看看|描述(?:一下)?|看一下)?(?:眼前|周围|当前画面|桌上|这里)(?:有些什么|有什么|有什么东西)?', value):
        return UserIntent(intent='describe_current_scene', time_scope='current')
    return None


async def resolve_intent(text, focus, cloud, memory_names):
    known = rule_intent(text, focus)
    if known:
        return known, 'rule'
    parser = getattr(cloud, 'parse_intent', None)
    if parser is None or not cloud.key:
        return clarify('暂时无法理解这句话。可以说“看看眼前有什么”“水杯上次放在哪里”或“记住蓝色水杯”。'), 'fallback'
    try:
        result = UserIntent.model_validate(await parser(text, focus, memory_names[:10]))
        if result.intent == 'remember_object' and not explicit_memory_request(text):
            return clarify('尚未保存。若需要记忆，请明确说“记住物品名称”。'), 'guard'
        if result.intent in ['cancel', 'stop_session', 'complete_search', 'scene']:
            return clarify('请直接说“取消”“拿到了”或“我在家”。'), 'guard'
        return result, 'model'
    except Exception:
        return clarify('这次意图理解没有完成，没有修改记忆。请换一种说法，或使用固定口令。'), 'fallback'
