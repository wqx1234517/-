import secrets

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
import db_helper

# 创建一个网站应用。后面所有的接口都挂在这个 app 上
app = FastAPI()

# 网站一启动就把数据库表建好（表已经存在时不会重复建）
# 放在这里的意思是：只要这个文件被加载，就会执行一次
db_helper.init_db()


# 这一行叫"装饰器"，作用是把下面这个函数变成一个接口：
# 浏览器访问 /api/hello 时，就会执行这个函数，并把返回值发回给浏览器
@app.get("/api/hello")
def hello():
    # 直接返回字典，FastAPI 会自动把它转成 JSON（一种通用的数据格式）
    # 这个接口现在只有一个作用：证明后端是活的
    return {"msg": "后端活了"}


# 这一句定义"建房间时，浏览器要发过来的数据长什么样"：{"name": "房间名"}
# 写上它有两个好处：
# 1. FastAPI 会自动检查数据对不对，比如没传 name 会直接报错告诉你
# 2. /docs 那个调试页面上会自动生成填写示例
class NewRoom(BaseModel):
    name: str


# 用邀请码进房间时要传的东西
class JoinInfo(BaseModel):
    code: str


# 登录时要传的东西：用户名和密码
class LoginInfo(BaseModel):
    username: str
    password: str
    avatar: str = ""   # 注册时顺带把头像一起存了，登录时可以不传


# 登录成功的凭证（令牌）：随机生成的一串字符，登录后发给前端，
# 之后前端每次连 WebSocket 都要带上它，服务器凭它认人。
# 存在内存里，服务器一重启就全部失效，那时候重新登录就行。
# 不做成文件/数据库是因为这个项目的规模用不上，越简单越好。
token_users = {}


def new_token(username):
    # 生成一个没人猜得到的随机字符串当令牌
    token = secrets.token_urlsafe(24)
    token_users[token] = username
    return token


def user_of(token):
    # 凭令牌查出是谁。查不到就是令牌无效（没登录过，或者服务器重启过）
    return token_users.get(token or "")


# 接口：注册
@app.post("/api/register")
def register(info: LoginInfo):
    name = info.username.strip()
    pwd = info.password.strip()

    # 简单的校验：用户名密码都不能空
    if not name or not pwd:
        raise HTTPException(status_code=400, detail="用户名和密码都不能为空")
    if len(pwd) < 4:
        raise HTTPException(status_code=400, detail="密码至少 4 位")

    try:
        user = db_helper.create_user(name, pwd, info.avatar or "🐱")
    except Exception:
        # 用户名有 UNIQUE 约束，重名会插入失败，这里转成一句人话告诉前端
        raise HTTPException(status_code=400, detail="这个用户名已经有人用了")

    return {"token": new_token(name), "username": user["username"], "avatar": user["avatar"]}


# 接口：登录
@app.post("/api/login")
def login(info: LoginInfo):
    user = db_helper.check_login(info.username.strip(), info.password.strip())
    if user is None:
        # 用户名不存在和密码错误都返回同一句话，
        # 这样别人就没法通过报错信息去试出哪些用户名是存在的
        raise HTTPException(status_code=400, detail="用户名或密码不对")

    return {"token": new_token(user["username"]), "username": user["username"], "avatar": user["avatar"]}


# 在线名单：房间 id -> 这个房间里所有人的"电话线"
# 例如 {1: [连接A, 连接B]} 表示 1 号房间里有两个人在线。
# 为什么要记这个？因为有人发消息时，服务器要知道该转发给谁
room_conns = {}


