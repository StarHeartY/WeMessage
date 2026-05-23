const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ================= [ 1. 读取并解析 config.json 配置文件 ] =================
const configPath = path.resolve(__dirname, './config.json');
let CONFIG = {};

try {
    if (!fs.existsSync(configPath)) {
        console.error('❌ [WeMessage 错误] 未能在项目根目录下找到 config.json 配置文件！');
        console.error('👉 请先创建 config.json 并填入您的 ACCOUNT_DIR 和 HEX_KEY。');
        process.exit(1);
    }

    CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    CONFIG.PORT = CONFIG.PORT || 5031;
    CONFIG.HOST = CONFIG.HOST || '127.0.0.1';
    CONFIG.RESOURCES_PATH = path.resolve(__dirname, './resources');

    if (!CONFIG.ACCOUNT_DIR || !CONFIG.HEX_KEY) {
        console.error('❌ [WeMessage 错误] config.json 中的 ACCOUNT_DIR 或 HEX_KEY 不能为空！');
        process.exit(1);
    }
} catch (err) {
    console.error('❌ [WeMessage 错误] 解析 config.json 配置文件时发生异常:', err.message);
    process.exit(1);
}

// 从账号目录名提取自己的 wxid
const accountDirName = path.basename(CONFIG.ACCOUNT_DIR);
const SELF_WXID = (() => {
    if (accountDirName.toLowerCase().startsWith('wxid_')) {
        const match = accountDirName.match(/^(wxid_[^_]+)/i);
        return match ? match[1] : accountDirName;
    }
    const suffixMatch = accountDirName.match(/^(.+)_([a-zA-Z0-9]{4})$/);
    return suffixMatch ? suffixMatch[1] : accountDirName;
})();
console.log(`[WeMessage] 自身 wxid: ${SELF_WXID}`);

// ================= [ 2a. 启动 WCDB C 代理进程 ] =================
const proxyExePath = path.resolve(__dirname, './WeFlow.exe');
const proxyProcess = spawn(proxyExePath, [
    '--port', '5037',
    '--resources', CONFIG.RESOURCES_PATH
], {
    stdio: 'pipe',
    windowsHide: true
});

proxyProcess.stderr.on('data', (data) => {
    const text = data.toString('utf8');
    process.stderr.write(`[proxy] ${text}`);
    // 等待代理就绪信号
    if (text.includes('READY')) {
        console.log('[WeMessage] C 代理进程已就绪');
        startWorker();
    }
});

proxyProcess.on('error', (err) => {
    console.error('[WeMessage] 无法启动 C 代理进程:', err.message);
    console.error('请确保 WeFlow.exe 存在于项目根目录');
    process.exit(1);
});

proxyProcess.on('exit', (code) => {
    console.log(`[WeMessage] C 代理进程已退出 (code=${code})`);
});

// 主进程退出时清理代理
process.on('exit', () => {
    try { proxyProcess.kill(); } catch {}
});
process.on('SIGINT', () => {
    try { proxyProcess.kill(); } catch {}
    process.exit();
});
process.on('SIGTERM', () => {
    try { proxyProcess.kill(); } catch {}
    process.exit();
});

// ================= [ 2b. 启动 WCDB Worker 线程 ] =================
const workerPath = path.resolve(__dirname, './wcdbProxy.js');
let worker = null;

// 消息 ID 追踪
let messageId = 10;
const pending = new Map();

function callWorker(type, payload = {}) {
    return new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, type, payload });
    });
}

// 消息处理状态
let baselineReady = false;
const sessionBaseline = new Map();
const recentMessageKeys = new Set();
let debounceTimer = null;
const debounceMs = 500;
let processing = false;

