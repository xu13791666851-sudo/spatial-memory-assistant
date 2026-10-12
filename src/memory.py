"""Local observations, with explicit human sources and reversible dialogue state."""
import re
from contextlib import contextmanager
import secrets
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

TZ = timezone(timedelta(hours=8))


def now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def clean(value, limit=120):
    value = str(value).strip().strip("，。！？!?, ")
    if not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise ValueError("请填写简短、有效的名称或位置。")
    return value


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, location TEXT NOT NULL,
                event_time TEXT NOT NULL, recorded_at TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source='MANUAL'),
                state TEXT NOT NULL CHECK(state='HISTORICAL'),
                correction_of INTEGER)""")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, name):
        with self.db() as db:
            row = db.execute("SELECT * FROM observations WHERE name=? ORDER BY id DESC LIMIT 1", (name,)).fetchone()
        return dict(row) if row else None

    def all(self):
        with self.db() as db:
            rows = db.execute("SELECT * FROM observations WHERE id IN (SELECT MAX(id) FROM observations GROUP BY name) ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    def record(self, name, location, event_time="刚刚", correct=False):
        name, location = clean(name, 40), clean(location)
        event_time = clean(event_time, 80)
        old = self.get(name)
        if correct and not old:
            raise ValueError("没有可以更正的记录。")
        with self.db() as db:
            db.execute("INSERT INTO observations(name,location,event_time,recorded_at,source,state,correction_of) VALUES(?,?,?,?,?,?,?)",
                       (name, location, old["event_time"] if correct else event_time,
                        now(), "MANUAL", "HISTORICAL", old["id"] if correct else None))
        return self.get(name)

    def delete(self, name):
        with self.db() as db:
            db.execute("DELETE FROM observations WHERE name=?", (name,))

    def answer(self, name):
        item = self.get(name)
        if not item:
            return f"没有找到{name}的位置记录。"
        timestamp = item["recorded_at"].replace("T", " ")[:16]
        return f"你在{timestamp}提供的记录：{name}在{item['location']}，物品放置时间为“{item['event_time']}”。还没有确认现在的位置。"


class Dialogue:
    def __init__(self, store):
        self.store = store
        self.last_name = ""
        self.pending = None

    def prepare(self, action, name, location="", event_time="刚刚"):
        if action not in {"record", "move", "correct", "delete"}:
            raise ValueError("不支持这个操作。")
        name = clean(name, 40)
        if action != "delete":
            location = clean(location)
        if action == "correct" and not self.store.get(name):
            raise ValueError("没有可以更正的记录。")
        self.last_name = name
        self.pending = dict(token=secrets.token_urlsafe(18), action=action,
                            name=name, location=location, event_time=clean(event_time, 80),
                            base_id=(self.store.get(name) or {}).get("id"),
                            expires=time.monotonic() + 300)
        verb = {"record": "记录", "move": "记录新位置", "correct": "更正原记录", "delete": "删除全部记录"}[action]
        return f"请确认：{verb}，{name}" + (f"，位置为{location}。" if location else "。")

    def public_pending(self):
        if self.pending and self.pending["expires"] < time.monotonic():
            self.pending = None
        return {k: v for k, v in self.pending.items() if k != "expires"} if self.pending else None

    def confirm(self, token):
        p = self.public_pending()
        if not p or not secrets.compare_digest(p["token"], str(token)):
            raise ValueError("这个确认已失效，请重新发起操作。")
        if p["action"] == "ambiguous":
            raise ValueError("请先说明是移动物品还是更正原记录。")
        if p["action"] in {"correct", "delete"} and (self.store.get(p["name"]) or {}).get("id") != p["base_id"]:
            self.pending = None
            raise ValueError("这件物品的记录已变化，请重新发起操作。")
        self.pending = None
        if p["action"] == "delete":
            self.store.delete(p["name"])
            return f"已删除{p['name']}的全部位置记录。"
        self.store.record(p["name"], p["location"], p["event_time"], p["action"] == "correct")
        return f"已{'更正' if p['action']=='correct' else '记录'}：{p['name']}在{p['location']}。这是你提供的信息，未经过当前视觉确认。"

    def command(self, text):
        text = clean(text, 400)
        p = self.public_pending()
        if text in {"取消", "算了", "停止"}:
            self.pending = None
            return "已取消待确认操作。"
        if text in {"确认", "是的", "确定"}:
            if not p:
                return "目前没有待确认的操作。"
            return self.confirm(p["token"])
        if text in {"有哪些记录", "列出记录", "我的物品"}:
            items = self.store.all()
            return "；".join(f"{r['name']}：{r['location']}（用户历史记录）" for r in items) or "还没有物品记录。"
        if text in {"什么时候记录的", "什么时候", "什么时候看到的", "是什么时候记录的"}:
            r = self.store.get(self.last_name)
            return (f"这是一条用户提供的记录，最近记录时间为{r['recorded_at'].replace('T',' ')[:16]}，物品放置时间为“{r['event_time']}”。不是摄像头观察。" if r else "请先告诉我你要查询哪个物品。")
        if text in {"刚才记错了", "记错了"} and p and p["action"] == "ambiguous":
            return self.prepare("correct", p["name"], p["location"])
        if text in {"现在移过去了", "现在移了", "现在移动了"} and p and p["action"] == "ambiguous":
            return self.prepare("move", p["name"], p["location"])
        match = re.fullmatch(r"(?:改成|更正为|改为)(.+)", text)
        if match and self.last_name:
            self.pending = dict(token=secrets.token_urlsafe(18), action="ambiguous", name=self.last_name,
                                location=clean(match[1]), event_time="刚刚", expires=time.monotonic()+300)
            return f"你是说{self.last_name}现在移到{match[1]}，还是刚才的位置记错了？请说“现在移过去了”或“刚才记错了”。"
        match = re.fullmatch(r"(?:删除|清除)(.+?)(?:的全部位置记录|的全部记录|的位置记录|的记录|记录)?", text)
        if match:
            return self.prepare("delete", match[1])
        match = re.fullmatch(r"(.+?)(?:在哪里|在哪儿|在哪)", text)
        if match:
            self.last_name = clean(match[1], 40)
            return self.store.answer(self.last_name)
        match = re.fullmatch(r"(?:记住|记录)[，,：: ]*(?:我)?(?:(刚刚|刚|今天|昨天|早上|昨晚))?(?:把)?(.+?)(?:(刚刚|刚|今天|昨天|早上|昨晚))?(?:放在|放到了|在)(.+)", text)
        if match:
            before, name, after, location = match.groups()
            event_time = before or after
            self.pending = None
            self.last_name = clean(name, 40)
            self.store.record(self.last_name, location, event_time or "时间未说明")
            return f"已记录：{self.last_name}在{clean(location)}。这是你提供的信息，还没有确认现在的位置。"
        return "本地指令示例：记住，钥匙刚放在玄关桌上；钥匙在哪；什么时候记录的；改成书桌上；删除钥匙的记录。自由对话需要连接千问。"
