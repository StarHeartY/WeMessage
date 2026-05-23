import json
import os
import sys
import subprocess
import requests
import time
from win11toast import toast

# ================= [ WeMessage 客户端配置 ] =================
GATEWAY_URL = "http://127.0.0.1:5031/api/v1/push/messages"
APP_ID = "微信"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICO_PATH = os.path.join(SCRIPT_DIR, "Weixin.ico")
WEIXIN_PNG = os.path.join(SCRIPT_DIR, "Weixin.png")
# win11toast icon 参数需要 file:/// 格式的本地路径
WEIXIN_ICON_URL = "file:///" + WEIXIN_PNG.replace("\\", "/")


def setup_shortcut():
    """首次运行时在 Start Menu 创建快捷方式，使通知显示 WeMessage 图标"""
    start_menu = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs", "WeMessage")
    shortcut_path = os.path.join(start_menu, "WeMessage.lnk")

    if os.path.exists(shortcut_path):
        return

    if not os.path.exists(ICO_PATH):
        print("[WeMessage] 未找到 Weixin.ico，跳过图标注册（不影响使用）")
        return

    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable

    ps = (
        "$dir = New-Item -ItemType Directory -Force -Path '{0}'\n"
        "$sc = (New-Object -ComObject WScript.Shell).CreateShortcut('{1}')\n"
        "$sc.TargetPath = '{2}'\n"
        "$sc.Arguments = '\"{3}\"'\n"
        "$sc.WorkingDirectory = '{4}'\n"
        "$sc.IconLocation = '{5}'\n"
        "$sc.Save()\n"
    ).format(
        start_menu.replace("'", "''"),
        shortcut_path.replace("'", "''"),
        pythonw.replace("'", "''"),
        __file__.replace("'", "''"),
        SCRIPT_DIR.replace("'", "''"),
        ICO_PATH.replace("'", "''")
    )

    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            capture_output=True, text=True, timeout=10
        )
        if os.path.exists(shortcut_path):
            print("[WeMessage] 已注册 WeMessage 通知图标")
    except Exception as e:
        print(f"[WeMessage] 图标注册失败（不影响通知功能）: {e}")


def handle_message(msg_data):
    """处理网关推过来的明文消息数据"""
    try:
        if isinstance(msg_data, str):
            data = json.loads(msg_data)
        else:
            data = msg_data

        content = data.get("content", "")
        source_name = data.get("sourceName", "")
        group_name = data.get("groupName", "")
        avatar_url = data.get("avatarUrl", "")

        if not content and not source_name:
            return

        if group_name:
            title = f"《{group_name}》 {source_name}"
        else:
            title = source_name

        print(f"[WeMessage]: {title} -> {content}")

        toast_kwargs = {
            "title": title,
            "body": content,
            "duration": "short",
            "app_id": APP_ID,
            "icon": WEIXIN_ICON_URL,
        }

        toast(**toast_kwargs)

    except Exception as e:
        print(f"❌ 解析消息并弹窗时发生错误: {e}")


def start_listen():
    """通过 SSE 协议长连接订阅 WeMessage 网关的消息流"""
    print("=" * 54)
    print("  WeMessage 微信 通知助手 (Python端) ")
    print("=" * 54)
    print("Snakes 正在尝试接入 WeMessage 离线网关通道...")

    setup_shortcut()

    while True:
        try:
            response = requests.get(GATEWAY_URL, stream=True, timeout=None)

            if response.status_code == 200:
                print("[OK] 成功接入 WeMessage 网关! 开始在后台守候微信新消息...")

                for line in response.iter_lines():
                    if not line:
                        continue

                    line_str = line.decode('utf-8').strip()

                    if line_str.startswith("data:"):
                        data_body = line_str[5:].strip()

                        if '"success":true' in data_body:
                            continue

                        handle_message(data_body)
            else:
                print(f"❌ 网关响应异常，状态码: {response.status_code}")
                time.sleep(5)

        except (requests.exceptions.RequestException, Exception) as e:
            print(f"⚠️ 无法连接到 WeMessage 网关服务: {e}。5秒后将自动尝试重连...")
            time.sleep(5)


if __name__ == "__main__":
    start_listen()
