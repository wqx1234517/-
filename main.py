import secrets

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import db_helper

app = FastAPI()
db_helper.init_db()


# 健康检查：确认后端还活着
@app.get("/api/hello")
def hello():
    return {"msg": "后端活了"}


class NewRoom(BaseModel):
    name: str


class JoinInfo(BaseModel):
    code: str


class LoginInfo(BaseModel):
    username: str
    password: str
    avatar: str = ""


# 令牌存在内存里：规模小、够用，代价是服务器重启后所有人要重新登录
token_users = {}


def new_token(username):
    token = secrets.token_urlsafe(24)
    token_users[token] = username
    return token


def user_of(token):
    return token_users.get(token or "")


@app.post("/api/register")
def register(info: LoginInfo):
    name = info.username.strip()
    pwd = info.password.strip()

    if not name or not pwd:
        raise HTTPException(status_code=400, detail="用户名和密码都不能为空")
    if len(pwd) < 4:
        raise HTTPException(status_code=400, detail="密码至少 4 位")

    try:
        user = db_helper.create_user(name, pwd, info.avatar or "🐱")
    except Exception:
        raise HTTPException(status_code=400, detail="这个用户名已经有人用了")

    return {"token": new_token(name), "username": user["username"], "avatar": user["avatar"]}


@app.post("/api/login")
def login(info: LoginInfo):
    user = db_helper.check_login(info.username.strip(), info.password.strip())
    if user is None:
        # 用户名不存在和密码错误返回同一句话，避免被拿来试出哪些用户名存在
        raise HTTPException(status_code=400, detail="用户名或密码不对")

    return {"token": new_token(user["username"]), "username": user["username"], "avatar": user["avatar"]}


# 房间 id -> 房间里所有人的连接，决定一条消息该转发给谁
room_conns = {}


