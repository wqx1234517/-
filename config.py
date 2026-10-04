import os

# 拿到当前这个文件所在的文件夹路径。
# 为什么不用写死的 "D:\d项目\chat_room"？
# 因为换一台电脑、换一个位置放项目，写死的路径就失效了；
# 用 __file__ 自动推算，项目搬到哪里都能正常运行。
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 页面文件放在哪：项目目录下的 static 文件夹
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 数据库文件放在哪：项目目录下的 chat.db（下一步才会用到，先占好位置）
DB_PATH = os.path.join(BASE_DIR, "chat.db")

# 网站跑在哪个端口。8000 是 Python 项目常用的端口。
# 改这里就行（改完重启服务器生效），不用去动 start.bat
PORT = 8000

# 监听地址。127.0.0.1 表示只有本机（这台电脑）能访问；
# 0.0.0.0 表示同一个 WiFi 下的手机、平板也能访问。
# 后面要做手机访问，所以直接用 0.0.0.0
HOST = "0.0.0.0"
