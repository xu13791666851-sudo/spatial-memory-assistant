"""Regression scenarios for time/source separation and application-controlled intents."""
import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image
from pydantic import ValidationError

from demo.cloud import Cloud as RealCloud
from demo.engine import Session
from demo.inference import jpeg
from demo.intents import UserIntent, explicit_memory_request, resolve_intent, rule_intent
from demo.store import Store
from demo.working_memory import WorkingMemory
from demo_test import Cloud, Detector


class IntentContract(unittest.IsolatedAsyncioTestCase):
    def test_object_reference_and_query_time_are_independent(self):
        cases = [
            ('上次记住的蓝色水杯现在在哪', 'find_object', '蓝色水杯', 'current', 'saved_object'),
            ('蓝色水杯上次放在哪里', 'recall_location', '蓝色水杯', 'historical', 'unspecified'),
            ('我想把这个杯子记下来', 'remember_object', '杯子', 'current', 'unspecified'),
            ('能不能记住蓝色水杯', 'remember_object', '蓝色水杯', 'current', 'unspecified'),
            ('帮我看看眼前有什么', 'describe_current_scene', '', 'current', 'unspecified'),
            ('别记住，只看看', 'describe_current_scene', '', 'current', 'unspecified'),
            ('刚才看到的是什么', 'recall_recent_observation', '', 'recent', 'unspecified'),
            ('继续找', 'continue_search', '蓝色水杯', 'current', 'current_focus'),
        ]
        for text, action, target, scope, reference in cases:
            with self.subTest(text=text):
                result = rule_intent(text, '蓝色水杯')
                self.assertEqual((result.intent, result.target_text, result.time_scope, result.target_reference),
                                 (action, target, scope, reference))

    def test_schema_rejects_extra_authority_and_contradictory_time(self):
        for data in [dict(intent='find_object', time_scope='historical'),
                     dict(intent='recall_location', time_scope='historical', user_id='someone-else'),
                     dict(intent='delete_everything'), dict(intent='clarify', needs_clarification='true')]:
            with self.subTest(data=data), self.assertRaises(ValidationError):
                UserIntent.model_validate(data)

    async def test_model_cannot_promote_a_tentative_hint_to_long_term_write(self):
        cloud = Cloud()
        cloud.parse_intent = AsyncMock(return_value={'intent':'remember_object','time_scope':'current','target_text':'水杯'})
        result, source = await resolve_intent('我可能把水杯放厨房了', None, cloud, [])
        self.assertEqual((result.intent, source), ('clarify', 'guard'))
        self.assertFalse(explicit_memory_request('他说“记住水杯”'))
        self.assertFalse(explicit_memory_request('别记住这个杯子'))

    async def test_free_language_uses_model_but_controls_do_not(self):
        cloud = Cloud()
        cloud.parse_intent = AsyncMock(return_value={'intent':'find_object','time_scope':'current','target_text':'水杯'})
        result, source = await resolve_intent('能帮我寻一下带手柄的那个吗', '水杯', cloud, ['水杯'])
        self.assertEqual((result.target_text, source), ('水杯', 'model'))
        for word in ['取消', '拿到了', '关闭摄像头']:
            await resolve_intent(word, '水杯', cloud, [])
        self.assertEqual(cloud.parse_intent.await_count, 1)

    async def test_invalid_or_failed_model_returns_clarification(self):
        cloud = Cloud()
        for outcome in [{'intent':'find_object','time_scope':'historical'}, RuntimeError('offline')]:
            cloud.parse_intent = AsyncMock(**({'side_effect':outcome} if isinstance(outcome, Exception) else {'return_value':outcome}))
            result, source = await resolve_intent('那个东西能帮忙看看吗', None, cloud, [])
            self.assertEqual((result.intent, source), ('clarify', 'fallback'))

    async def test_actual_http_adapter_sends_text_only_json_mode(self):
        payload = {'intent':'find_object','target_text':'水杯','time_scope':'current'}
        response = httpx.Response(200, json={'choices':[{'message':{'content':__import__('json').dumps(payload)}}]},
                                  request=httpx.Request('POST','https://example.com'))
        client = AsyncMock()
        client.post.return_value = response
        manager = AsyncMock()
        manager.__aenter__.return_value = client
        with patch('demo.cloud.httpx.AsyncClient', return_value=manager):
            result = await RealCloud('test-only').parse_intent('帮忙寻一下杯子', None, ['水杯'])
        request = client.post.call_args.kwargs['json']
        self.assertEqual(request['response_format'], {'type':'json_object'})
        self.assertEqual(request['modalities'], ['text'])
        self.assertEqual(result['intent'], 'find_object')


