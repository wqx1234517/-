// Vue 是从 index.html 里用本地文件加载的，这里直接拿来用
const { createApp } = Vue;

createApp({
  // data 里放的是"页面上会变的东西"，改了它们页面就会自动刷新
  data() {
    return {
      // ---------- 账号 ----------
      token: "",       // 登录凭证，空字符串表示还没登录
      myName: "",      // 登录成功后才有，就是账号名
      loginName: "",   // 登录框里填的用户名
      loginPwd: "",    // 登录框里填的密码
      isRegister: false, // false=登录界面，true=注册界面
      loginError: "",  // 登录或注册失败时显示的那句话

      // ---------- 房间和消息 ----------
      rooms: [],         // 房间列表
      newRoomName: "",   // 新建房间时输入的名字
      currentRoom: null, // 当前所在的房间，null 表示还没进
      messages: [],      // 这个房间的消息
      inputText: "",     // 输入框里的内容
      joinCode: "",      // "用邀请码加入"那个框里填的码
      showInvite: false, // 是否弹出邀请面板
      copyTip: "",       // 点复制之后显示的那句提示

      // ---------- 连接状态 ----------
      connected: false,      // 实时连接是否正常
      ws: null,              // 房间里的"电话线"（进了房间才连）
      notifyWs: null,        // 通知专线（登录后一直连着，用来收未读提醒）
      reconnectTimer: null,  // 自动重连的定时器，同一时刻只允许一个
      onlineCount: 0,        // 房间里在线的人数
      typingName: "",        // 正在输入的人的昵称
      typingAvatar: "",      // 正在输入的人的头像
      typingTimer: null,     // 用于让"正在输入"几秒后自动消失
      lastTypingAt: 0,       // 上次发送"正在输入"的时间，用来节流
      reads: {},             // 房间里每个人读到哪条消息了：{用户名: 消息id}
      soundOn: true,         // 新消息提示音开不开

      myAvatar: "🐱",        // 我选的头像（一个表情符号）
      // 可选的头像列表。用表情符号当头像最省事：不用上传图片，也不用存图片文件
      avatarList: ["🐱", "🐶", "🐼", "🦊", "🐻", "🐨", "🐯", "🦁",
                   "🐸", "🐵", "🐧", "🐰", "🦄", "🐙", "🐳", "🦉"],
    };
  },

  // computed 是"算出来的值"：它依赖的东西变了，它自己就跟着变，不用手动更新。
  // 这里用它拼邀请链接，房间一换链接就自动跟着换
  computed: {
    inviteLink() {
      if (!this.currentRoom) return "";
      // location.origin 就是当前的网址（比如 http://192.168.1.20:8000），
      // 用它拼链接，换电脑、换端口都不用改代码
      return location.origin + "/?room=" + (this.currentRoom.invite_code || "");
    },
  },

  // mounted 是页面刚打开时自动执行一次的地方
  mounted() {
    // localStorage 是浏览器自带的小记事本，关掉页面再打开还能记住。
    // 上次登录过的凭证存在这里，所以刷新页面不用重新登录
    this.token = localStorage.getItem("chat_token") || "";
    this.myName = localStorage.getItem("chat_name") || "";
    this.myAvatar = localStorage.getItem("chat_avatar") || "🐱";
    // 提示音开关也记着（存的是字符串 "0" 或 "1"）
    this.soundOn = localStorage.getItem("chat_sound") !== "0";

    if (this.token) {
      this.loadRooms();         // 有凭证就直接进，省得再登一次
      this.connectNotify();     // 连上通知专线，这样在外面也能收到未读提醒
      this.enterByInviteLink(); // 如果是别人发的邀请链接，直接把他送进房间
    }
  },

  methods: {
    // 所有接口都要带上登录凭证，服务器才知道"你是谁、该给你看哪些房间"。
    // 这个方法就是负责在地址后面挂上 ?token=xxx
    api(path) {
      const sep = path.indexOf("?") >= 0 ? "&" : "?";
      return path + sep + "token=" + encodeURIComponent(this.token);
    },

    // 凭证失效时的统一处理：清掉本地记录，退回登录界面
    onTokenDead() {
      alert("登录状态失效了（可能服务器重启过），请重新登录");
      this.logout();
    },

    // ---------- 邀请 ----------

    // 读地址栏里 ?room=XXXXXX 的那部分。别人点开你发的邀请链接时，码就在这里
    codeFromUrl() {
      const params = new URLSearchParams(location.search);
      return params.get("room") || "";
    },

    // 地址栏带邀请码的话，登录完就直接进房间，不用再手动输一次
    enterByInviteLink() {
      const code = this.codeFromUrl();
      if (code) {
        this.joinByCode(code);
      }
    },

    // 用邀请码进房间：把码交给服务器，服务器告诉你是哪个房间
    async joinByCode(raw) {
      // 别人可能把整条链接粘过来（http://xxx/?room=ABC123），
      // 这里判断一下：如果是链接，就把里面的邀请码抠出来
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
        alert("邀请码不对，或者这个房间已经没了");
        return;
      }

      const room = await res.json();
      this.joinCode = "";
      this.enterRoom(room);
    },

    // 首页那个"用邀请码加入"的按钮
    joinByInput() {
      if (!this.joinCode.trim()) return;
      this.joinByCode(this.joinCode);
    },

    async copyLink() {
      const text = this.inviteLink;
      try {
        // 新办法：用浏览器自带的剪贴板功能
        await navigator.clipboard.writeText(text);
        this.copyTip = "复制好了，发给朋友吧";
      } catch (e) {
        // 手机上用 http（不是 https）打开时，浏览器常常不让用这个功能。
        // 换老办法再试一次：临时造一个看不见的输入框，选中它再执行复制命令
        if (this.fallbackCopy(text)) {
          this.copyTip = "复制好了，发给朋友吧";
        } else {
          this.copyTip = "实在复制不了，请长按上面的链接手动复制";
        }
      }
      // 提示显示一会儿就自己消失
      setTimeout(() => { this.copyTip = ""; }, 2500);
    },

    // 老办法复制：造一个隐藏的输入框，选中内容后执行浏览器的复制命令。
    // 返回 true 表示复制成功了
    fallbackCopy(text) {
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.opacity = "0";   // 看不见，但能选中
      document.body.appendChild(box);
      box.select();

      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }

      document.body.removeChild(box);   // 用完立刻删掉，不留痕迹
      return ok;
    },
    // ---------- 账号：注册和登录 ----------

    switchMode() {
      // 在"登录"和"注册"两个界面之间切一下，顺手清掉上次的错误提示
      this.isRegister = !this.isRegister;
      this.loginError = "";
    },

    async submit() {
      // 登录和注册用的是同一套界面，只是打给不同的接口
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
        // 后端返回 400 时，data.detail 里是那句错误原因
        this.loginError = data.detail || "失败了，再试一次";
        return;
      }

      // 成功：把凭证和用户名记住，然后去房间列表
      this.token = data.token;
      this.myName = data.username;
      this.myAvatar = data.avatar || this.myAvatar;
      localStorage.setItem("chat_token", this.token);
      localStorage.setItem("chat_name", this.myName);
      localStorage.setItem("chat_avatar", this.myAvatar);

      this.loginName = "";
      this.loginPwd = "";
      this.loadRooms();
      this.connectNotify();   // 登录成功也把通知专线连上

      // 如果是点邀请链接进来的，登录完顺便把他送进那个房间
      this.enterByInviteLink();
    },

    // ---------- 通知专线（在房间外面收未读提醒） ----------

    connectNotify() {
      // 这条线不针对任何房间，登录后一直保持，
      // 服务器会在"你没在看的房间来了新消息"时，通过它告诉你有几条未读
      const addr = "ws://" + location.host + "/ws/notify?token=" + encodeURIComponent(this.token);
      this.notifyWs = new WebSocket(addr);

      this.notifyWs.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type !== "unread") return;

        const room = this.rooms.find((r) => r.id === msg.room_id);
        if (!room) return;

        // 如果人正待在这个房间里，就不用显示红点了（消息已经看到了）
        const inThisRoom = this.currentRoom && this.currentRoom.id === msg.room_id;
        if (inThisRoom) return;

        room.unread = msg.unread;   // 房间列表上的红点数字，实时更新
      };

      this.notifyWs.onclose = () => {
        // 掉线了 3 秒后重连。已经退出登录的话就不连了
        setTimeout(() => {
          if (this.token) this.connectNotify();
        }, 3000);
      };
    },

    closeNotify() {
      if (this.notifyWs) {
        this.notifyWs.onclose = null;   // 摘掉回调，免得"关闭"又触发重连
        this.notifyWs.close();
        this.notifyWs = null;
      }
    },

    logout() {
      // 退出登录：把记在浏览器里的凭证删掉，回到登录界面
      this.closeWs();
      this.closeNotify();   // 通知专线也一起关掉
      localStorage.removeItem("chat_token");
      localStorage.removeItem("chat_name");
      this.token = "";
      this.myName = "";
      this.currentRoom = null;
      this.messages = [];
    },

    // ---------- 房间相关 ----------

    async loadRooms() {
      // async/await：等服务器回话，拿到结果再往下走。
      // 服务器只返回我加入过的房间，别人的房间不在这里
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
        body: JSON.stringify({ name: name }),  // 对象要转成字符串才能发
      });
      const room = await res.json();

      this.newRoomName = "";
      await this.loadRooms();   // 刷新列表，让新房间出现在页面上
      this.enterRoom(room);     // 建完直接进去
    },

    async enterRoom(room) {
      // 不用再填昵称了，直接用登录时的账号名
      this.currentRoom = room;
      room.unread = 0;   // 人都进来了，这个房间的红点就该消失
      this.messages = [];
      this.onlineCount = 0;   // 还没连上，人数先归零，连上后服务器会报真实人数
      await this.loadMessages();  // 先把历史消息显示出来，不让页面空着
      this.connect();             // 再连上实时通道
    },

    leaveRoom() {
      this.closeWs();   // 退房间要挂断电话，不然服务器一直等着
      this.currentRoom = null;
      this.messages = [];
      this.onlineCount = 0;
      this.typingName = "";
      this.showInvite = false;   // 邀请面板也一并收起来
      this.loadRooms();
    },

    // 把当前的连接彻底关掉，并且取消还没执行的自动重连
    // 这一步是防止"重复消息"的关键：页面上永远只保留一条线
    closeWs() {
      if (this.ws) {
        // 先摘掉它的 onclose 再关。
        // 否则关闭这个动作会触发 onclose 里的"自动重连"，反而又冒出一条新线
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
      }
      // 之前排队等着重连的定时器也一并取消
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      // "正在输入"的提示也一起清掉，不然退了房间还挂着别人的名字
      clearTimeout(this.typingTimer);
      this.typingName = "";
    },

    // ---------- 消息相关 ----------

    async loadMessages() {
      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/messages"));
      if (res.status === 401 || res.status === 403) {
        // 401 是没登录，403 是不是这个房间的成员
        this.onTokenDead();
        return;
      }
      this.messages = await res.json();
      this.scrollToBottom();
      this.markRead();   // 历史消息一加载完，就说明这些我都看到了
    },

    // 告诉服务器"我读到这个房间最新的那条消息了"。
    // 服务器会记下来，再广播给房间里其他人 —— 对方那边的"已读"就是这么来的
    markRead() {
      const last = this.messages.length ? this.messages[this.messages.length - 1].id : 0;
      if (last && this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "read", last_id: last }));
      }
    },

    // 撤回自己发的消息
    recallMessage(m) {
      if (!confirm("撤回这条消息？")) return;
      this.ws.send(JSON.stringify({ type: "recall", id: m.id }));
    },

    // 解散房间。后端会再校验一次：不是你建的会返回 403
    async dismissRoom() {
      if (!confirm("解散这个房间？聊天记录会一起删掉，所有人都不能再进来")) return;

      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/dismiss"), {
        method: "POST",
      });

      if (res.status === 403) {
        alert("只有建这个房间的人才能解散它");
        return;
      }
      if (!res.ok) {
        alert("解散失败了");
        return;
      }

      this.leaveRoom();   // 退回去，顺便刷新房间列表
    },

    // 退群：自己退出这个房间（房间还在，别人照样聊）
    async leaveGroup() {
      if (!confirm("退出这个房间？以后要用邀请码才能再进来")) return;

      const res = await fetch(this.api("/api/rooms/" + this.currentRoom.id + "/leave"), {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.detail || "退群失败了");
        return;
      }

      this.leaveRoom();   // 关掉连接并刷新列表，房间会从我的列表里消失
    },

    // 我发的这条消息，下面那行"已读/未读"到底显示什么。
    // 规则：全都看了就写"已读"；只看了几个就把名字列出来；一个都没看就写"未读"
    readLabel(m) {
      // 房间里除我以外的所有人
      const all = Object.keys(this.reads).filter((n) => n !== this.myName);
      if (all.length === 0) return "";   // 就我一个人，没什么好显示的

      // 其中"读到这条"的人：他读到的消息 id >= 这条消息的 id，就说明他看过了
      const read = all.filter((n) => (this.reads[n] || 0) >= m.id);

      if (read.length === all.length) return "已读";      // 所有人都看了，不用报名字
      if (read.length === 0) return "未读";               // 一个都没看
      // 只有一部分人看了：把名字报出来。
      // 人太多会把那一行挤爆，所以最多列三个，剩下的用"等 N 人"带过
      if (read.length > 3) {
        return read.slice(0, 3).join("、") + " 等 " + read.length + " 人已读";
      }
      return read.join("、") + " 已读";
    },

    connect() {
      // 连新线之前，先把旧线彻底关掉。
      // 否则页面会同时挂着两条线，服务器转发一次，页面就显示两条重复消息
      this.closeWs();

      // WebSocket 的地址是 ws:// 开头，location.host 就是当前网址的 IP 和端口。
      // 后面那个 ?token= 是登录凭证 —— 浏览器建立 WebSocket 时没法自定义请求头，
      // 所以只能把凭证挂在地址后面带过去
      const addr = "ws://" + location.host + "/ws/" + this.currentRoom.id
                 + "?token=" + encodeURIComponent(this.token);
      this.ws = new WebSocket(addr);

      // 连上了
      this.ws.onopen = () => {
        this.connected = true;
        // 连上时再拉一次历史：如果是断线重连，这期间别人发的消息就补回来了
        this.loadMessages();
      };

      // 收到服务器转发过来的东西。可能是消息，也可能是人数、正在输入的提示
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // ---------- 情况 1：有人说话了 ----------
        if (msg.type === "message") {
          // 兜底去重：服务器给每条消息都编了唯一 id。
          // 如果这条消息页面上已经有了，就不再添加一次（防止万一连了两条线时显示重复）
          if (this.messages.some((m) => m.id === msg.id)) return;

          this.messages.push(msg);
          this.showTyping("");   // 话都说出来了，"正在输入"就可以撤掉了
          this.scrollToBottom();
          this.markRead();       // 我看到了最新消息，告诉服务器我读到这里了

          // 别人发来的才提醒，自己发的不用吵自己
          if (msg.sender_name !== this.myName) {
            this.notifyNewMessage();
          }
          return;
        }

        // ---------- 情况 2：服务器报告在线人数 ----------
        if (msg.type === "online") {
          this.onlineCount = msg.count;
          return;
        }

        // ---------- 情况 3：有人撤回了消息 ----------
        if (msg.type === "recall") {
          const target = this.messages.find((m) => m.id === msg.id);
          if (target) {
            target.recalled = 1;   // 内容不变，只是加个"已撤回"的标记
          }
          return;
        }

        // ---------- 情况 4：房间被创建者解散了 ----------
        if (msg.type === "dismissed") {
          alert("这个房间被创建者解散了");
          this.leaveRoom();   // 关掉连接退回房间列表
          return;
        }

        // ---------- 情况 5：服务器广播了大家的已读进度 ----------
        if (msg.type === "read") {
          this.reads = msg.reads || {};
          return;
        }

        // ---------- 情况 6：有人正在输入 ----------
        if (msg.type === "typing") {
          this.showTyping(msg.sender_name, msg.avatar || "");
        }
      };

      // 断线了
      this.ws.onclose = (event) => {
        this.connected = false;

        // 1008 是服务器主动把我们踢掉：通常是凭证失效了（比如服务器重启过），
        // 也可能是被判定成"不是这个房间的成员"。
        // 这种情况下重连一万次也没用，直接让他重新登录，别干等着
        if (event.code === 1008) {
          this.onTokenDead();
          return;
        }

        // 3 秒后自己重连，不用用户手动刷新页面。
        // 用变量记住这个定时器，下次重连前可以取消掉，避免同时排好几个重连
        this.reconnectTimer = setTimeout(() => {
          if (this.currentRoom) this.connect();
        }, 3000);
      };
    },

    sendMessage(event) {
      // 用中文输入法打字时，按回车是在"选词"，这时候不应该把还没打完的字发出去
      if (event && event.isComposing) return;

      const text = this.inputText.trim();
      if (!text || !this.ws) return;

      // 只把内容发过去就行。
      // 发送者是谁、头像是什么，服务器会用登录凭证自己查，
      // 不信前端传的名字，这样别人就冒名不了
      this.ws.send(JSON.stringify({
        type: "message",     // 告诉服务器：这是一条真正的消息
        content: text,
      }));

      this.inputText = "";
    },

    // 选头像：点一下就换，同时存到浏览器里
    pickAvatar(emoji) {
      this.myAvatar = emoji;
      localStorage.setItem("chat_avatar", emoji);
    },

    // ---------- "正在输入" ----------

    // 输入框里每敲一个字都会走到这里（index.html 里用 @input 绑的）
    // 顺便把输入框的内容同步到 inputText —— 这就是 v-model 背后做的事，
    // 拆开写是为了保证"打字"和"通知别人"这两件事一定会同时发生
    onInput(event) {
      this.inputText = event.target.value;
      this.notifyTyping();
    },

    notifyTyping() {
      // 每敲一个字都发一次太浪费，最多 1.5 秒发一次就够了
      const now = Date.now();
      if (now - this.lastTypingAt < 1500) return;
      this.lastTypingAt = now;

      // readyState === 1 表示这条线是通的，通了才发
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({
          type: "typing",
        }));
      }
    },

    showTyping(name, avatar) {
      // 显示"某某正在输入"。3 秒后自动消失，
      // 因为对方可能打完就发出去了、也可能打一半走了，这个提示不能一直挂着
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

    // ---------- 新消息提醒 ----------

    toggleSound() {
      this.soundOn = !this.soundOn;
      localStorage.setItem("chat_sound", this.soundOn ? "1" : "0");
    },

    // 提醒分两部分：响一声 + 页面被切到后台时改标题
    notifyNewMessage() {
      if (this.soundOn) this.playSound();

      // document.hidden 表示"这个页面现在被切到后台了"，
      // 这时候就算消息到了用户也看不见，所以把标题改一下提醒他
      if (document.hidden) {
        document.title = "🔔 有新消息 - 轻量聊天室";
        setTimeout(() => {
          document.title = "轻量聊天室";
        }, 5000);
      }
    },

    // 用代码合成一声"叮"，不需要准备任何音频文件。
    // 原理是让浏览器现场生成一个固定频率的声音，响 0.3 秒就停
    playSound() {
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();   // 发声的东西
        const gain = ctx.createGain();        // 控制音量

        osc.frequency.value = 880;            // 音调高低
        // 声音从 0.1 慢慢降到接近 0，听起来就是"叮——"的一下，不会突兀
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(ctx.destination);        // 接到扬声器
        osc.start();
        osc.stop(ctx.currentTime + 0.3);      // 响 0.3 秒就停
      } catch (e) {
        // 浏览器可能因为"还没跟页面交互过"不让发声，这种情况下静音就好，
        // 不能因为响不了就让整个程序报错
      }
    },

    // ---------- 显示相关的小工具 ----------

    scrollToBottom() {
      // $nextTick = 等 Vue 把新消息画到页面上之后，再执行滚动
      // 不等的话，页面还没变高，滚不到真正的底部
      this.$nextTick(() => {
        const el = this.$refs.msgList;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  },
}).mount("#app");