// 监听 Worker 传上来的事件（延迟到 startWorker 中设置）
function startWorker() {
    worker = new Worker(workerPath);

    worker.on('message', (msg) => {
    const { id, type, payload, result, error } = msg;

    // A. 管道监控事件：数据库有变化
    if (type === 'monitor' && payload) {
        console.log(`\n🔔 [管道通知] action=${payload.type}`);
        scheduleSync();
        return;
    }

    // B. 处理 Promise 响应
    if (pending.has(id)) {
        const p = pending.get(id);
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve(result);
        return;
    }

    // C. 初始化阶段的回执处理
    if (id === 1) {
        // setPaths 回执
        if (error || (result && result.success === false)) {
            console.error('❌ [WeMessage] 基础路径配置注入失败:', error || result);
            process.exit(1);
        } else {
            console.log('📅 [WeMessage] 基础路径配置注入成功，底层驱动已就绪。');
        }
    }

    if (id === 2) {
        // open 回执
        if (error || (result && result.success === false)) {
            console.error('\n❌ [WeMessage 严重错误] 微信数据库底层解密失败！！');
            console.error('👉 原因可能是：config.json 里填写的 HEX_KEY 已失效，或者 ACCOUNT_DIR 路径有误。');
            console.error('详细错误回执:', error || result);
            process.exit(1);
        } else {
            console.log('\n🎉 [WeMessage 关键突破] 微信数据库已成功完成底层解密并打开！！');
            console.log('🛰️  正在挂载命名管道实时监听流...');
            worker.postMessage({ id: 3, type: 'setMonitor' });
        }
    }

    if (id === 3) {
        // setMonitor 回执
        if (result && result.success) {
            console.log('🚀 [WeMessage] 实时监听流已就位，网关开始全天候守护微信消息...\n');
            // 初始化基线
            bootstrapBaseline();
        } else {
            console.error('❌ [WeMessage] 监听流挂载失败。');
        }
    }
});

worker.on('error', (err) => {
    console.error('❌ [WeMessage] 底层线程发生严重错误:', err);
});

// 启动本地网关 → 链式点火
server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log('⚙️ [WeMessage] 正在从 config.json 读取配置并初始化核心驱动...');

    // 第一发：注入路径
    worker.postMessage({
        id: 1,
        type: 'setPaths',
        payload: {
            resourcesPath: CONFIG.RESOURCES_PATH,
            userDataPath: CONFIG.ACCOUNT_DIR
        }
    });

    // 第二发：解密开锁
    console.log('🔑 [WeMessage] 正在尝试使用密钥解密并打开微信数据库...');
    worker.postMessage({
        id: 2,
        type: 'open',
        payload: {
            accountDir: CONFIG.ACCOUNT_DIR,
            hexKey: CONFIG.HEX_KEY
        }
    });
});
}

// ================= [ 3. 消息同步逻辑 ] =================

function scheduleSync() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => flushChanges(), debounceMs);
}

async function bootstrapBaseline() {
    try {
        const result = await callWorker('getSessions');
        if (result.success && result.sessions) {
            for (const s of result.sessions) {
                sessionBaseline.set(s.username, {
                    lastTimestamp: Number(s.last_timestamp || 0),
                    unreadCount: Number(s.unread_count || 0)
                });
            }
            baselineReady = true;
            console.log(`[WeMessage] 基线已建立，共 ${sessionBaseline.size} 个会话`);
        }
    } catch (e) {
        console.error('[WeMessage] 建立基线失败:', e.message);
    }
}

