import hashlib
import hmac
import secrets
import sqlite3
import string
from datetime import datetime

import config


def now_str():
    # 取当前时间，转成 "2026-10-02 16:50:01" 这种字符串。
    # 为什么不用数据库自带的 CURRENT_TIMESTAMP？
    # 因为它存的是 UTC 时间，比北京时间晚 8 小时，直接存显示出来是错的。
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_conn():
    # 每次要用数据库就新开一条连接，用完马上关。
    # 为什么不一直开着一条？因为 FastAPI 会同时处理多个人的请求，
    # 一条连接被好几个人共用容易出问题，随用随开最省心。
    return sqlite3.connect(config.DB_PATH)


def init_db():
    # 建表。IF NOT EXISTS 的意思是"表已经存在就别建了"，
    # 所以这个函数可以放心重复执行，不会报错也不会覆盖已有数据
    conn = get_conn()

    # 房间表：一个房间就是一次会话，两个人进同一个房间就能聊天。
    # invite_code 是邀请码，别人拿到它就能进这个房间
    conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            invite_code TEXT DEFAULT '',
            created_by TEXT DEFAULT ''
        )
    """)

    # 成员表：记下"谁加入过哪个房间"。
    # 有了它，房间列表才能只显示你自己加入过的房间，
    # 别人没被邀请就看不到你的房间
    conn.execute("""
        CREATE TABLE IF NOT EXISTS room_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            room_id INTEGER NOT NULL,
            joined_at TEXT NOT NULL,
            UNIQUE(username, room_id)
        )
    """)

    # 又是兼容老数据库：以前建的 room_members 表没有 last_read_id 这一列
    # （last_read_id 记的是"这个人读到这个房间的第几条消息了"）
    mem_cols = [row[1] for row in conn.execute("PRAGMA table_info(room_members)")]
    if "last_read_id" not in mem_cols:
        conn.execute("ALTER TABLE room_members ADD COLUMN last_read_id INTEGER DEFAULT 0")

    # 又是兼容老数据库：以前建的 rooms 表没有 invite_code 这一列
    room_cols = [row[1] for row in conn.execute("PRAGMA table_info(rooms)")]
    if "invite_code" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN invite_code TEXT DEFAULT ''")

    # 老房间和刚加上这一列的房间，邀请码是空的，这里给它们补一个
    empty_rows = conn.execute(
        "SELECT id FROM rooms WHERE invite_code IS NULL OR invite_code = ''"
    ).fetchall()
    for row in empty_rows:
        conn.execute("UPDATE rooms SET invite_code = ? WHERE id = ?", (new_invite_code(), row[0]))

    # 同样是兼容老数据库：以前建的 rooms 表没有 created_by（谁建的这个房间）
    if "created_by" not in room_cols:
        conn.execute("ALTER TABLE rooms ADD COLUMN created_by TEXT DEFAULT ''")

    # 老房间已经不知道是谁建的了，就把"最早加入的那个人"当成创建者，
    # 这样老房间也能正常解散，不会出现谁都管不了的情况
    conn.execute("""
        UPDATE rooms SET created_by = (
            SELECT username FROM room_members
            WHERE room_id = rooms.id ORDER BY id LIMIT 1
        )
        WHERE created_by IS NULL OR created_by = ''
    """)

    # 消息表：每一条发言存一行。
    # room_id 用来标明这条消息属于哪个房间，这就是两张表的关系
    # avatar 存的是这个人的头像（一个表情符号）
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

    # 兼容老数据库：以前建的 messages 表没有 avatar 这一列，
    # 这里查一下列名，缺了就补上，这样不用删掉数据库重来（之前的消息也不会丢）
    cols = [row[1] for row in conn.execute("PRAGMA table_info(messages)")]
    if "avatar" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN avatar TEXT DEFAULT ''")

    # 同上：recalled 是"这条消息有没有被撤回"，0=正常，1=已撤回
    if "recalled" not in cols:
        conn.execute("ALTER TABLE messages ADD COLUMN recalled INTEGER DEFAULT 0")

    # 用户表：存账号。注意这里存的是"加密后的密码"，不是密码本身
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

    conn.commit()  # 建表也要提交，否则不会真正保存
    conn.close()


# ---------- 账号相关 ----------

def make_password_hash(password, salt=None):
    # 把密码加密成一段看起来毫无规律的字符。
    # salt 是"盐"：同样的密码加上不同的盐，算出来的结果就不一样，
    # 这样别人就算拿到了数据库，也没法用对照表反推出原始密码。
    # 没传盐就现生成一个（注册时用）
    if salt is None:
        salt = secrets.token_hex(16)

    # pbkdf2 是 Python 自带的加密函数，重复算 10 万次，
    # 目的是让"猜密码"变得很慢，暴力破解就不划算了
    hash_bytes = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000
    )
    return salt, hash_bytes.hex()


def check_password(password, salt, correct_hash):
    # 登录时校验：用用户注册时的盐，把这次输入的密码再算一遍，
    # 算出来跟数据库里存的一样，说明密码对了
    _, try_hash = make_password_hash(password, salt)
    # compare_digest 比直接用 == 更安全：它不会因为"前面几位就不同"而提前返回，
    # 避免被别人用响应时间猜出密码
    return hmac.compare_digest(try_hash, correct_hash)


def create_user(username, password, avatar=""):
    # 注册。用户名重复会抛异常，让调用方知道注册失败
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
    # 按用户名查一个人，查不到返回 None
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
    # 生成一个 6 位的邀请码，比如 "K3M9QP"。
    # 用 secrets 而不是 random，是因为 random 生成的数有规律可循，
    # 别人有可能猜到下一个码；secrets 是专门用来生成"猜不出来"的随机串的
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(6))


def check_login(username, password):
    # 登录：先查出这个人，再比对密码。
    # 用户名不存在或密码不对，都返回 None（不告诉对方具体是哪错了，更安全）
    user = get_user_by_name(username)
    if user is None:
        return None
    if not check_password(password, user["salt"], user["password_hash"]):
        return None

    # 密码这些敏感信息不往外传，只给需要展示的字段
    return {"id": user["id"], "username": user["username"], "avatar": user["avatar"]}


def add_member(username, room_id):
    # 记下"这个人加入过这个房间"。
    # INSERT OR IGNORE 的意思是：如果已经记过（用户名+房间这个组合重复了），
    # 就当作没事发生，不会报错也不会重复插一条
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO room_members (username, room_id, joined_at) VALUES (?, ?, ?)",
        (username, room_id, now_str()),
    )
    conn.commit()
    conn.close()


def count_unread(username, room_id):
    # 这个房间里，这个人还有几条没看（自己发的不算未读）
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
    # 这个房间里都有哪些人（用来决定"新消息要通知谁"）
    conn = get_conn()
    rows = conn.execute(
        "SELECT username FROM room_members WHERE room_id = ?", (room_id,)
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def is_member(username, room_id):
    # 这个人是不是这个房间的成员？不是就不让他看消息、不让他连进来
    conn = get_conn()
    row = conn.execute(
        "SELECT 1 FROM room_members WHERE username = ? AND room_id = ?",
        (username, room_id),
    ).fetchone()
    conn.close()
    return row is not None


def list_rooms_of(username):
    # 只查这个人加入过的房间。
    # JOIN 的作用是"把两张表按房间 id 对上"：先找到他加入过的房间 id，
    # 再去房间表里把这些房间的名字、邀请码取出来
    #
    # 最后那个括号里的小查询是在数"未读消息有几条"：
    # 在这个房间里、消息 id 比"我读到的位置"更新、而且不是我自己发的，就算一条未读
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
        "created_by": r[4] or "",   # 谁建的，前端靠它决定"解散"按钮显不显示
        "unread": r[5] or 0,        # 有几条没看，列表上要显示红点
    } for r in rows]


def get_room_by_code(code):
    # 按邀请码查房间，别人拿到码以后就是用它进来的
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


def create_room(name, creator=""):
    # 允许建同名房间：每次点"新建"都是一个全新的房间，配一个新的邀请码。
    # 这样几个人都建"测试房间"也不会互相撞车，各自靠邀请码区分。
    # （房间名不再是唯一标识，邀请码才是）

    # 建房间的时候顺便生成一个邀请码，别人拿这个码就能进来
    code = new_invite_code()
    # 万一跟已有的码撞了就再换一个（概率极低，但检查一下更稳妥）
    while get_room_by_code(code) is not None:
        code = new_invite_code()

    t = now_str()
    conn = get_conn()

    # 用 ? 占位符传参数，千万不要自己用 + 号拼字符串：
    # 第一是安全（能挡住 SQL 注入），第二是名字里带引号时不会把语句搞坏
    cur = conn.execute(
        "INSERT INTO rooms (name, created_at, invite_code, created_by) VALUES (?, ?, ?, ?)",
        (name, t, code, creator),
    )
    conn.commit()
    new_id = cur.lastrowid  # 拿到数据库自动生成的 id
    conn.close()

    # 建房间的人自己当然算成员
    if creator:
        add_member(creator, new_id)

    return {
        "id": new_id,
        "name": name,
        "created_at": t,
        "invite_code": code,
        "created_by": creator,   # 记下是谁建的，以后只有他能解散
    }


def leave_room(room_id, username):
    # 退出房间（退群）。跟解散不一样：房间还在，别人照样能聊，
    # 只是你自己不在成员名单里了，以后想回来得再用一次邀请码
    conn = get_conn()
    row = conn.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()

    if row is None:
        conn.close()
        return False   # 房间都不存在了

    if (row[0] or "") == username:
        conn.close()
        return False   # 房主不能退群，他要么解散房间，要么留着

    cur = conn.execute(
        "DELETE FROM room_members WHERE room_id = ? AND username = ?",
        (room_id, username),
    )
    conn.commit()
    ok = cur.rowcount > 0   # 大于 0 才说明真的退掉了
    conn.close()
    return ok


def delete_room(room_id, username):
    # 解散房间。只有建它的人才能操作，所以要先把创建者查出来对一下
    conn = get_conn()
    row = conn.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()

    if row is None:
        conn.close()
        return False   # 房间不存在

    if (row[0] or "") != username:
        conn.close()
        return False   # 不是你建的，不给解散

    # 房间没了，它下面的消息和成员记录也没意义了，一起清掉，
    # 不然会留下一堆孤儿数据占地方
    conn.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
    conn.execute("DELETE FROM room_members WHERE room_id = ?", (room_id,))
    conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    conn.commit()
    conn.close()
    return True


def save_message(room_id, sender_name, content, avatar=""):
    # 存一条消息。存完把整条消息返回去，方便直接转发给其他人
    # avatar 默认空字符串：老消息、或者没选头像的人就不会出错
    t = now_str()
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO messages (room_id, sender_name, content, created_at, avatar) VALUES (?, ?, ?, ?, ?)",
        (room_id, sender_name, content, t, avatar),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()

    return {
        "id": new_id,
        "room_id": room_id,
        "sender_name": sender_name,
        "content": content,
        "created_at": t,
        "avatar": avatar,
        "recalled": 0,   # 刚发的消息当然是没撤回的
    }


def get_message_by_id(message_id):
    # 按 id 查一条消息，主要是为了知道"它属于哪个房间、是谁发的"
    conn = get_conn()
    row = conn.execute(
        "SELECT id, room_id, sender_name FROM messages WHERE id = ?", (message_id,)
    ).fetchone()
    conn.close()

    if row is None:
        return None
    return {"id": row[0], "room_id": row[1], "sender_name": row[2]}


def mark_recalled(message_id):
    # 把这条消息标成"已撤回"。
    # 注意不是真的删掉：删了的话别人刷新就少一条，对不上号；
    # 标个记号，大家看到的就是"XX 撤回了一条消息"
    conn = get_conn()
    cur = conn.execute("UPDATE messages SET recalled = 1 WHERE id = ?", (message_id,))
    conn.commit()
    ok = cur.rowcount > 0   # 影响的行数大于 0 才说明真改了
    conn.close()
    return ok


def set_last_read(username, room_id, last_id):
    # 记下"这个人在这个房间读到了第几条消息"。已读未读就靠它判断
    conn = get_conn()
    conn.execute(
        "UPDATE room_members SET last_read_id = ? WHERE username = ? AND room_id = ?",
        (last_id, username, room_id),
    )
    conn.commit()
    conn.close()


def get_read_states(room_id):
    # 这个房间里每个人读到哪儿了，返回一个"用户名 -> 读到的消息 id"的对照表
    conn = get_conn()
    rows = conn.execute(
        "SELECT username, last_read_id FROM room_members WHERE room_id = ?", (room_id,)
    ).fetchall()
    conn.close()

    return {r[0]: (r[1] or 0) for r in rows}


def get_messages(room_id, limit=200):
    # 取某个房间的历史消息。
    # DESC 是从最新往回取，只取 limit 条，避免消息太多一次拉爆页面
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, sender_name, content, created_at, avatar, recalled FROM messages "
        "WHERE room_id = ? ORDER BY id DESC LIMIT ?",
        (room_id, limit),
    ).fetchall()
    conn.close()

    # 上面取出来是倒着的，reverse() 翻回正常顺序：从旧到新
    rows.reverse()

    # r[4] 是头像，老消息可能是 None（没有头像），转成空字符串，前端好判断
    return [{
        "id": r[0],
        "sender_name": r[1],
        "content": r[2],
        "created_at": r[3],
        "avatar": r[4] or "",
        "recalled": r[5] or 0,
    } for r in rows]
