import hashlib
import hmac
import secrets
import sqlite3
import string
from datetime import datetime

import config


# 公开大厅的分类群：不用邀请码，谁都能点进去看，想说话再点加入
PUBLIC_GROUPS = ["游戏群", "八卦群", "二次元群", "运动群", "学习群", "音乐群"]


def now_str():
    # 不用数据库的 CURRENT_TIMESTAMP：它存的是 UTC 时间，比北京时间晚 8 小时
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_conn():
    # 随用随开、用完就关：FastAPI 会并发处理请求，共用一条连接容易出问题
    return sqlite3.connect(config.DB_PATH)


def init_db():
    conn = get_conn()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            invite_code TEXT DEFAULT '',
            created_by TEXT DEFAULT '',
            is_public INTEGER DEFAULT 0
        )
    """)

    # 成员表是"房间私有"的关键：房间列表只返回在这张表里有记录的房间
    conn.execute("""
        CREATE TABLE IF NOT EXISTS room_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            room_id INTEGER NOT NULL,
            joined_at TEXT NOT NULL,
            UNIQUE(username, room_id)
        )
    """)

    # 下面几段是渐进式迁移：先查表里有没有这一列，缺了才补。
    # 这样升级不用删数据库，旧的聊天记录也还在
    mem_cols = [row[1] for row in conn.execute("PRAGMA table_info(room_members)")]
    if "last_read_id" not in mem_cols:
        conn.execute("ALTER TABLE room_members ADD COLUMN last_read_id INTEGER DEFAULT 0")

    room_cols = [row[1] for row in conn.execute("PRAGMA table_info(rooms)")]
    if "invite_code" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN invite_code TEXT DEFAULT ''")

    empty_rows = conn.execute(
        "SELECT id FROM rooms WHERE invite_code IS NULL OR invite_code = ''"
    ).fetchall()
    for row in empty_rows:
        conn.execute("UPDATE rooms SET invite_code = ? WHERE id = ?", (new_invite_code(), row[0]))

    if "created_by" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN created_by TEXT DEFAULT ''")

    if "is_public" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN is_public INTEGER DEFAULT 0")

    # 老房间查不出创建者，就把最早加入的人当房主，免得谁都管不了它
    conn.execute("""
        UPDATE rooms SET created_by = (
            SELECT username FROM room_members
            WHERE room_id = rooms.id ORDER BY id LIMIT 1
        )
        WHERE created_by IS NULL OR created_by = ''
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            avatar TEXT DEFAULT ''
        )
    """)

    cols = [row[1] for row in conn.execute("PRAGMA table_info(messages)")]
    if "avatar" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN avatar TEXT DEFAULT ''")
    if "recalled" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0")
    # 引用只存编号不存内容：被引用的消息撤回后这边能跟着变，也不用存两份
    if "quote_id" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN quote_id INTEGER DEFAULT 0")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            avatar TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()

    ensure_public_groups()


def make_password_hash(password, salt=None):
    # 加盐：同样的密码配上不同的盐结果不同，拿到数据库也反推不出原密码
    if salt is None:
        salt = secrets.token_hex(16)

    # pbkdf2 重复算 10 万次，让暴力破解变得不划算
    hash_bytes = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000
    )
    return salt, hash_bytes.hex()


def check_password(password, salt, correct_hash):
    _, try_hash = make_password_hash(password, salt)
    # compare_digest 不会因为前几位不同就提前返回，避免被用响应时间猜密码
    return hmac.compare_digest(try_hash, correct_hash)


def create_user(username, password, avatar=""):
    salt, pw_hash = make_password_hash(password)
    t = now_str()
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, salt, avatar, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (username, pw_hash, salt, avatar, t),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id, "username": username, "avatar": avatar, "created_at": t}


def get_user_by_name(username):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, username, password_hash, salt, avatar, created_at FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()

    if row is None:
        return None
    return {
        "id": row[0],
        "username": row[1],
        "password_hash": row[2],
        "salt": row[3],
        "avatar": row[4],
        "created_at": row[5],
    }


def new_invite_code():
    # 用 secrets 而不是 random：random 有规律，别人可能猜到下一个码
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(6))


def check_login(username, password):
    user = get_user_by_name(username)
    if user is None:
        return None
    if not check_password(password, user["salt"], user["password_hash"]):
        return None

    return {"id": user["id"], "username": user["username"], "avatar": user["avatar"]}


def ensure_public_groups():
    # created_by 写"系统"，正好复用已有规则：
    # 房主不能退 → 房主是"系统"不是真人，所以谁都能退；
    # 只有房主能解散 → 谁都解散不了
    for name in PUBLIC_GROUPS:
        row = get_room_by_name(name)
        if row is None:
            create_room(name, "系统", is_public=1)
        elif not row.get("is_public"):
            conn = get_conn()
            conn.execute("UPDATE rooms SET is_public = 1 WHERE id = ?", (row["id"],))
            conn.commit()
            conn.close()


def get_room_by_name(name):
    return _one_room("SELECT id, name, created_at, invite_code, created_by, is_public "
                     "FROM rooms WHERE name = ?", (name,))


def get_room_by_id(room_id):
    return _one_room("SELECT id, name, created_at, invite_code, created_by, is_public "
                     "FROM rooms WHERE id = ?", (room_id,))


def _one_room(sql, args):
    conn = get_conn()
    row = conn.execute(sql, args).fetchone()
    conn.close()

    if row is None:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "created_at": row[2],
        "invite_code": row[3] or "",
        "created_by": row[4] or "",
        "is_public": row[5] or 0,
    }


def can_read(room_id, username):
    # 成员能看；公开群不是成员也能看（先看看再决定加不加入）
    if is_member(username, room_id):
        return True
    room = get_room_by_id(room_id)
    return bool(room and (room["is_public"] or 0))


def list_public_rooms():
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, created_at, invite_code, created_by, is_public FROM rooms ORDER BY id"
    ).fetchall()
    conn.close()

    out = []
    for r in rows:
        if not (r[5] or 0):
            continue
        out.append({
            "id": r[0],
            "name": r[1],
            "created_at": r[2],
            "invite_code": r[3] or "",
            "created_by": r[4] or "",
            "is_public": 1,
            "unread": 0,
        })

    # 按 PUBLIC_GROUPS 的顺序排，而不是数据库 id，页面格子顺序才固定
    order = {name: i for i, name in enumerate(PUBLIC_GROUPS)}
    out.sort(key=lambda r: order.get(r["name"], 999))
    return out


def add_member(username, room_id):
    # INSERT OR IGNORE：已经加入过就当没事发生，不报错也不重复插
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO room_members (username, room_id, joined_at) VALUES (?, ?, ?)",
        (username, room_id, now_str()),
    )
    conn.commit()
    conn.close()


def count_unread(username, room_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) FROM messages m "
        "JOIN room_members rm ON rm.room_id = m.room_id AND rm.username = ? "
        "WHERE m.room_id = ? "
        "  AND m.id > IFNULL(rm.last_read_id, 0) "
        "  AND m.sender_name <> ?",
        (username, room_id, username),
    ).fetchone()
    conn.close()
    return row[0] if row else 0


def get_member_names(room_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT username FROM room_members WHERE room_id = ?", (room_id,)
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def is_member(username, room_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM room_members WHERE username = ? AND room_id = ?",
        (username, room_id),
    ).fetchone()
    conn.close()
    return row is not None


def list_rooms_of(username):
    # 最后那个子查询在数未读：比"我读到的位置"新、且不是自己发的，算一条
    conn = get_conn()
    rows = conn.execute(
        "SELECT r.id, r.name, r.created_at, r.invite_code, r.created_by, "
        "  (SELECT COUNT(*) FROM messages m "
        "   WHERE m.room_id = r.id "
        "     AND m.id > IFNULL(rm.last_read_id, 0) "
        "     AND m.sender_name <> ?) "
        "FROM rooms r JOIN room_members rm ON r.id = rm.room_id "
        "WHERE rm.username = ? ORDER BY r.id",
        (username, username),
    ).fetchall()
    conn.close()

    return [{
        "id": r[0],
        "name": r[1],
        "created_at": r[2],
        "invite_code": r[3] or "",
        "created_by": r[4] or "",
        "unread": r[5] or 0,
        "is_public": 0,
    } for r in rows]


def get_room_by_code(code):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, name, created_at, invite_code, created_by FROM rooms WHERE invite_code = ?",
        (code.strip().upper(),),
    ).fetchone()
    conn.close()

    if row is None:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "created_at": row[2],
        "invite_code": row[3] or "",
        "created_by": row[4] or "",
    }


def create_room(name, creator="", is_public=0):
    # 允许同名：每次新建都是新房间 + 新邀请码，邀请码才是唯一标识
    code = new_invite_code()
    while get_room_by_code(code) is not None:
        code = new_invite_code()

    t = now_str()
    conn = get_conn()
    # 参数一律用 ? 占位符，不拼字符串：既挡 SQL 注入，名字带引号也不会搞坏语句
    cur = conn.execute(
        "INSERT INTO rooms (name, created_at, invite_code, created_by, is_public) "
        "VALUES (?, ?, ?, ?, ?)",
        (name, t, code, creator, is_public),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()

    if creator:
        add_member(creator, new_id)

    return {
        "id": new_id,
        "name": name,
        "created_at": t,
        "invite_code": code,
        "created_by": creator,
        "is_public": is_public,
    }


def leave_room(room_id, username):
    conn = get_conn()
    row = conn.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()

    if row is None:
        conn.close()
        return False

    if (row[0] or "") == username:
        conn.close()
        return False   # 房主不能退群，跟微信一样，要么解散要么留着

    cur = conn.execute(
        "DELETE FROM room_members WHERE room_id = ? AND username = ?",
        (room_id, username),
    )
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def delete_room(room_id, username):
    conn = get_conn()
    row = conn.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()

    if row is None:
        conn.close()
        return False

    if (row[0] or "") != username:
        conn.close()
        return False

    # 房间没了，它的消息和成员记录也一起清掉，不留孤儿数据
    conn.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
    conn.execute("DELETE FROM room_members WHERE room_id = ?", (room_id,))
    conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    conn.commit()
    conn.close()
    return True


def save_message(room_id, sender_name, content, avatar="", quote_id=0):
    t = now_str()
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO messages (room_id, sender_name, content, created_at, avatar, quote_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (room_id, sender_name, content, t, avatar, quote_id),
    )
    conn.commit()

    # 顺手把被引用的那条一起查出来返回，前端不用再发一次请求
    quote_name = quote_content = None
    quote_recalled = 0
    if quote_id:
        q = conn.execute(
            "SELECT sender_name, content, recalled FROM messages WHERE id = ? AND room_id = ?",
            (quote_id, room_id),
        ).fetchone()
        if q is None:
            quote_id = 0
        else:
            quote_name, quote_content, quote_recalled = q[0], q[1], (q[2] or 0)

    new_id = cur.lastrowid
    conn.close()

    return {
        "id": new_id,
        "room_id": room_id,
        "sender_name": sender_name,
        "content": content,
        "created_at": t,
        "avatar": avatar,
        "recalled": 0,
        "quote_id": quote_id,
        "quote_name": quote_name,
        "quote_content": quote_content,
        "quote_recalled": quote_recalled,
    }


def get_message_by_id(message_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT id, room_id, sender_name FROM messages WHERE id = ?", (message_id,)
    ).fetchone()
    conn.close()

    if row is None:
        return None
    return {"id": row[0], "room_id": row[1], "sender_name": row[2]}


def mark_recalled(message_id):
    # 只打标记不删数据：删了别人刷新会凭空少一条，序号对不上
    conn = get_conn()
    cur = conn.execute("UPDATE messages SET recalled = 1 WHERE id = ?", (message_id,))
    conn.commit()
    ok = cur.rowcount > 0
    conn.close()
    return ok


def set_last_read(username, room_id, last_id):
    conn = get_conn()
    conn.execute(
        "UPDATE room_members SET last_read_id = ? WHERE username = ? AND room_id = ?",
        (last_id, username, room_id),
    )
    conn.commit()
    conn.close()


def get_read_states(room_id):
    # 排除"系统"：公开群的房主是它，也被登记成了成员，但永远不会真的读消息
    conn = get_conn()
    rows = conn.execute(
        "SELECT username, last_read_id FROM room_members "
        "WHERE room_id = ? AND username <> ?",
        (room_id, "系统"),
    ).fetchall()
    conn.close()

    return {r[0]: (r[1] or 0) for r in rows}


def get_messages(room_id, limit=200):
    # 倒着取最新的 limit 条，避免消息太多一次拉爆页面
    # LEFT JOIN 把被引用的消息一起带出来，没引用（quote_id=0）的也不会漏
    conn = get_conn()
    rows = conn.execute(
        "SELECT m.id, m.sender_name, m.content, m.created_at, m.avatar, m.recalled, "
        "  m.quote_id, q.sender_name, q.content, q.recalled "
        "FROM messages m LEFT JOIN messages q ON q.id = m.quote_id "
        "WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?",
        (room_id, limit),
    ).fetchall()
    conn.close()

    rows.reverse()

    return [{
        "id": r[0],
        "sender_name": r[1],
        "content": r[2],
        "created_at": r[3],
        "avatar": r[4] or "",
        "recalled": r[5] or 0,
        "quote_id": r[6] or 0,
        "quote_name": r[7],
        "quote_content": r[8],
        "quote_recalled": (r[9] or 0) if r[6] else 0,
    } for r in rows]
