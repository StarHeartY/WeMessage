# WeMessage

微信消息 Windows 通知助手。通过 WCDB API 监控微信新消息，并通过 Windows 原生通知推送。

本项目基于[WeFlow](https://weflow.top)制作，原项目地址：<https://github.com/hicccc77/WeFlow>

## 工作原理

```
WeChat 本地数据库 → wcdb_api.dll → WeMessage.js (SSE) → main.py → Windows 通知
```

- **WeMessage.js** — Node.js 网关，轮询微信本地数据库，通过 SSE 推送新消息
- **main.py** — Python 客户端，接收 SSE 推送，调用 Windows 原生通知

## 环境要求

- Windows 10/11 x64
- [Node.js](https://nodejs.org/) ≥ 18
- [Python](https://www.python.org/) ≥ 3.10

### Python 依赖

```bash
pip install win11toast requests
```

### Node.js 依赖

```bash
npm install
```

## 配置

在项目根目录创建 `config.json`：

```json
{
  "HEX_KEY": "你的微信密钥",
  "ACCOUNT_PATH": "C:\\Users\\...\\Documents\\WeChat Files\\wxid_xxx"
}
```

## 启动

双击 `Start.bat` 或执行：

```bash
WeFlow.exe WeMessage.js
```

Python 通知端会自动启动。

## 项目结构

| 文件 | 说明 |
|---|---|
| `WeMessage.js` | 主网关，SSE 推送 |
| `wcdbWorker.js` | Worker 线程，DLL 调用 |
| `main.py` | Python 通知客户端 |
| `Start.bat` | 一键启动脚本 |
| `WeFlow.exe` | WeFlow 运行时 |
| `resources/` | 原生 DLL 依赖 |

## 注意事项

- 仅支持 Windows
- 需手动获取微信 HEX_KEY
- `config.json` 含敏感信息，请勿提交或分享