# 接口 1：列出"我加入过的房间"。
# 注意不是所有房间 —— 别人没邀请你的房间，你看不到也进不去
@app.get("/api/rooms")
def get_rooms(token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return db_helper.list_rooms_of(username)


# 接口 2：建一个新房间。数据从请求体（body）里拿，也就是前端发来的那段 JSON
@app.post("/api/rooms")
def add_room(room: NewRoom, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    # 房间名已经存在时，这个函数会返回原来那个房间，不会重复建
    return db_helper.create_room(room.name, username)


# 接口 3：用邀请码进房间。别人把码发给你，你在这查它是哪个房间
@app.post("/api/join")
def join_room(info: JoinInfo, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    room = db_helper.get_room_by_code(info.code)
    if room is None:
        raise HTTPException(status_code=404, detail="邀请码不对，或者房间已经不存在了")

    # 用码进来之后，把这个人登记成成员，
    # 这样他以后打开首页也能直接看到这个房间，不用再输一次码
    db_helper.add_member(username, room["id"])
    return room


# 接口 4：取某个房间的历史消息。刷新页面就靠它把之前的聊天记录找回来
@app.get("/api/rooms/{room_id}/messages")
def get_room_messages(room_id: int, token: str = ""):
    # {room_id} 是路径里的一部分，写成 room_id: int 之后
    # FastAPI 会自动把它变成数字，前端传字母的话会自动报 422 错误
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    # 不是成员不给看 —— 但公开群例外，谁都能点进来看看
    if not db_helper.can_read(room_id, username):
        raise HTTPException(status_code=403, detail="你还不是这个房间的成员，先加入吧")

    return db_helper.get_messages(room_id)


async def broadcast(room_id, data, skip=None):
    # 把一条数据发给这个房间里的所有人。
    # skip = 某条连接时，就不发给它（比如"正在输入"没必要发回给本人）
    # 用 list() 复制一份再遍历，防止遍历过程中有人退出导致出错
    for conn in list(room_conns.get(room_id, [])):
        if conn is skip:
            continue
        try:
            await conn.send_json(data)
        except Exception:
            # 某个人已经断开了就跳过，不能因为一个人掉线影响其他人
            pass


# 通知专线：用户名 -> 他的连接列表。
# 跟 room_conns 不一样：room_conns 是"进了某个房间才连"，
# 这条线是登录后一直保持的，专门用来告诉用户"你没在看的那些房间来了几条新消息"
notify_conns = {}


def add_notify_conn(username, ws):
    notify_conns.setdefault(username, []).append(ws)


def remove_notify_conn(username, ws):
    conns = notify_conns.get(username, [])
    if ws in conns:
        conns.remove(ws)
    if not conns and username in notify_conns:
        del notify_conns[username]   # 没人连了就删掉，省点内存


async def push_unread(room_id, sender_name):
    # 有新消息时，给这个房间的其他成员各发一条"你有 N 条未读"。
    # 跳过发送者本人：自己发的消息不用提醒自己
    for name in db_helper.get_member_names(room_id):
        if name == sender_name:
            continue

        conns = notify_conns.get(name, [])
        if not conns:
            continue   # 这个人当前没连通知专线（比如没开页面），跳过

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
    # 告诉房间里所有人：现在一共有几个人在线
    await broadcast(room_id, {
        "type": "online",
        "count": len(room_conns.get(room_id, [])),
    })


# 接口 5：公开大厅的格子列表（游戏群、八卦群、二次元群……）
@app.get("/api/hall/rooms")
def hall_rooms(token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    rooms = db_helper.list_public_rooms()

    # 保底：万一数据库被清过、或者这几个群还没建出来，
    # 这里现场补建一次，免得必须重启服务器才能看到大厅
    if not rooms:
        db_helper.ensure_public_groups()
        rooms = db_helper.list_public_rooms()

    return rooms


# 接口 6：按房间号加入一个公开群（在大厅里点"加入"走这里）
@app.post("/api/rooms/{room_id}/join")
def join_public_room(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    room = db_helper.get_room_by_id(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="这个房间不存在")

    if not (room["is_public"] or 0):
        # 私密群不给直接加入，得用邀请码走 /api/join
        raise HTTPException(status_code=403, detail="这是私密群，需要邀请码才能进")

    db_helper.add_member(username, room_id)
    return room


# 接口 7：退群（自己退出这个房间）。
# 跟解散的区别：房间留着，别人还能继续聊，只是你不在了
@app.post("/api/rooms/{room_id}/leave")
def leave_room_api(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    if not db_helper.leave_room(room_id, username):
        # 退不掉基本就两种情况：你是房主，或者你本来就不在这个房间
        raise HTTPException(status_code=403, detail="房主不能退群，要撤掉整个房间请用「解散」")

    return {"ok": True}


# 接口 8：解散房间。只有建这个房间的人能操作
# 这里写成 async def（前面几个都是 def），是因为里面要 await 广播通知，
# 同步函数里没法直接 await
@app.post("/api/rooms/{room_id}/dismiss")
async def dismiss_room(room_id: int, token: str = ""):
    username = user_of(token)
    if username is None:
        raise HTTPException(status_code=401, detail="请先登录")

    ok = db_helper.delete_room(room_id, username)
    if not ok:
        raise HTTPException(status_code=403, detail="只有建这个房间的人才能解散它")

    # 通知房间里还在线的人：这房间没了，赶紧退出去
    await broadcast(room_id, {"type": "dismissed", "room_id": room_id})
    return {"ok": True}


# 通知专线：登录后一直连着，不针对某个房间。
# 作用是"你在房间外面时，也能实时知道哪个房间来了新消息、来了几条"
@app.websocket("/ws/notify")
async def websocket_notify(websocket: WebSocket, token: str = ""):
    username = user_of(token)
    if username is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    add_notify_conn(username, websocket)

    try:
        # 这条线只收不发的（服务器单方面通知），
        # 但得一直等着，等的时候连接才不会断
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        remove_notify_conn(username, websocket)


# 实时聊天用的接口。注意地址是 ws:// 开头（不是 http://），
# 浏览器访问 /ws/1 就会连上 1 号房间的"电话线"
@app.websocket("/ws/{room_id}")
async def websocket_chat(websocket: WebSocket, room_id: int, token: str = ""):
    # async 的意思是：这个函数会"等着"，等的时候不会卡住其他人
    # await 就是"等这一步做完"的意思
    #
    # token 从地址后面拿，前端连的时候写成 /ws/1?token=xxx

    # 进门先查令牌：没登录就不让进，直接把连接关掉
    username = user_of(token)
    if username is None:
        await websocket.close(code=1008)   # 1008 是"拒绝"的意思
        return

    # 进门资格：要么是成员，要么是公开群（公开群允许"先看看再决定加不加入"）。
    # 私密房间不是成员就拦掉，防止有人拿到房间号硬闯
    if not db_helper.can_read(room_id, username):
        await websocket.close(code=1008)
        return

    # 头像也从服务器这边取，不信前端传的，这样别人就冒名不了
    db_user = db_helper.get_user_by_name(username)
    avatar = db_user["avatar"] if db_user else ""

    # 先接起对方的连线
    await websocket.accept()

    # 把这个人的连接登记到他进的房间里
    room_conns.setdefault(room_id, []).append(websocket)

    # 有人进来，立刻告诉所有人最新的人数
    await send_online_count(room_id)

    # 把群里每个人的读进度先发给"刚进来的这个人"。
    # 不发的话，他要等"下一个人读了消息"才能拿到这份数据，
    # 右键查"谁已读"的时候就会是空的
    await websocket.send_json({
        "type": "read",
        "reads": db_helper.get_read_states(room_id),
    })

    try:
        # 一直等这个人发消息。不发就一直等着，不占 CPU
        while True:
            data = await websocket.receive_json()

            # type 用来区分"这是普通消息"还是"我正在输入"的提示
            kind = data.get("type", "message")

            if kind == "recall":
                # 撤回：先查出这条消息，确认是"他本人发的"且"在这个房间里"，
                # 两条都满足才给撤，防止有人撤别人的消息
                target = db_helper.get_message_by_id(data.get("id"))
                if target and target["sender_name"] == username and target["room_id"] == room_id:
                    db_helper.mark_recalled(target["id"])
                    # 告诉所有人这条撤了，大家把它显示成"已撤回"
                    await broadcast(room_id, {"type": "recall", "id": target["id"]})

            elif kind == "read":
                # 已读：记下这个人读到了第几条，然后把所有人的读进度广播一遍
                db_helper.set_last_read(username, room_id, data.get("last_id", 0))
                await broadcast(room_id, {
                    "type": "read",
                    "reads": db_helper.get_read_states(room_id),
                })

            elif kind == "typing":
                # "正在输入"是临时提示，不用存数据库，也不用发回给本人
                await broadcast(room_id, {
                    "type": "typing",
                    "sender_name": username,   # 用令牌查出来的名字，不采信前端传的
                    "avatar": avatar,
                }, skip=websocket)

            elif kind == "poke":
                # 拍一拍：纯即时的娱乐互动，跟"正在输入"一样不存数据库。
                # 服务器只做两件事：确认被拍的人名字不为空、不等于自己，然后转发全房间。
                # 发送者自己也会收到，这样他自己也能看到特效
                # mid = "拍的是哪条消息旁边的头像"，前端靠它锁定同一个头像。
                # 同样要校验这条消息真的属于本房间，防止传个别的房间的编号过来
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
                # 公开群里"只看不加入"的人不能发言，先确认一下身份
                if not db_helper.is_member(username, room_id):
                    await websocket.send_json({
                        "type": "notice",
                        "text": "先点「加入本群」才能发言",
                    })
                    continue

                # 引用的消息：前端会带 quote_id（引用的那条消息的编号）。
                # 校验一下：必须是本房间真实存在的消息才认，不然当没引用，
                # 防止有人乱传编号把别的房间的消息引过来
                quote_id = data.get("quote_id") or 0
                qmsg = db_helper.get_message_by_id(quote_id) if quote_id else None
                if not (qmsg and qmsg["room_id"] == room_id):
                    quote_id = 0

                # 普通消息：先存数据库（这样刷新页面、断线重连都能找回）
                # 发送者名字和头像都取自服务器这边，前端说了不算
                msg = db_helper.save_message(room_id, username, data["content"], avatar, quote_id)
                msg["type"] = "message"   # 打个标记，前端好区分
                # 再转发给房间里的所有人（包括发消息的人自己）
                await broadcast(room_id, msg)

                # 顺便给"没在这个房间里看着的人"发一条未读提醒，
                # 这样他们在侧边栏上能立刻看到红点
                await push_unread(room_id, username)
    except WebSocketDisconnect:
        # 对方正常关掉页面，什么都不用做，下面的 finally 会清理
        pass
    finally:
        # 不管是怎么断的（关页面、断网、报错），都把这条连接从名单里删掉。
        # 忘了删的话名单会越来越长，服务器会一直给已经离开的人发消息
        conns = room_conns.get(room_id, [])
        if websocket in conns:
            conns.remove(websocket)

        # 有人走了，再报一次最新人数
        await send_online_count(room_id)

        # 房间里没人了就把这个房间的空名单也删掉，省一点内存
        if not conns and room_id in room_conns:
            del room_conns[room_id]


# 把 static 文件夹挂到网站根目录上：
# 以后访问 http://电脑IP:8000/ 就是打开 static/index.html
#
# 为什么这行要放在最后？
# 因为接口是从上往下依次匹配的：
# 先匹配 /api/hello 这类接口，都没匹配上，才会去 static 文件夹里找文件。
# 如果把它放前面，所有请求都会被当成"找文件"，接口就访问不到了。
app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")


# 下面这段的意思是：只有"直接运行这个文件"时才启动服务器
# （比如双击 start.bat，或者在命令行敲 python main.py）。
# 如果是被别的程序 import 进来用，就不会自动启动。
#
# 用 config 里的 HOST 和 PORT，所以想换端口只改 config.py 一处就行。
# reload=True 表示：改了代码服务器自动重启，不用手动关掉再开。
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=True)