async function flushChanges() {
    if (processing) return;
    processing = true;

    try {
        const result = await callWorker('getSessions');
        if (!result.success || !result.sessions) return;

        const sessions = result.sessions;
        if (!baselineReady) {
            for (const s of sessions) {
                sessionBaseline.set(s.username, {
                    lastTimestamp: Number(s.last_timestamp || 0),
                    unreadCount: Number(s.unread_count || 0)
                });
            }
            baselineReady = true;
            return;
        }

        // 找有变化的会话
        const changed = sessions.filter(s => {
            const prev = sessionBaseline.get(s.username);
            if (!prev) {
                // 新会话
                if (Number(s.last_timestamp || 0) > 0 || Number(s.unread_count || 0) > 0) {
                    return true;
                }
                return false;
            }
            return Number(s.last_timestamp || 0) > prev.lastTimestamp ||
                   Number(s.unread_count || 0) !== prev.unreadCount;
        });

        console.log(`[WeMessage] 检测到 ${changed.length} 个有变化的会话`);

        // 批量获取变化会话的显示名
        let displayNames = {};
        if (changed.length > 0) {
            try {
                const usernames = changed.map(s => s.username);
                const dnResult = await callWorker('getDisplayNames', { usernames });
                if (dnResult.success && dnResult.map) {
                    displayNames = dnResult.map;
                }
            } catch {}
        }

        for (const s of changed) {
            const prev = sessionBaseline.get(s.username);
            const since = prev ? Math.max(0, prev.lastTimestamp - 2) : 0;
            const displayName = displayNames[s.username] || s.last_sender_display_name || s.username;

            try {
                const msgResult = await callWorker('getNewMessages', {
                    sessionId: s.username,
                    minTime: since,
                    limit: 200
                });

                if (!msgResult.success || !msgResult.messages || msgResult.messages.length === 0) {
                    // 更新基线
                    sessionBaseline.set(s.username, {
                        lastTimestamp: Math.max(Number(s.last_timestamp || 0), prev?.lastTimestamp || 0),
                        unreadCount: Number(s.unread_count || 0)
                    });
                    continue;
                }

                // 过滤已处理、自己发送、系统消息
                const newMessages = msgResult.messages.filter(msg => {
                    const key = `${msg.local_id || ''}`;
                    if (recentMessageKeys.has(key)) return false;
                    if (msg.sender_username === SELF_WXID) return false;
                    if (Number(msg.local_type || 0) === 10000) return false;
                    return true;
                });

                for (const msg of newMessages) {
                    const key = `${msg.local_id || ''}`;
                    recentMessageKeys.add(key);

                    const isGroup = String(s.username || '').endsWith('@chatroom');
                    const payload = {
                        event: 'message.new',
                        sessionId: s.username,
                        sessionType: isGroup ? 'group' : 'private',
                        sourceName: isGroup ? (msg.sender_username || '未知') : displayName,
                        groupName: isGroup ? displayName : '',
                        content: getMessageContent(msg),
                        timestamp: Number(msg.create_time || 0)
                    };

                    console.log(`📩 [新消息] ${payload.groupName ? '[' + payload.groupName + '] ' : ''}${payload.sourceName}: ${payload.content}`);
                    broadcastToPython('message.new', payload);
                }

                // 清理旧 key
                if (recentMessageKeys.size > 10000) {
                    const arr = [...recentMessageKeys];
                    recentMessageKeys.clear();
                    for (const k of arr.slice(-5000)) recentMessageKeys.add(k);
                }
            } catch (e) {
                console.error(`[WeMessage] 查询会话 ${s.username} 新消息失败:`, e.message);
            }

            // 更新基线
            sessionBaseline.set(s.username, {
                lastTimestamp: Math.max(Number(s.last_timestamp || 0), prev?.lastTimestamp || 0),
                unreadCount: Number(s.unread_count || 0)
            });
        }

        // 更新未变化会话的基线（时间戳可能不准确但保持跟踪）
        for (const s of sessions) {
            if (!sessionBaseline.has(s.username)) {
                sessionBaseline.set(s.username, {
                    lastTimestamp: Number(s.last_timestamp || 0),
                    unreadCount: Number(s.unread_count || 0)
                });
            }
        }
    } catch (e) {
        console.error('[WeMessage] flushChanges 异常:', e.message);
    } finally {
        processing = false;
    }
}

function getMessageContent(msg) {
    switch (Number(msg.local_type || 0)) {
        case 1: return msg.message_content || '';
        case 3: return '[图片]';
        case 34: return '[语音]';
        case 43: return '[视频]';
        case 47: return '[表情]';
        case 42: return msg.card_nickname || msg.cardNickname || '[名片]';
        case 48: return '[位置]';
        case 49: return msg.link_title || msg.linkTitle || msg.file_name || msg.fileName || '[消息]';
        default: return msg.message_content || '[消息]';
    }
}

// ================= [ 4. 维护 SSE 客户端连接池 ] =================
const pythonClients = new Set();

function broadcastToPython(eventType, jsonData) {
    const sseMessage = `event: ${eventType}\ndata: ${JSON.stringify(jsonData)}\n\n`;
    for (const res of pythonClients) {
        try {
            res.write(sseMessage);
        } catch {
            pythonClients.delete(res);
        }
    }
}

// ================= [ 5. 搭建极简本地 HTTP 网关 ] =================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    const url = new URL(req.url || '/', `http://${CONFIG.HOST}:${CONFIG.PORT}`);

    if (url.pathname === '/api/v1/push/messages') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        pythonClients.add(res);
        res.write(`event: ready\ndata: {"success":true}\n\n`);
        console.log('🔌 [WeMessage] Python 通知客户端已成功接入网关通道！');

        const cleanup = () => pythonClients.delete(res);
        req.on('close', cleanup);
        res.on('close', cleanup);
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});
