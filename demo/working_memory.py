"""Session-only visual evidence. Capture time is independent of request activity."""
from dataclasses import dataclass
import time


@dataclass(frozen=True)
class Observation:
    frame_id: int
    captured_at: int
    received_at: float
    scene_revision: int
    jpeg: bytes
    objects: tuple


class WorkingMemory:
    def __init__(self, max_age_ms=3000, wall_clock=None, monotonic=None):
        self.max_age_ms = max_age_ms
        self.wall_clock = wall_clock or (lambda: time.time() * 1000)
        self.monotonic = monotonic or time.monotonic
        self.scene_revision = 0
        self.latest = None
        self.last_answer = None

    def observe(self, frame_id, captured_at, jpeg, objects):
        observation = Observation(frame_id, captured_at, self.monotonic(), self.scene_revision, jpeg, tuple(objects))
        self.latest = observation
        return observation

    def fresh(self, observation):
        if observation is None or observation.scene_revision != self.scene_revision:
            return False
        age = self.wall_clock() - observation.captured_at
        return (-1000 <= age <= self.max_age_ms and
                0 <= (self.monotonic() - observation.received_at) * 1000 <= self.max_age_ms)

    def current(self, after_frame=0):
        return self.latest if self.fresh(self.latest) and self.latest.frame_id > after_frame else None

    def record_answer(self, observation, answer):
        self.last_answer = {'frame_id': observation.frame_id, 'captured_at': observation.captured_at,
                            'answer': answer, 'source': 'session_observation'}

    def invalidate_scene(self):
        self.scene_revision += 1

    def clear(self):
        self.invalidate_scene()
        self.latest = None
        self.last_answer = None

    def snapshot(self):
        latest = self.latest
        return {'scope': 'session', 'sceneRevision': self.scene_revision,
                'observation': None if latest is None else {
                    'frameId': latest.frame_id, 'capturedAt': latest.captured_at,
                    'source': 'camera_frame', 'current': self.fresh(latest),
                    'objects': list(latest.objects)[:20]},
                'lastDescription': self.last_answer}
