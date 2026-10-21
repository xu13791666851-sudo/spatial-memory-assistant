"""Transactional, browser-isolated appearance memories; no public image paths."""
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def normalize(name):
    return re.sub(r'^(这个|那个|一个|一只|我的)', '', name.strip()).lower()


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript('''PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, normalized TEXT NOT NULL, appearance TEXT NOT NULL, location TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(owner,normalized));
        CREATE TABLE IF NOT EXISTS samples(object_id TEXT NOT NULL, sample_index INTEGER NOT NULL, jpeg BLOB NOT NULL, embedding TEXT NOT NULL, PRIMARY KEY(object_id,sample_index));''')

    def all(self, owner):
        with self.lock:
            rows = self.db.execute('SELECT o.*, (SELECT COUNT(*) FROM samples s WHERE s.object_id=o.id) AS sample_count FROM objects o WHERE owner=? ORDER BY recorded_at DESC', (owner,)).fetchall()
            return [dict(id=r['id'], name=r['name'], appearance=r['appearance'], location=r['location'], recorded_at=r['recorded_at'], sample_count=r['sample_count'], aliases=[], relations=[]) for r in rows]

    def references(self, owner, ident):
        with self.lock:
            rows = self.db.execute('SELECT s.jpeg,s.embedding FROM samples s JOIN objects o ON o.id=s.object_id WHERE o.owner=? AND o.id=? ORDER BY sample_index', (owner, ident)).fetchall()
            return [dict(jpeg=bytes(r['jpeg']), embedding=json.loads(r['embedding'])) for r in rows]

    def save(self, owner, name, samples, appearance='', location='已记住外观，尚未记录位置'):
        if not 1 <= len(name) <= 40 or len(samples) != 3:
            raise ValueError('需要有效的物品名和三个实际采集的样本。')
        with self.lock, self.db:
            previous = self.db.execute('SELECT id FROM objects WHERE owner=? AND normalized=?', (owner, normalize(name))).fetchone()
            ident = previous['id'] if previous else uuid.uuid4().hex
            self.db.execute('DELETE FROM samples WHERE object_id=?', (ident,))
            self.db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?,?,?)', (ident, owner, name, normalize(name), appearance, location, now()))
            self.db.executemany('INSERT INTO samples VALUES(?,?,?,?)', [(ident, i, s['jpeg'], json.dumps(s['embedding'])) for i, s in enumerate(samples)])
            return ident

    def edit(self, owner, params, delete=False):
        with self.lock, self.db:
            item = self.db.execute('SELECT * FROM objects WHERE owner=? AND id=?', (owner, params.get('id', ''))).fetchone()
            if item is None or item['recorded_at'] != params.get('recorded_at'):
                raise ValueError('这条记录已经变化，请重新打开后核对。')
            if delete:
                self.db.execute('DELETE FROM samples WHERE object_id=?', (item['id'],))
                self.db.execute('DELETE FROM objects WHERE owner=? AND id=?', (owner, item['id']))
                return
            name, appearance, location = (str(params.get(k, '')).strip() for k in ['name', 'appearance', 'location'])
            if not (1 <= len(name) <= 40 and len(appearance) <= 150 and 1 <= len(location) <= 600):
                raise ValueError('请填写物品名称和位置，外观描述不超过150字。')
            collision = self.db.execute('SELECT id FROM objects WHERE owner=? AND normalized=?', (owner, normalize(name))).fetchone()
            if collision and collision['id'] != item['id']:
                raise ValueError('已有同名物品，请换一个名称。')
            self.db.execute('UPDATE objects SET name=?,normalized=?,appearance=?,location=?,recorded_at=? WHERE owner=? AND id=?', (name, normalize(name), appearance, location, now(), owner, item['id']))