@app.get("/api/rooms")
def get_rooms(token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return db_helper.list_rooms_of(username)


@app.post("/api/rooms")
def add_room(room: NewRoom, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    return db_helper.create_room(room.name, username)


@app.post("/api/join")
def join_room(info: JoinInfo, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    room = db_helper.get_room_by_code(info.code)
    if room is None:
        raise HTTPException(status_code=404, detail="邀请码不对，或者房间已经不存在了")

    db_helper.add_member(username, room["id"])
    return room


@app.get("/api/rooms/{room_id}/messages")
def get_room_messages(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    # 不是成员不给看，公开群除外（允许先看看再决定加不加入）
    if not db_helper.can_read(room_id, username):
        raise HTTPException(status_code=403, detail="你还不是这个房间的成员，先加入吧")

    return db_helper.get_messages(room_id)


async def broadcast(room_id, data, skip=None):
    # list() 复制一份再遍历：有人中途退出时原列表会变，直接遍历会出错
    for conn in list(room_conns.get(room_id, [])):
        if conn is skip:
            continue
        try:
            await conn.send_json(data)
        except Exception:
            pass   # 一个人掉线不能影响其他人


# 通知专线：登录后一直连着，用来告诉用户"你没在看的房间来了几条新消息"
notify_conns = {}


def add_notify_conn(username, ws):
    notify_conns.setdefault(username, []).append(ws)


def remove_notify_conn(username, ws):
    conns = notify_conns.get(username, [])
    if ws in conns:
        conns.remove(ws)
    if not conns and username in notify_conns:
        del notify_conns[username]


async def push_unread(room_id, sender_name):
    for name in db_helper.get_member_names(room_id):
        if name == sender_name:
            continue

        conns = notify_conns.get(name, [])
        if not conns:
            continue

        data = {
            "type": "unread",
            "room_id": room_id,
            "unread": db_helper.count_unread(name, room_id),
        }
        for conn in list(conns):
            try:
                await conn.send_json(data)
            except Exception:
                pass


async def send_online_count(room_id):
    await broadcast(room_id, {
        "type": "online",
        "count": len(room_conns.get(room_id, [])),
    })


@app.get("/api/hall/rooms")
def hall_rooms(token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    rooms = db_helper.list_public_rooms()

    # 保底：数据库被清过就现场重建，不必重启服务器
    if not rooms:
        db_helper.ensure_public_groups()
        rooms = db_helper.list_public_rooms()

    return rooms


@app.post("/api/rooms/{room_id}/join")
def join_public_room(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    room = db_helper.get_room_by_id(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="这个房间不存在")

    if not (room["is_public"] or 0):
        raise HTTPException(status_code=403, detail="这是私密群，需要邀请码才能进")

    db_helper.add_member(username, room_id)
    return room


@app.post("/api/rooms/{room_id}/leave")
def leave_room_api(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    if not db_helper.leave_room(room_id, username):
        raise HTTPException(status_code=403, detail="房主不能退群，要撤掉整个房间请用「解散」")

    return {"ok": True}


@app.post("/api/rooms/{room_id}/dismiss")
async def dismiss_room(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    ok = db_helper.delete_room(room_id, username)
    if not ok:
        raise HTTPException(status_code=403, detail="只有建这个房间的人才能解散它")

    await broadcast(room_id, {"type": "dismissed", "room_id": room_id})
    return {"ok": True}


@app.websocket("/ws/notify")
async def websocket_notify(websocket: WebSocket, token: str = ""):
    username = user_of(token)
    if username is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    add_notify_conn(username, websocket)

    try:
        # 这条线只由服务器单向推送，这里只是保持连接不中断
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        remove_notify_conn(username, websocket)


@app.websocket("/ws/{room_id}")
async def websocket_chat(websocket: WebSocket, room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        await websocket.close(code=1008)
        return

    # 进门资格：成员，或者公开群。防止有人拿到房间号硬闯私密群
    if not db_helper.can_read(room_id, username):
        await websocket.close(code=1008)
        return

    # 身份信息一律从数据库取，不信前端传的，防止冒名
    db_user = db_helper.get_user_by_name(username)
    avatar = db_user["avatar"] if db_user else ""

    await websocket.accept()
    room_conns.setdefault(room_id, []).append(websocket)
    await send_online_count(room_id)

    # 刚进来先补发一次读进度，否则要等下一个人读了消息才有数据，
    # 右键查"谁已读"时是空的
    await websocket.send_json({
        "type": "read",
        "reads": db_helper.get_read_states(room_id),
    })

    try:
        while True:
            data = await websocket.receive_json()
            kind = data.get("type", "message")

            if kind == "recall":
                # 双重校验：是本人发的，且确实在这个房间
                target = db_helper.get_message_by_id(data.get("id"))
                if target and target["sender_name"] == username and target["room_id"] == room_id:
                    db_helper.mark_recalled(target["id"])
                    await broadcast(room_id, {"type": "recall", "id": target["id"]})

            elif kind == "read":
                db_helper.set_last_read(username, room_id, data.get("last_id", 0))
                await broadcast(room_id, {
                    "type": "read",
                    "reads": db_helper.get_read_states(room_id),
                })

            elif kind == "typing":
                # 临时提示，不存库，也不发回给本人
                await broadcast(room_id, {
                    "type": "typing",
                    "sender_name": username,
                    "avatar": avatar,
                }, skip=websocket)

            elif kind == "poke":
                # 拍一拍不落库，纯转发。mid 让所有人锁定同一个头像，
                # 要校验它属于本房间，防止传别的房间的编号过来
                target = str(data.get("target", "")).strip()
                if target and target != username:
                    mid = data.get("mid") or 0
                    m_info = db_helper.get_message_by_id(mid) if mid else None
                    if not (m_info and m_info["room_id"] == room_id):
                        mid = 0

                    await broadcast(room_id, {
                        "type": "poke",
                        "from": username,
                        "avatar": avatar,
                        "target": target,
                        "mid": mid,
                    })

            elif kind == "message":
                # 公开群里"只看不加入"的人不能发言
                if not db_helper.is_member(username, room_id):
                    await websocket.send_json({
                        "type": "notice",
                        "text": "先点「加入本群」才能发言",
                    })
                    continue

                quote_id = data.get("quote_id") or 0
                qmsg = db_helper.get_message_by_id(quote_id) if quote_id else None
                if not (qmsg and qmsg["room_id"] == room_id):
                    quote_id = 0

                # 先存库再转发：刷新、断线重连都能找回
                msg = db_helper.save_message(room_id, username, data["content"], avatar, quote_id)
                msg["type"] = "message"
                await broadcast(room_id, msg)

                await push_unread(room_id, username)
    except WebSocketDisconnect:
        pass
    finally:
        # 不管怎么断都要清理，否则名单里会留下永远发不出去的死连接
        conns = room_conns.get(room_id, [])
        if websocket in conns:
            conns.remove(websocket)

        await send_online_count(room_id)

        if not conns and room_id in room_conns:
            del room_conns[room_id]


# 必须放最后：接口是从上往下匹配的，先挂静态目录的话，
# 所有请求都会被当成"找文件"，接口永远走不到
app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=True)