class EvidenceLifetime(unittest.TestCase):
    def test_capture_expiry_is_not_refreshed_by_new_activity(self):
        wall, mono = [10000], [10.0]
        memory = WorkingMemory(wall_clock=lambda:wall[0], monotonic=lambda:mono[0])
        observation = memory.observe(1, 10000, b'jpeg', [])
        self.assertTrue(memory.fresh(observation))
        wall[0] += 3100
        self.assertIsNone(memory.current())
        # Even a brand-new arrival cannot make an old captured image current.
        memory.observe(2, 10000, b'jpeg', [])
        self.assertIsNone(memory.current())

    def test_scene_change_and_session_clear(self):
        memory = WorkingMemory(wall_clock=lambda:10000)
        observation = memory.observe(1, 10000, b'jpeg', [])
        memory.record_answer(observation, '杯子在桌上')
        memory.invalidate_scene()
        self.assertFalse(memory.fresh(observation))
        self.assertIsNotNone(memory.last_answer)  # Past observation stays past, not current.
        memory.clear()
        self.assertIsNone(memory.last_answer)
        self.assertIsNone(memory.latest)


class SessionScenarios(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.temp.name)/'memory.sqlite3'))
        self.cloud = Cloud()
        self.cloud.describe = AsyncMock(return_value='桌上有绿色水杯。')
        self.session = Session('owner', self.store, Detector(), self.cloud)
        self.session.observation_wait_seconds = .2
        self.picture = Image.new('RGB', (160,120), 'green')
        self.raw = jpeg(self.picture)
        self.frame_id = 0
        self.wall = [time.time()*1000]
        self.session.short_term.wall_clock = lambda:self.wall[0]
        await self.session.command('start', {})

    async def asyncTearDown(self):
        await self.session.command('stop', {})
        self.store.db.close()
        self.temp.cleanup()

    async def frame(self, captured=None):
        self.frame_id += 1
        return await self.session.frame(self.picture, self.raw, self.frame_id,
            int(captured if captured is not None else self.wall[0]), self.session.epoch)

    def answers(self):
        return [event['data'] for event in self.session.events if event['type']=='answer']

    def save(self):
        from demo.inference import embedding
        return self.store.save('owner','绿色水杯',[{'jpeg':self.raw,'embedding':embedding(self.picture)}]*3,
                               '绿色杯子','书桌上，电脑左侧')

    async def test_current_description_uses_new_frame_without_long_term_context(self):
        self.save()
        await self.frame()
        await self.session.command('text', {'text':'帮我看看眼前有什么'})
        await self.frame()
        await self.session.job
        self.assertEqual(self.cloud.describe.call_args.args[2], [])
        answer = self.answers()[-1]
        self.assertEqual(answer['evidence'], 'current_camera_frame')
        self.assertEqual(answer['frameId'], self.frame_id)
        self.assertEqual(len(self.store.all('owner')), 1)
        self.assertNotIn('jpeg', str(self.session.snapshot()['shortTerm']))

    async def test_existing_image_and_new_heartbeat_do_not_bypass_expiry(self):
        await self.frame(captured=self.wall[0]-10000)
        self.session.last_frame = time.monotonic()
        await self.session.command('text', {'text':'看看眼前有什么'})
        await self.session.job
        self.cloud.describe.assert_not_awaited()
        self.assertIn('当前无法确认', self.answers()[-1]['text'])

    async def test_stale_model_description_is_not_reported_as_current(self):
        async def delayed(*args):
            self.wall[0] += 4000
            return '现在水杯在桌上'
        self.cloud.describe.side_effect = delayed
        await self.session.command('text', {'text':'看看眼前有什么'})
        await self.frame()
        await self.session.job
        self.assertNotEqual(self.answers()[-1].get('evidence'), 'current_camera_frame')
        self.assertIn('过期', self.answers()[-1]['text'])

    async def test_recent_recall_is_marked_as_past_and_does_not_write(self):
        await self.session.command('text', {'text':'看看眼前有什么'})
        await self.frame()
        await self.session.job
        self.wall[0] += 10000
        await self.session.command('text', {'text':'刚才看到的是什么'})
        self.assertEqual(self.answers()[-1]['evidence'], 'session_observation')
        self.assertIn('不代表现在', self.answers()[-1]['text'])
        self.assertEqual(self.store.all('owner'), [])

    async def test_history_can_be_read_without_starting_camera(self):
        self.save()
        await self.session.command('stop', {})
        await self.session.command('text', {'text':'绿色水杯上次放在哪里'})
        self.assertFalse(self.session.state['running'])
        self.assertEqual(self.answers()[-1]['evidence'], 'long_term_record')
        self.assertIn('尚未由当前画面确认', self.answers()[-1]['text'])
        self.cloud.describe.assert_not_awaited()

    async def test_saved_object_current_query_does_not_announce_historical_position(self):
        self.save()
        await self.session.command('text', {'text':'上次记住的绿色水杯现在在哪'})
        self.assertEqual(self.session.state['searchState'], 'SEARCHING')
        self.assertEqual(self.session.state['target'], '绿色水杯')
        self.assertNotIn('电脑左侧', self.answers()[-1]['text'])

    async def test_natural_memory_request_enters_learning_not_description(self):
        await self.session.command('text', {'text':'我想把这个杯子记下来'})
        self.assertEqual(self.session.state['searchState'], 'LEARNING')
        self.assertEqual(self.store.all('owner'), [])
        self.cloud.describe.assert_not_awaited()

    async def test_cancel_wins_over_delayed_model_intent(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def parse(*args):
            entered.set(); await release.wait()
            return {'intent':'remember_object','time_scope':'current','target_text':'水杯'}
        self.cloud.parse_intent = parse
        pending = asyncio.create_task(self.session.command('text', {'text':'保存蓝色水杯'}))
        await entered.wait()
        await self.session.command('cancel', {})
        release.set(); await pending
        self.assertEqual(self.session.state['searchState'], 'CANCELLED')
        self.assertEqual(self.store.all('owner'), [])

    async def test_cancel_is_not_treated_as_a_choice_of_an_object_named_cancel(self):
        self.session.pending_choices = [{'name':'取消按钮旁的水杯'}]
        await self.session.command('text', {'text':'取消'})
        self.assertEqual(self.session.state['searchState'], 'CANCELLED')

    async def test_position_update_does_not_trigger_relearning_a_previous_focus(self):
        self.session.focus = '旧水杯'
        await self.session.command('text', {'text':'记住蓝色水杯移到厨房了'})
        self.assertEqual(self.session.last_intent['intent'], 'clarify')
        self.assertNotEqual(self.session.state['searchState'], 'LEARNING')
        self.assertEqual(self.store.all('owner'), [])

    async def test_expired_search_verification_does_not_claim_found(self):
        self.save()
        async def verify(*args):
            self.wall[0] += 4000
            return dict(self.cloud.result)
        self.cloud.verify = verify
        await self.session.command('text', {'text':'找绿色水杯'})
        await self.frame(); await self.frame()
        await self.session.job
        self.assertEqual(self.session.state['searchState'], 'SEARCHING')
        self.assertFalse(any(a.get('text','').startswith('看到了绿色水杯') for a in self.answers()))

    async def test_stop_clears_short_term_but_keeps_long_term(self):
        self.save(); await self.frame()
        await self.session.command('text', {'text':'关闭摄像头'})
        self.assertFalse(self.session.state['running'])
        self.assertIsNone(self.session.short_term.latest)
        self.assertEqual(len(self.store.all('owner')), 1)


if __name__ == '__main__':
    unittest.main()
