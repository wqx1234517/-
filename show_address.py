"""双击「查我的地址.bat」时会跑这个脚本：把聊天室的电脑地址、手机地址打出来。

为什么单独写一个 py 而不全塞进 bat 里：
bat 处理中文和字符串很别扭，Python 写起来清楚，而且只用自带功能（不用装任何包）。
"""

import socket
import subprocess
import sys

# 让 Windows 命令行能正确显示中文（不然会变成乱码）
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def get_port():
    """从 config.py 里读端口号，读不到就用 8000。
    这样你改了 config.py 的端口，这里显示的地址也跟着变。"""
    try:
        import config
        return getattr(config, "PORT", 8000)
    except Exception:
        return 8000


def get_main_ip():
    """查出"电脑连网用的那个地址"。

    原理：假装要给外网发个包（其实一个字节都没真发出去），
    问操作系统"你会用哪个网卡发"，那个网卡的地址就是我们要的。
    比从 ipconfig 一大堆信息里猜要准得多。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return ""
    finally:
        s.close()


def get_all_ips():
    """把 ipconfig 里所有 IPv4 地址都列出来（ipconfig 输出是中文，要用 gbk 解码）"""
    try:
        out = subprocess.run(["ipconfig"], capture_output=True).stdout.decode("gbk", errors="ignore")
    except Exception:
        return []

    ips = []
    for line in out.split("\n"):
        if "IPv4" in line:
            ip = line.split(":")[-1].strip()
            if ip and ip not in ips:
                ips.append(ip)
    return ips


def is_virtual(ip):
    """判断是不是虚拟机/软件造出来的假网卡地址（这些手机连不上）"""
    return ip.startswith("192.168.56.") or ip.startswith("10.0.75.") or ip.startswith("172.17.")


def copy_to_clipboard(text):
    """把地址塞进剪贴板，直接 Ctrl+V 就能粘（Windows 自带的 clip 命令）"""
    try:
        subprocess.run("clip", input=text, text=True, encoding="utf-8", shell=True)
        return True
    except Exception:
        return False


def main():
    port = get_port()
    main_ip = get_main_ip()
    all_ips = get_all_ips()

    print()
    print("=" * 52)
    print("  聊天室地址")
    print("=" * 52)
    print()
    print("  【电脑自己用】—— 换什么网都不变")
    print("     http://127.0.0.1:%d" % port)
    print()

    if main_ip:
        mobile = "http://%s:%d" % (main_ip, port)
        print("  【手机用】—— 手机要和电脑连同一个 WiFi")
        print("     %s" % mobile)
        if copy_to_clipboard(mobile):
            print("     （已经复制到剪贴板了，直接 Ctrl+V 粘就行）")
        print()
    else:
        print("  【手机用】没查到地址：电脑是不是没连网？")
        print()

    others = [ip for ip in all_ips if ip != main_ip]
    if others:
        print("  其他网卡的地址（一般是虚拟机用的，手机连不上）：")
        for ip in others:
            mark = "虚拟机" if is_virtual(ip) else ""
            print("     http://%s:%d   %s" % (ip, port, mark))
        print()

    print("-" * 52)
    print("  手机打不开的话，按顺序检查这 4 条：")
    print("   1. 服务器那个黑窗口还开着吗？（关了服务就停了）")
    print("   2. 手机和电脑连的是同一个 WiFi 吗？")
    print("   3. 地址前面的 http:// 有没有漏掉？")
    print("   4. 防火墙放行 %d 端口了吗？" % port)
    print("=" * 52)
    print()


if __name__ == "__main__":
    main()
