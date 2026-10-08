// Vue 是从 index.html 里用本地文件加载的，这里直接拿来用
const { createApp } = Vue;

// 公开大厅里每个群的"性格"：图标、一句话介绍、配色的名字
// （配色具体长什么样写在 style.css 里，这里只负责给格子挑一个风格名）
const HALL_STYLE = {
  "游戏群": { key: "game", icon: "🎮", desc: "开黑、找队友、聊装备" },
  "八卦群": { key: "gossip", icon: "🍉", desc: "今天又有什么瓜" },
  "二次元群": { key: "acg", icon: "🌸", desc: "可爱治愈，同好聚集" },
  "运动群": { key: "sport", icon: "🏀", desc: "约球、跑步、晒装备" },
  "学习群": { key: "study", icon: "📚", desc: "一起自习，互相督促" },
  "音乐群": { key: "music", icon: "🎵", desc: "分享最近在听的歌" },
};

createApp({
  data() {
    return {
      // ---------- 账号 ----------
      token: "",       // 登录凭证，空字符串表示还没登录
      myName: "",      // 登录成功后才有，就是账号名
      loginName: "",   // 登录框里填的用户名
      loginPwd: "",    // 登录框里填的密码
      isRegister: false, // false=登录界面，true=注册界面
      loginError: "",  // 登录或注册失败时显示的那句话

      // ---------- 页面状态 ----------
      // 右边显示什么：none=空白引导 / hall=群广场 / room=聊天界面
      view: "none",
      rooms: [],         // 我加入过的群（左栏"我的群聊"）
      hallRooms: [],     // 公开大厅的格子
      currentRoom: null, // 正在聊的群
      newRoomName: "",   // 建群时输入的名字
      joinCode: "",      // 邀请码输入框
      tip: "",           // 服务器发来的提示（比如"先加入才能发言"）

      // ---------- 消息 ----------
      messages: [],      // 这个群的消息
      inputText: "",     // 输入框里的内容
      showInvite: false, // 是否弹出邀请面板
      copyTip: "",       // 点复制之后显示的那句提示
      memberPanel: null, // 点"👥 N 人"弹出的群友名单：{ x, y } 是弹出位置，null=不显示
      memberList: [],    // 群友名单：[{ username, avatar }]
      readPanel: null,   // "谁已读"弹窗的内容，null=不显示。
                         // 长这样：{ read: ["张三"], unread: ["李四"] }
      msgMenu: null,     // 右键消息的小菜单：{ x, y, m }，x/y 是弹出位置，m 是那条消息。null=不显示
      quote: null,       // 正在引用的消息：{ id, name, content }，null=没在引用
      toast: "",         // 屏幕下方飘的小提示（比如"复制好了"），空=不显示
      toastTimer: null,  // 让小提示几秒后自己消失的定时器
      titleTimer: null,  // 标签页标题闪烁的定时器（人切去别的页面时提醒用）
      lastPokeAt: 0,     // 上次"拍一拍"的时间，防止连点刷屏（3 秒冷却）
      lastTapAt: 0,      // 上次点头像的时间（自己数"双击"，电脑手机通用）
      lastTapName: "",   // 上次点的是谁的头像（换了人再快也不算双击）

      // ---------- 连接状态 ----------
      connected: false,      // 实时连接是否正常
      ws: null,              // 群里的"电话线"（打开群才连）
      notifyWs: null,        // 通知专线（登录后一直连着，用来收未读提醒）
      reconnectTimer: null,  // 自动重连的定时器，同一时刻只允许一个
      onlineCount: 0,        // 群里在线的人数
      typingName: "",        // 正在输入的人的昵称
      typingAvatar: "",      // 正在输入的人的头像
      typingTimer: null,     // 用于让"正在输入"几秒后自动消失
      lastTypingAt: 0,       // 上次发送"正在输入"的时间，用来节流
      reads: {},             // 群里每个人读到哪条消息了：{用户名: 消息id}
      soundOn: true,         // 新消息提示音开不开
      night: false,          // 夜间模式开不开（点🌙/☀️切换，选择存进 localStorage）
      entering: false,       // 登录后的入场动画在不在播
      enterTimer: null,      // 播完把它关掉的定时器

      myAvatar: "🐱",        // 我选的头像（一个表情符号）
      // 可选的头像列表。用表情符号当头像最省事：不用上传图片，也不用存图片文件
      avatarList: ["🐱", "🐶", "🐼", "🦊", "🐻", "🐨", "🐯", "🦁",
                   "🐸", "🐵", "🐧", "🐰", "🦄", "🐙", "🐳", "🦉"],
    };
  },

  computed: {
    // 我是不是当前这个群的成员。
    // 公开大厅的群可以"先看再决定加不加"，那时候这里是 false，
    // 页面就只给"加入本群"按钮，不给输入框
    inMyRooms() {
      if (!this.currentRoom) return false;
      return this.rooms.some((r) => r.id === this.currentRoom.id);
    },

    inviteLink() {
      if (!this.currentRoom) return "";
      // location.origin 就是当前的网址（比如 http://192.168.1.20:8000）
      return location.origin + "/?room=" + (this.currentRoom.invite_code || "");
    },
  },

  mounted() {
    this.token = localStorage.getItem("chat_token") || "";
    this.myName = localStorage.getItem("chat_name") || "";
    this.myAvatar = localStorage.getItem("chat_avatar") || "🐱";
    this.soundOn = localStorage.getItem("chat_sound") !== "0";
    // 上次选的主题也要恢复：存的字符串"1"表示夜间，其他都算白天
    this.night = localStorage.getItem("chat_night") === "1";
    this.applyNight();

    // 人切回聊天室这个页面时（visibilitychange 触发、document.hidden 变 false）：
    // 标题闪烁立刻停下、恢复原标题——人已经看见消息了，就不用再闪
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.stopTitleFlash();
    });

    if (this.token) {
      this.loadRooms();
      this.connectNotify();     // 连上通知专线，在外面也能收到未读提醒
      this.enterByInviteLink(); // 如果是别人发的邀请链接，直接进那个群
    }
  },

  methods: {
    // 所有接口都要带上登录凭证，服务器才知道"你是谁"
    api(path) {
      const sep = path.indexOf("?") >= 0 ? "&" : "?";
      return path + sep + "token=" + encodeURIComponent(this.token);
    },

    // 凭证失效时的统一处理：清掉本地记录，退回登录界面
    onTokenDead() {
      alert("登录状态失效了（可能服务器重启过），请重新登录");
      this.logout();
    },

    // ---------- 左边目录 ↔ 右边内容 ----------

    // 点左栏的一个群：右边显示聊天界面
    async openRoom(room) {
      // 换群前先把旧的电话线挂断！
      // 不挂的话，下面 loadMessages 里的 markRead 会拿着"新群的消息编号"
      // 从"旧群的电话线"发出去，旧群里的人就会看到你的已读倒退成未读
      //（消息编号是全数据库统一排的，两个群的编号会互相打架）
      this.closeWs();

      this.view = "room";
      this.currentRoom = room;
      this.messages = [];
      this.onlineCount = 0;
      this.tip = "";
      // 读进度是"每个群各一份"的，换群要清空，
      // 不然右键查已读时看到的还是上一个群的人
      this.reads = {};

      // 是我加入的群才清红点；只是路过看看的公开群不用管
      if (this.inMyRooms) {
        room.unread = 0;
      }

      await this.loadMessages();   // 先把历史消息显示出来，不让页面空着
      this.connect();              // 再连上实时通道
    },

    // 点左栏的"公开大厅"：右边显示群广场
    async openHall() {
      this.view = "hall";
      this.closeWs();              // 离开聊天要把线断掉
      this.currentRoom = null;

      const res = await fetch(this.api("/api/hall/rooms"));
      if (res.status === 401) {
        this.onTokenDead();
        return;
      }
      this.hallRooms = await res.json();
    },

    // 只是看看的公开群，点"加入本群"走这里
    async joinCurrentRoom() {
      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/join"), {
        method: "POST",
      });

      if (res.status === 403) {
        alert("这是私密群，需要邀请码才能进");
        return;
      }
      if (!res.ok) {
        alert("加入失败了");
        return;
      }

      // 重新拉一次"我的群聊"，inMyRooms 就变 true，输入框就出来了
      await this.loadRooms();
      this.tip = "";
      await this.openRoom(this.currentRoom);
    },

    // ---------- 格子的风格 ----------

    // 按群名查出这个格子的风格（找不到就用默认）
    tileInfo(name) {
      return HALL_STYLE[name] || { key: "plain", icon: "💬", desc: "进来看看" };
    },
    tileStyle(name) { return this.tileInfo(name).key; },
    tileIcon(name) { return this.tileInfo(name).icon; },
    tileDesc(name) { return this.tileInfo(name).desc; },

    // ---------- 账号 ----------

    switchMode() {
      this.isRegister = !this.isRegister;
      this.loginError = "";
    },

    async submit() {
      const url = this.isRegister ? "/api/register" : "/api/login";
      this.loginError = "";

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.loginName.trim(),
          password: this.loginPwd,
          avatar: this.myAvatar,   // 注册时把选好的头像一起存进去
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        this.loginError = data.detail || "失败了，再试一次";
        return;
      }

      this.token = data.token;
      this.myName = data.username;
      this.myAvatar = data.avatar || this.myAvatar;
      localStorage.setItem("chat_token", this.token);
      localStorage.setItem("chat_name", this.myName);
      localStorage.setItem("chat_avatar", this.myAvatar);

      this.loginName = "";
      this.loginPwd = "";

      // 放完入场动画再干活：动画期间把聊天室盖住，
      // 等它淡出时数据刚好加载好，看起来就是"动画结束，房间已经在那儿了"
      this.playEnter();
      this.loadRooms();
      this.connectNotify();

      // 如果是点邀请链接进来的，登录完直接进入那个群
      this.enterByInviteLink();
    },

    // 登录成功后的入场动画：盖住页面播一小段，播完自己消失
    playEnter() {
      // 系统里开了"减弱动态效果"的人（有些人看动画会头晕）直接跳过
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
      }

      this.entering = true;
      clearTimeout(this.enterTimer);
      // 1.4 秒：样式里最后那段淡出是 .95s 开始的，这里留够时间让它走完
      this.enterTimer = setTimeout(() => { this.entering = false; }, 1400);
    },

    logout() {
      this.closeWs();
      this.closeNotify();
      this.stopTitleFlash();   // 退出登录了，标签页要是还在闪就停下
      localStorage.removeItem("chat_token");
      localStorage.removeItem("chat_name");
      this.token = "";
      this.myName = "";
      this.currentRoom = null;
      this.messages = [];
      this.view = "none";
      this.rooms = [];
      this.hallRooms = [];
    },

    // ---------- 群 ----------

    async loadRooms() {
      const res = await fetch(this.api("/api/rooms"));
      if (res.status === 401) {
        this.onTokenDead();
        return;
      }
      this.rooms = await res.json();
    },

    async createRoom() {
      const name = this.newRoomName.trim();
      if (!name) return;

      const res = await fetch(this.api("/api/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name }),
      });
      const room = await res.json();

      this.newRoomName = "";
      await this.loadRooms();   // 刷新左栏，新群出现
      this.openRoom(room);      // 建完直接进去
    },

    // 邀请码可以是 6 位码，也可以是整条邀请链接
    async joinByCode(raw) {
      let code = (raw || "").trim();
      if (code.indexOf("room=") >= 0) {
        code = code.split("room=")[1].split("&")[0];
      }

      const res = await fetch(this.api("/api/join"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.toUpperCase() }),
      });

      if (res.status === 401) {
        this.onTokenDead();
        return;
      }
      if (!res.ok) {
        alert("邀请码不对，或者这个群已经没了");
        return;
      }

      const room = await res.json();
      this.joinCode = "";
      await this.loadRooms();
      this.openRoom(room);
    },

    joinByInput() {
      if (!this.joinCode.trim()) return;
      this.joinByCode(this.joinCode);
    },

    // 地址栏带邀请码的话，登录完直接进那个群
    codeFromUrl() {
      const params = new URLSearchParams(location.search);
      return params.get("room") || "";
    },

    enterByInviteLink() {
      const code = this.codeFromUrl();
      if (code) {
        this.joinByCode(code);
      }
    },

    // 退群（群还在，别人照样聊）
    async leaveGroup() {
      if (!confirm("退出这个群？以后要用邀请码或再从大厅进来")) return;

      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/leave"), {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.detail || "退群失败了");
        return;
      }

      this.closeWs();
      await this.loadRooms();
      this.view = "none";     // 退完回到空白，右边什么都不显示
      this.currentRoom = null;
    },

    // 解散（只有房主能做，群和聊天记录一起清掉）
    async dismissRoom() {
      if (!confirm("解散这个群？聊天记录会一起删掉，所有人都会被移出")) return;

      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/dismiss"), {
        method: "POST",
      });

      if (res.status === 403) {
        alert("只有建这个群的人才能解散它");
        return;
      }
      if (!res.ok) {
        alert("解散失败了");
        return;
      }

      this.closeWs();
      await this.loadRooms();
      this.view = "none";
      this.currentRoom = null;
    },

    // ---------- 消息 ----------

    async loadMessages() {
      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/messages"));
      if (res.status === 401) {
        this.onTokenDead();
        return;
      }
      if (res.status === 403) {
        alert("你还不是这个群的成员，看不了聊天记录");
        this.closeWs();
        this.view = "none";
        return;
      }
      this.messages = await res.json();
      this.scrollToBottom();
      this.markRead();
    },

    connect() {
      // 连新线之前先把旧线彻底关掉，否则页面会同时挂着两条线，
      // 服务器转发一次，页面就显示两条重复消息
      this.closeWs();

      const addr = "ws://" + location.host + "/ws/" + this.currentRoom.id
                 + "?token=" + encodeURIComponent(this.token);
      this.ws = new WebSocket(addr);

      this.ws.onopen = () => {
        this.connected = true;
        this.loadMessages();   // 连上时再拉一次历史，补齐断线期间的消息
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // 1) 服务器给的提示（比如"先加入才能发言"）
        if (msg.type === "notice") {
          this.tip = msg.text;
          return;
        }

        // 2) 有人说话了
        if (msg.type === "message") {
          // 兜底去重：服务器给每条消息都编了唯一 id，页面上有了就不重复加
          if (this.messages.some((m) => m.id === msg.id)) return;

          this.messages.push(msg);
          this.showTyping("");
          this.scrollToBottom();
          this.markRead();

          if (msg.sender_name !== this.myName) {
            this.notifyNewMessage();
          }
          return;
        }

        // 3) 有人撤回了消息
        if (msg.type === "recall") {
          const target = this.messages.find((m) => m.id === msg.id);
          if (target) target.recalled = 1;
          return;
        }

        // 4) 群被解散了
        if (msg.type === "dismissed") {
          alert("这个群被创建者解散了");
          this.closeWs();
          this.loadRooms();
          this.view = "none";
          this.currentRoom = null;
          return;
        }

        // 5) 在线人数
        if (msg.type === "online") {
          this.onlineCount = msg.count;
          return;
        }

        // 6) 大家的已读进度
        if (msg.type === "read") {
          this.reads = msg.reads || {};
          return;
        }

        // 7) 有人正在输入
        if (msg.type === "typing") {
          this.showTyping(msg.sender_name, msg.avatar || "");
          return;
        }

        // 8) 有人被拍了 → 播放本群的拍一拍特效
        if (msg.type === "poke") {
          this.playPoke(msg);
          return;
        }
      };

      this.ws.onclose = (event) => {
        this.connected = false;

        // 1008 是服务器主动拒绝：通常是凭证失效或被判定没权限，
        // 这种情况下重连一万次也没用，直接让重新登录
        if (event.code === 1008) {
          this.onTokenDead();
          return;
        }

        this.reconnectTimer = setTimeout(() => {
          if (this.view === "room") this.connect();
        }, 3000);
      };
    },

    closeWs() {
      if (this.ws) {
        // 先摘掉 onclose 再关，否则"关闭"这个动作又会触发自动重连
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      clearTimeout(this.typingTimer);
      this.typingName = "";
    },

    sendMessage(event) {
      // 中文输入法按回车是在"选词"，不是发送
      if (event && event.isComposing) return;

      const text = this.inputText.trim();
      if (!text || !this.ws) return;

      // 只发内容，你是谁由服务器用令牌查，防止冒名。
      // 正在引用谁的话，把那条消息的编号一起带上
      this.ws.send(JSON.stringify({
        type: "message",
        content: text,
        quote_id: this.quote ? this.quote.id : 0,
      }));

      this.inputText = "";
      this.quote = null;   // 发完就取消引用，不然下一条还会带着
    },

    recallMessage(m) {
      if (!confirm("撤回这条消息？")) return;
      this.ws.send(JSON.stringify({ type: "recall", id: m.id }));
    },

    // 告诉服务器"我读到这里了"
    markRead() {
      const last = this.messages.length ? this.messages[this.messages.length - 1].id : 0;
      if (last && this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "read", last_id: last }));
      }
    },

    // 我发的消息下面那行字：全读了写"已读"、部分读报名字、没读写"未读"
    readLabel(m) {
      const all = Object.keys(this.reads).filter((n) => n !== this.myName);
      if (all.length === 0) return "";

      const read = all.filter((n) => (this.reads[n] || 0) >= m.id);

      if (read.length === all.length) return "已读";
      if (read.length === 0) return "未读";
      // 人太多会把那行挤爆，最多列三个，剩下的用"等 N 人"带过
      if (read.length > 3) {
        return read.slice(0, 3).join("、") + " 等 " + read.length + " 人已读";
      }
      return read.join("、") + " 已读";
    },

    // 右键消息：弹一个小菜单。
    // 别人的消息也有菜单（复制/引用人人都能用），
    // 但"撤回"和"查已读"两个选项只对"自己发的消息"显示（页面里用 v-if 控制）
    openMsgMenu(event, m) {
      if (m.recalled) return;   // 已撤回的消息没啥可操作的

      // 菜单出现在鼠标点的位置。
      // 两个 Math.min 是防"贴边"：鼠标点得太靠右/太靠下时，
      // 菜单会被顶出屏幕外看不见，所以最多让它离右边 190px、离底下 200px
      //（自己发的消息菜单有 4 项，比较高，所以要留 200）
      this.msgMenu = {
        x: Math.min(event.clientX, window.innerWidth - 190),
        y: Math.min(event.clientY, window.innerHeight - 200),
        m: m,
      };
    },

    closeMsgMenu() {
      this.msgMenu = null;
    },

    // 菜单里的"撤回"：跟点消息下面那行"撤回"链接走的是同一个函数
    //（recallMessage 里有 confirm 二次确认，不会一点就撤）
    menuRecall() {
      const m = this.msgMenu.m;
      this.closeMsgMenu();
      this.recallMessage(m);
    },

    // 菜单里的"查看谁已读谁未读"。
    // 道理：拿每个人的已读位置和这条消息的编号比大小，
    // 读到的位置 >= 消息编号，说明他读过这条（以及它前面的所有消息）
    menuReadInfo() {
      const m = this.msgMenu.m;
      this.closeMsgMenu();

      const names = Object.keys(this.reads).filter((n) => n !== this.myName);
      this.readPanel = {
        read: names.filter((n) => (this.reads[n] || 0) >= m.id),
        unread: names.filter((n) => (this.reads[n] || 0) < m.id),
      };
    },

    // 菜单里的"复制"：把这条消息的文字复制进剪贴板。
    // 手机上 http 页面经常不给用剪贴板，失败了就换老办法（fallbackCopy）
    async menuCopy() {
      const m = this.msgMenu.m;
      this.closeMsgMenu();

      try {
        await navigator.clipboard.writeText(m.content);
        this.showToast("复制好了");
      } catch (e) {
        if (this.fallbackCopy(m.content)) {
          this.showToast("复制好了");
        } else {
          this.showToast("复制不了，请长按消息手动复制");
        }
      }
    },

    // 菜单里的"引用"：把这条消息挂到输入框上方，发消息时一起带出去
    menuQuote() {
      const m = this.msgMenu.m;
      this.closeMsgMenu();

      // 引用的内容太长的话截断，输入框上那行小字放不下
      const text = m.content.length > 30 ? m.content.slice(0, 30) + "…" : m.content;
      this.quote = { id: m.id, name: m.sender_name, content: text };
    },

    // 点群名旁边的"👥 N 人"：把这个群的成员名单弹出来
    async openMembers(event) {
      // 位置跟右键菜单一个处理方式：鼠标太靠边时往回缩，别把菜单顶出屏幕外
      this.memberPanel = {
        x: Math.min(event.clientX, window.innerWidth - 200),
        y: Math.min(event.clientY, window.innerHeight - 260),
      };

      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/members"));
      if (res.status === 401) {
        this.onTokenDead();
        return;
      }
      if (!res.ok) {
        this.showToast("看不了这个群的成员");
        this.closeMembers();
        return;
      }
      this.memberList = await res.json();
    },

    closeMembers() {
      this.memberPanel = null;
      this.memberList = [];
    },

    // 屏幕下方飘一条小提示，1.6 秒后自己消失
    showToast(text) {
      this.toast = text;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { this.toast = ""; }, 1600);
    },

    // ---------- 拍一拍 ----------

    // 双击头像触发：电脑左键快速双击、手机手指快速点两下。
    // 不用浏览器的 dblclick 事件，因为手机上它经常不触发（还容易跟双击缩放打架），
    // 自己数点击最稳：350ms 内连点同一个头像两下就算数
    onAvatarTap(m) {
      const now = Date.now();

      if (this.lastTapName === m.sender_name && now - this.lastTapAt < 350) {
        // 第二下：清空记录，拍！
        this.lastTapName = "";
        this.lastTapAt = 0;

        // 双击可能已经顺手选中了附近的文字（浏览器默认行为），
        // 把选区清掉——不然 Edge 这类浏览器会弹出自带的复制/搜索小工具条
        if (window.getSelection) {
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();
        }

        this.pokeSomeone(m.sender_name, m.id);
      } else {
        // 第一下：先记着，等第二下
        this.lastTapName = m.sender_name;
        this.lastTapAt = now;
      }
    },

    // 真正"拍人"的逻辑：冷却检查 + 发消息给服务器
    // mid = 被双击的那条消息的编号。带上它，别人开发时才能锁到同一个头像，
    // 而不是各自找"这个人最后一条消息"的头像
    pokeSomeone(name, mid) {
      // 自己不能拍自己
      if (name === this.myName) {
        this.showToast("不能拍自己啦");
        return;
      }

      // 冷却：3 秒内只能拍一次，防止连点把特效刷成幻灯片
      const now = Date.now();
      if (now - this.lastPokeAt < 3000) {
        this.showToast("拍太快啦，歇 3 秒");
        return;
      }
      this.lastPokeAt = now;

      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "poke", target: name, mid: mid || 0 }));
        this.showToast("你拍了拍 " + name);
      }
    },

    // 收到"有人被拍了"：找到被拍人的头像位置，按当前群的风格播特效
    playPoke(msg) {
      const from = msg.from || "";
      const target = msg.target || "";

      // 被拍的人额外弹一句提醒（拍的人刚才已经 toast 过了，不用重复）
      if (target === this.myName) {
        this.showToast(from + " 拍了拍你");
      }

      // 找被拍的头像：优先按"对方点的是哪条消息"（服务器带回来的 mid）找，
      // 这样所有人看到的特效都落在**同一个**头像上——就是你双击的那个。
      // 以前没有这个编号，各人只能自己找"他最后一条消息"的头像，位置就可能对不上
      let av = null;
      if (msg.mid) {
        const hit = document.querySelector('.msg-row[data-mid="' + msg.mid + '"] .avatar');
        if (hit) av = hit;
      }

      if (!av) {
        // 兜底：那条消息不在已加载的范围里，退回"他最后一条消息"的头像
        const rows = document.querySelectorAll('.msg-row[data-name="' + target + '"]');
        const row = rows.length ? rows[rows.length - 1] : null;
        av = row ? row.querySelector(".avatar") : null;
      }

      let rect;
      if (av) {
        rect = av.getBoundingClientRect();
      } else {
        // 他还没说过话（消息区找不到头像）：退而求其次，在消息区中央拍一下
        const list = this.$refs.msgList;
        const r = list
          ? list.getBoundingClientRect()
          : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        rect = { left: r.left + r.width / 2 - 24, top: r.top + r.height / 2 - 24, width: 48, height: 48 };
      }

      // 按当前群的名字挑特效风格（游戏群/八卦群……私密群用通用版）
      const kind = this.currentRoom ? this.tileStyle(this.currentRoom.name) : "plain";
      // 把头像元素也带上：学习群的印章要"盖"在头像身上，光有坐标不够
      this.runPokeFx(kind, rect, from, target, av);
    },

    // 特效总调度：通用的部分（字幕、头像抖动）先做，再按群分发专属动画
    runPokeFx(kind, rect, fromName, targetName, avEl) {
      const layer = this.$refs.fxLayer;
      if (!layer) return;

      const cx = rect.left + rect.width / 2;   // 头像此刻的屏幕中心
      const cy = rect.top + rect.height / 2;

      // 顶部飘一行"谁拍了拍谁"（贴在屏幕顶上，跟头像位置无关）
      this.pokeCaption(layer, fromName, targetName);

      // 被拍的头像抖一抖（被拍的是自己时，自己头像也在屏幕上，一样抖）
      if (avEl) {
        avEl.classList.add("fx-shake");
        setTimeout(() => avEl.classList.remove("fx-shake"), 700);
      }

      // 造一个"锚点容器"钉在头像中心，所有动画元素都画在它里面。
      // 这样下面 fxTrack 每帧挪一次锚点，里面的东西就全体跟着走，
      // 滚动消息列表时特效不会再傻站在原来的位置
      const root = document.createElement("div");
      root.className = "fx-root";
      root.style.left = cx + "px";
      root.style.top = cy + "px";
      layer.appendChild(root);
      // 兜底清理：最长 5 秒一定删掉（学习群的小红花要留 4 秒，所以设 5 秒）
      setTimeout(() => root.remove(), 5000);

      // 每帧盯着头像挪锚点
      this.fxTrack(root, avEl, 4500);

      // 每个群一个专属画法；群名匹配不上（私密群）就画通用版
      const painters = {
        game: this.fxGame, gossip: this.fxGossip, acg: this.fxAcg,
        sport: this.fxSport, study: this.fxStudy, music: this.fxMusic,
        plain: this.fxPlain,
      };
      // 注意：从这往下，画板不再是全屏的 fxLayer，而是跟着头像跑的 root。
      // 所以所有坐标都改成"相对于头像中心"（0,0 就是头像正中间）
      (painters[kind] || this.fxPlain).call(this, root, rect, cx, cy, avEl);
    },

    // 让锚点容器每帧跟着头像走。
    // 头像被移出页面（比如那条消息被撤回了）就停手，
    // 否则量出来的位置会变成 0,0，特效反而飘到屏幕左上角去
    fxTrack(root, avEl, life) {
      if (!avEl) return;

      const start = Date.now();
      const step = () => {
        if (!document.body.contains(avEl) || !document.body.contains(root)) return;

        const r = avEl.getBoundingClientRect();
        if (r.width || r.height) {
          root.style.left = (r.left + r.width / 2) + "px";
          root.style.top = (r.top + r.height / 2) + "px";
        }
        if (Date.now() - start < life) requestAnimationFrame(step);
      };
      step();
    },

    // 造一个特效元素放进特效层，life 毫秒后自动删掉（不删的话会越积越多）
    fxAdd(layer, cls, text, style, life) {
      const el = document.createElement("div");
      el.className = cls;
      if (text) el.textContent = text;
      if (style) Object.assign(el.style, style);
      layer.appendChild(el);
      if (life) setTimeout(() => el.remove(), life);
      return el;
    },

    // 顶部字幕："张三 拍了拍 李四"
    pokeCaption(layer, fromName, targetName) {
      const cap = document.createElement("div");
      cap.className = "fx-caption";
      cap.textContent = fromName + " 拍了拍 " + (targetName === this.myName ? "你" : targetName);
      layer.appendChild(cap);
      setTimeout(() => cap.remove(), 1900);
    },

    // 游戏群：准心从屏幕中心出现 → 瞄准拖拽锁定 → 红圈脉冲 → 开火闪光
    fxGame(layer, rect, cx, cy) {
      // 起点写成"相对头像的偏移"：屏幕中心 减去 头像中心。
      // 第一眼看过去还是从屏幕正中出来的，但因为它住在跟着头像跑的容器里，
      // 飞过去之后就能稳稳跟着头像走
      const offX = window.innerWidth / 2 - cx;
      const offY = window.innerHeight / 2 - cy;

      // 主准心 + 一个慢半拍的模糊拖尾（"拖拽"的感觉就是它追出来的）
      const cross = this.fxAdd(layer, "fx-cross", "", { left: offX + "px", top: offY + "px" }, 1700);
      const trail = this.fxAdd(layer, "fx-trail", "", { left: offX + "px", top: offY + "px" }, 1700);

      // 第一拍：从屏幕中心亮出来
      requestAnimationFrame(() => {
        cross.style.opacity = "1";
        cross.style.transform = "translate(-50%,-50%) scale(1.5)";
        trail.style.opacity = "0.5";
      });

      // 第二拍：瞄准——带缓动地平移过去并缩小，曲线带一点回弹，
      // 拖尾慢 100ms、更糊更小，看起来就是"拖着"准心走
      setTimeout(() => {
        cross.style.transition =
          "left .65s cubic-bezier(.22,.9,.34,1.18), top .65s cubic-bezier(.22,.9,.34,1.18), transform .65s ease";
        trail.style.transition =
          "left .78s ease-out, top .78s ease-out, transform .78s ease, opacity .78s ease";
        cross.style.left = "0px";
        cross.style.top = "0px";
        cross.style.transform = "translate(-50%,-50%) scale(.85)";
        trail.style.left = "0px";
        trail.style.top = "0px";
        trail.style.transform = "translate(-50%,-50%) scale(.5)";
        trail.style.opacity = "0";
      }, 180);

      // 第三拍：锁定——变红、脉冲，外加锁定圈和开火闪光
      setTimeout(() => {
        cross.classList.add("fx-cross-lock");
        this.fxAdd(layer, "fx-lock-ring", "", { left: "0px", top: "0px" }, 700);
        this.fxAdd(layer, "fx-flash", "", { left: "0px", top: "0px" }, 380);
      }, 900);

      // 第四拍：收工淡出
      setTimeout(() => { cross.style.opacity = "0"; }, 1400);
    },

    // 八卦群：大西瓜从天而降，砸中头像裂成几瓣
    fxGossip(layer, rect, cx, cy) {
      const melon = this.fxAdd(layer, "fx-fall", "🍉", { left: "0px", top: "0px" }, 1500);

      setTimeout(() => {
        melon.style.transition = "opacity .1s ease";
        melon.style.opacity = "0";
        // 瓜瓤四溅
        ["🍉", "🍉", "🍈", "✨"].forEach((p, i) => {
          const ang = (Math.PI * 2 * i) / 4 - Math.PI / 2;
          const bit = this.fxAdd(layer, "fx-burst", p, { left: "0px", top: "0px" }, 900);
          bit.style.setProperty("--dx", Math.cos(ang) * 70 + "px");
          bit.style.setProperty("--dy", Math.sin(ang) * 70 - 30 + "px");
        });
      }, 620);
    },

    // 二次元群：两根葱当双马尾，葱根（圆锥顶点）不动、葱身绕竖直轴转圈扫出圆锥面。
    // 左右两根靠 --lean / --spin / --mirror 三个变量做镜面对称
    fxAcg(layer, rect, cx, cy) {
      [-1, 1].forEach((side) => {
        const leek = this.fxAdd(layer, "fx-leek", "",
          { left: (side * 15) + "px", top: "-14px" }, 2000);
        leek.style.setProperty("--lean", (side * 20) + "deg");
        leek.style.setProperty("--spin", (side * 720) + "deg");
        leek.style.setProperty("--mirror", String(side));
      });
      // 画面上就这两根荧光棒，别的什么都不加
    },

    // 运动群：篮球从画面中心出现展开（跟游戏群准心同一套入场），弹着飞到头像上再旋转弹走
    fxSport(layer, rect, cx, cy) {
      const offX = window.innerWidth / 2 - cx;
      const offY = window.innerHeight / 2 - cy;

      // 两层：外层管位置和缩放，内层管弹跳。
      // 两者都是 transform，拆开才不会互相覆盖
      const wrap = this.fxAdd(layer, "fx-ball-wrap", "",
        { left: offX + "px", top: offY + "px" }, 1900);

      const ball = document.createElement("div");
      ball.className = "fx-basketball";
      ball.textContent = "🏀";
      wrap.appendChild(ball);

      requestAnimationFrame(() => {
        wrap.style.opacity = "1";
        wrap.style.transform = "translate(-50%,-50%) scale(1.5)";
      });

      // 第二拍：同一条带回弹的缓动曲线飞向头像，缩小落位（对应准心的"锁定"）
      setTimeout(() => {
        wrap.style.transition =
          "left .65s cubic-bezier(.22,.9,.34,1.18), top .65s cubic-bezier(.22,.9,.34,1.18), transform .65s ease";
        wrap.style.left = "0px";
        wrap.style.top = "0px";
        wrap.style.transform = "translate(-50%,-50%) scale(.85)";
      }, 180);

      // 第三拍：砸中——闪光一下，球旋转着弹向右上角消失
      setTimeout(() => {
        this.fxAdd(layer, "fx-flash", "", { left: "0px", top: "0px" }, 380);
        wrap.style.transition =
          "left .7s ease-in, top .7s cubic-bezier(.3,0,.8,1), transform .7s ease-in, opacity .7s ease-in";
        wrap.style.left = "180px";
        wrap.style.top = "-120px";
        wrap.style.transform = "translate(-50%,-50%) rotate(540deg) scale(.7)";
        wrap.style.opacity = "0";
      }, 950);
    },

    // 学习群：给头像盖一朵小红花印章
    fxStudy(layer, rect, cx, cy, avEl) {
      if (!avEl) return;   // 他还没说过话，没有头像可盖

      // 印章直接盖进头像元素里（不画在特效层），滚动时才会跟着头像走
      avEl.style.position = "relative";
      const old = avEl.querySelector(".fx-redflower");
      if (old) old.remove();              // 连着拍两下：换新花，不叠两层

      const flower = document.createElement("div");
      flower.className = "fx-redflower";
      flower.textContent = "🌸";
      avEl.appendChild(flower);

      // 盖章瞬间的红色涟漪画在容器正中间（扩散的圈不适合挤在头像里）
      this.fxAdd(layer, "fx-lock-ring", "", { left: "0px", top: "0px" }, 600);

      // 小红花是"装饰点缀"，跟别的特效不一样，得多留一会儿：4 秒后轻轻淡掉
      setTimeout(() => flower.classList.add("fx-redflower-bye"), 3800);
      setTimeout(() => flower.remove(), 4400);
    },

    // 音乐群：音符往上飘 + 均衡器音柱（刻意做小，不抢戏）
    fxMusic(layer, rect, cx, cy) {
      ["🎵", "♪", "♫"].forEach((p, i) => {
        const bit = this.fxAdd(layer, "fx-float", p,
          { left: ((i - 1) * 14) + "px", top: "-6px" }, 1200);
        bit.style.fontSize = "18px";   // 默认 26px，音乐群特意缩小一号
        bit.style.setProperty("--dx", ((i - 1) * 16) + "px");
        bit.style.setProperty("--dy", (-44 - Math.random() * 24) + "px");
        bit.style.animationDelay = (i * 80) + "ms";
      });
      // 音柱：3 根矮柱子，紧紧贴着头像底边
      for (let i = 0; i < 3; i++) {
        const bar = this.fxAdd(layer, "fx-eq", "",
          { left: (-16 + i * 16) + "px", top: "26px" }, 1200);
        bar.style.animationDelay = (i * 110) + "ms";
      }
    },

    // 私密群通用版：一巴掌 + 白圈
    fxPlain(layer, rect, cx, cy) {
      this.fxAdd(layer, "fx-float", "👋", { left: "0px", top: "0px" }, 950);
      this.fxAdd(layer, "fx-ring-plain", "", { left: "0px", top: "0px" }, 700);
      this.fxAdd(layer, "fx-poke-word", "拍了拍", { left: "0px", top: "-44px" }, 950);
    },

    pickAvatar(emoji) {
      this.myAvatar = emoji;
      localStorage.setItem("chat_avatar", emoji);
    },

    // ---------- 新消息提醒 ----------

    toggleSound() {
      this.soundOn = !this.soundOn;
      localStorage.setItem("chat_sound", this.soundOn ? "1" : "0");
      // 正在闪的时候把铃铛关了：提醒立刻停，恢复原标题
      if (!this.soundOn) this.stopTitleFlash();
    },

    // ---------- 白天/夜间模式 ----------

    // 点 🌙/☀️：翻转状态、记住选择、给 body 挂上/摘掉 night 类。
    // 样式全在 body.night 那套 CSS 规则里，这里只管"挂不挂"，一行样式都不用写
    toggleNight() {
      this.night = !this.night;
      localStorage.setItem("chat_night", this.night ? "1" : "0");
      this.applyNight();
    },

    // 把当前主题"刷"到页面上：夜里给 body 加 night 类，白天摘掉。
    // 为什么挂在 body 上而不是 #app 上：特效层、toast 这些元素也在 body 下，
    // 挂在 body 上它们才能跟着一起换肤
    applyNight() {
      document.body.classList.toggle("night", this.night);
    },

    // 提醒的总开关入口。参数 force 的意思见下面
    notifyNewMessage(force) {
      // 出声的规则只有一句话：你看得见就不响，看不见才响。
      //   - 正看着这个群（页面在前台）：消息就在眼前，响一声纯属吵
      //   - 人切到别的页面/手机锁屏了（document.hidden）：看不见，响
      //   - 消息来自别的群（force=true）：你根本没打开那个群，一定看不见，响
      const canSee = !force && !document.hidden;
      if (!canSee && this.soundOn) {
        this.playSound();
      }

      // 标签页提醒：只有"人切到别的页面去了"（document.hidden）才提醒，
      // 人正看着聊天室时提醒没有意义；铃铛关掉则声音和闪烁一起全关
      if (this.soundOn && document.hidden) {
        this.startTitleFlash();
      }
    },

    // ---------- 标签页闪烁提醒 ----------

    // 让浏览器标签页的标题一闪一闪地显示"你有新的消息"。
    // document.hidden：人切到别的标签页时是 true，切回来是 false，
    // 浏览器自带这个开关，正好符合"只有人在别的页面才有用"的要求
    startTitleFlash() {
      if (this.titleTimer) return;   // 已经在闪了就不叠加，消息再多也只闪一组

      let on = false;
      const blink = () => {
        on = !on;
        // 两种标题来回切：提醒文字 ↔ 原标题，看起来就是"闪烁"
        document.title = on ? "💬 你有新的消息" : "轻量聊天室";
      };

      blink();                  // 立刻先把标题换成提醒文字，不等第一个周期
      this.titleTimer = setInterval(blink, 1000);   // 每秒闪一下
    },

    // 停止闪烁、恢复原标题。切回页面 / 关铃铛 / 退出登录时都要叫它
    stopTitleFlash() {
      clearInterval(this.titleTimer);
      this.titleTimer = null;
      document.title = "轻量聊天室";
    },

    // 用代码合成一声"叮"，不需要任何音频文件
    playSound() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();   // 发声器
        const gain = ctx.createGain();        // 音量

        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch (e) {
        // 浏览器可能因为"还没交互过"不让发声，静音就好，不能让页面报错
      }
    },

    // ---------- 通知专线（在群外面也能收到未读提醒） ----------

    connectNotify() {
      const addr = "ws://" + location.host + "/ws/notify?token=" + encodeURIComponent(this.token);
      this.notifyWs = new WebSocket(addr);

      this.notifyWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type !== "unread") return;

        const room = this.rooms.find((r) => r.id === msg.room_id);
        if (!room) return;

        // 人正待在这个群里就不用显示红点了
        const inThisRoom = this.currentRoom && this.currentRoom.id === msg.room_id;
        if (inThisRoom) return;

        room.unread = msg.unread;

        // 别的群来消息：不能只在左栏加个红点就算了，
        // 提示音和标签页闪烁也得一起叫（跟"正在聊的群来消息"同一个函数，
        // 里面会判断：人在别的页面才闪、铃铛关了就全关）。
        // 传 true = 这个群我根本没打开，一定看不见，所以无条件出声
        this.notifyNewMessage(true);
      };

      this.notifyWs.onclose = () => {
        setTimeout(() => {
          if (this.token) this.connectNotify();
        }, 3000);
      };
    },

    closeNotify() {
      if (this.notifyWs) {
        this.notifyWs.onclose = null;
        this.notifyWs.close();
        this.notifyWs = null;
      }
    },

    // ---------- 邀请面板 ----------

    async copyLink() {
      const text = this.inviteLink;
      try {
        await navigator.clipboard.writeText(text);
        this.copyTip = "复制好了，发给朋友吧";
      } catch (e) {
        // 手机上用 http（不是 https）时，浏览器常常不给用剪贴板，换老办法
        if (this.fallbackCopy(text)) {
          this.copyTip = "复制好了，发给朋友吧";
        } else {
          this.copyTip = "实在复制不了，请长按上面的链接手动复制";
        }
      }
      setTimeout(() => { this.copyTip = ""; }, 2500);
    },

    fallbackCopy(text) {
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();

      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }

      document.body.removeChild(box);
      return ok;
    },

    // ---------- 小工具 ----------

    scrollToBottom() {
      // $nextTick = 等 Vue 把新消息画出来之后，再滚动（不然页面还没变高）
      this.$nextTick(() => {
        const el = this.$refs.msgList;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    notifyTyping() {
      const now = Date.now();
      if (now - this.lastTypingAt < 1500) return;   // 1.5 秒最多发一次
      this.lastTypingAt = now;

      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "typing" }));
      }
    },

    onInput(event) {
      this.inputText = event.target.value;
      this.notifyTyping();
    },

    showTyping(name, avatar) {
      this.typingName = name;
      this.typingAvatar = avatar || "";
      clearTimeout(this.typingTimer);
      if (name) {
        this.typingTimer = setTimeout(() => {
          this.typingName = "";
          this.typingAvatar = "";
        }, 3000);
      }
    },
  },
}).mount("#app");
