const { parentPort } = require('worker_threads');
const net = require('net');
const path = require('path');
const fs = require('fs');

// ==================== 状态 ====================
let resourcesPath = null;
let initialized = false;
let handle = null;
let currentPath = null;
let currentKey = null;

// TCP 客户端
let client = null;
let recvBuffer = '';
let pendingRequests = new Map();
let messageId = 0;
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 5037;

// 命名管道监控
let monitorPipeClient = null;
let monitorCallback = null;
let monitorReconnectTimer = null;
let monitorPipePath = '';

// ==================== 诊断日志 ====================
const diagLogPath = path.join(__dirname, 'worker_diag.log');
function diagLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(msg);
    try { fs.appendFileSync(diagLogPath, line + '\n'); } catch {}
}
function diagErr(msg) {
    const line = `[${new Date().toISOString()}] ERROR: ${msg}`;
    console.error(msg);
    try { fs.appendFileSync(diagLogPath, line + '\n'); } catch {}
}

// ==================== TCP 客户端 ====================

function connectProxy() {
    return new Promise((resolve, reject) => {
        client = net.createConnection({ host: PROXY_HOST, port: PROXY_PORT }, () => {
            diagLog('[wcdbProxy] Connected to C proxy');
            resolve();
        });

        client.on('data', (data) => {
            recvBuffer += data.toString('utf8');
            /* 按换行分割 JSON 消息 */
            let idx;
            while ((idx = recvBuffer.indexOf('\n')) !== -1) {
                const line = recvBuffer.slice(0, idx);
                recvBuffer = recvBuffer.slice(idx + 1);
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (pendingRequests.has(msg.id)) {
                        const p = pendingRequests.get(msg.id);
                        pendingRequests.delete(msg.id);
                        diagLog(`[wcdbProxy] callProxy <- id=${msg.id} ok=${msg.ok} ret=${msg.ret}`);
                        p.resolve(msg);
                    } else {
                        diagLog(`[wcdbProxy] callProxy <- id=${msg.id} (no pending request, ignored)`);
                    }
                } catch (e) {
                    diagErr(`[wcdbProxy] Failed to parse response: ${line}`);
                }
            }
        });

        client.on('error', (err) => {
            diagErr(`[wcdbProxy] TCP error: ${err.message}`);
            reject(err);
        });

        client.on('close', () => {
            diagLog('[wcdbProxy] TCP connection closed');
            client = null;
            /* 拒绝所有等待中的请求 */
            for (const [id, p] of pendingRequests) {
                pendingRequests.delete(id);
                p.reject(new Error('Proxy connection closed'));
            }
        });
    });
}

async function callProxy(method, params = []) {
    if (!client) {
        throw new Error('Not connected to proxy');
    }
    const id = ++messageId;
    const request = JSON.stringify({ id, method, params }) + '\n';
    diagLog(`[wcdbProxy] callProxy -> id=${id} method=${method}`);

    return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        try {
            client.write(request);
        } catch (e) {
            pendingRequests.delete(id);
            diagErr(`[wcdbProxy] callProxy write error id=${id}: ${e.message}`);
            reject(e);
        }
    });
}

// ==================== 工具函数 ====================

function cleanAccountDirName(dirName) {
    const trimmed = dirName.trim();
    if (!trimmed) return trimmed;
    if (trimmed.toLowerCase().startsWith('wxid_')) {
        const match = trimmed.match(/^(wxid_[^_]+)/i);
        if (match) return match[1];
        return trimmed;
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/);
    if (suffixMatch) return suffixMatch[1];
    return trimmed;
}

function findSessionDb(dir, depth = 0) {
    if (depth > 5) return null;
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (entry.toLowerCase() === 'session.db') {
                const fullPath = path.join(dir, entry);
                if (fs.statSync(fullPath).isFile()) return fullPath;
            }
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            try {
                if (fs.statSync(fullPath).isDirectory()) {
                    const found = findSessionDb(fullPath, depth + 1);
                    if (found) return found;
                }
            } catch {}
        }
    } catch {}
    return null;
}

// ==================== 初始化 ====================

async function initialize() {
    if (initialized) return true;
    diagLog('[wcdbProxy] === initialize() ===');

    try {
        /* 调用 InitProtection */
        diagLog(`[wcdbProxy] Calling init_protection: ${resourcesPath}`);
        const protResp = await callProxy('init_protection', [resourcesPath]);
        diagLog(`[wcdbProxy] init_protection result: ${JSON.stringify(protResp)}`);

        if (protResp.ok === false) {
            diagErr(`[wcdbProxy] InitProtection failed: ${protResp.error}`);
            return false;
        }
        if (protResp.ret !== 0) {
            diagErr(`[wcdbProxy] InitProtection returned non-zero: ${protResp.ret}`);
            return false;
        }

        /* 调用 wcdb_init */
        diagLog('[wcdbProxy] Calling wcdb_init...');
        const initResp = await callProxy('wcdb_init', []);
        diagLog(`[wcdbProxy] wcdb_init result: ${JSON.stringify(initResp)}`);

        if (initResp.ok === false) {
            diagErr(`[wcdbProxy] wcdb_init failed: ${initResp.error}`);
            return false;
        }
        if (initResp.ret !== 0) {
            const extra = initResp.logs ? ` logs=${initResp.logs}` : '';
            diagErr(`[wcdbProxy] wcdb_init returned ${initResp.ret} (0x${(initResp.ret >>> 0).toString(16)})${extra}`);
            return false;
        }

        diagLog('[wcdbProxy] wcdb_init succeeded');
        initialized = true;
        return true;
    } catch (e) {
        diagErr(`[wcdbProxy] initialize exception: ${e.message || e}\n${e.stack || ''}`);
        return false;
    }
}

// ==================== 打开数据库 ====================

async function open(accountDir, hexKey) {
    try {
        if (!initialized) {
            const initOk = await initialize();
            if (!initOk) return false;
        }

        if (handle !== null && currentPath === accountDir && currentKey === hexKey) {
            diagLog('[wcdbProxy] Database already open with same params, skipping');
            return true;
        }

        if (handle !== null) {
            await close();
            const initOk = await initialize();
            if (!initOk) return false;
        }

        const dbStoragePath = path.join(accountDir, 'db_storage');
        diagLog(`[wcdbProxy] accountDir=${accountDir}`);
        diagLog(`[wcdbProxy] dbStoragePath=${dbStoragePath}`);

        if (!dbStoragePath || !fs.existsSync(dbStoragePath)) {
            diagErr(`[wcdbProxy] Database directory not found: ${accountDir}`);
            return false;
        }

        const sessionDbPath = findSessionDb(dbStoragePath);
        diagLog(`[wcdbProxy] sessionDbPath=${sessionDbPath || 'not found'}`);

        if (!sessionDbPath) {
            diagErr('[wcdbProxy] session.db not found');
            return false;
        }

        const resp = await callProxy('wcdb_open_account', [sessionDbPath, hexKey]);
        diagLog(`[wcdbProxy] wcdb_open_account result: ${JSON.stringify(resp)}`);

        if (resp.ok === false) {
            diagErr(`[wcdbProxy] wcdb_open_account failed: ${resp.error}`);
            return false;
        }
        if (resp.ret !== 0) {
            diagErr(`[wcdbProxy] wcdb_open_account returned ${resp.ret}`);
            return false;
        }

        const h = resp.handle;
        if (!h || h <= 0) {
            diagErr('[wcdbProxy] Invalid database handle');
            return false;
        }

        handle = h;
        currentPath = accountDir;
        currentKey = hexKey;
        diagLog(`[wcdbProxy] Database opened, handle=${handle}`);
        return true;
    } catch (e) {
        diagErr(`[wcdbProxy] open exception: ${e.message || e}`);
        return false;
    }
}

// ==================== 关闭数据库 ====================

async function close() {
    stopMonitor();
    if (handle !== null || initialized) {
        try {
            if (handle !== null) {
                await callProxy('wcdb_close_account', [handle]);
            }
            await callProxy('wcdb_shutdown', []);
        } catch (e) {
            diagErr(`[wcdbProxy] close exception: ${e.message}`);
        }
        handle = null;
        currentPath = null;
        currentKey = null;
        initialized = false;
    }
}

// ==================== 命名管道监控 ====================

function connectMonitorPipe(pipePath) {
    monitorPipePath = pipePath;

    setTimeout(() => {
        if (!monitorCallback) return;

        diagLog(`[wcdbProxy] Connecting to named pipe: ${monitorPipePath}`);
        monitorPipeClient = net.createConnection(monitorPipePath, () => {
            diagLog(`[wcdbProxy] Named pipe connected: ${monitorPipePath}`);
        });

        let buffer = '';
        monitorPipeClient.on('data', (data) => {
            const rawChunk = data.toString('utf8');
            const normalizedChunk = rawChunk
                .replace(/\x00/g, '\n')
                .replace(/}\s*\{/g, '}\n{');

            buffer += normalizedChunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const parsed = JSON.parse(line);
                        const action = parsed.action || 'update';
                        diagLog(`[wcdbProxy] Pipe data: action=${action}`);
                        monitorCallback(action, line);
                    } catch {
                        monitorCallback('update', line);
                    }
                }
            }

            const tail = buffer.trim();
            if (tail.startsWith('{') && tail.endsWith('}')) {
                try {
                    const parsed = JSON.parse(tail);
                    monitorCallback(parsed.action || 'update', tail);
                    buffer = '';
                } catch {}
            }
        });

        monitorPipeClient.on('error', () => {
            /* 静默处理管道错误 */
        });

        monitorPipeClient.on('close', () => {
            diagLog('[wcdbProxy] Named pipe disconnected');
            monitorPipeClient = null;
            scheduleReconnect();
        });
    }, 100);
}

function scheduleReconnect() {
    if (monitorReconnectTimer || !monitorCallback) return;
    diagLog('[wcdbProxy] Scheduling pipe reconnect in 3s...');
    monitorReconnectTimer = setTimeout(() => {
        monitorReconnectTimer = null;
        if (monitorCallback && !monitorPipeClient) {
            connectMonitorPipe(monitorPipePath);
        }
    }, 3000);
}

async function startMonitor(callback) {
    monitorCallback = callback;
    try {
        const resp = await callProxy('wcdb_start_monitor_pipe', []);
        diagLog(`[wcdbProxy] wcdb_start_monitor_pipe result: ${JSON.stringify(resp)}`);

        if (resp.ok === false || resp.ret !== 0) {
            diagErr('[wcdbProxy] Failed to start monitor pipe');
            return false;
        }

        const pipePath = resp.pipePath || '\\\\.\\pipe\\weflow_monitor';
        diagLog(`[wcdbProxy] Pipe path: ${pipePath}`);
        connectMonitorPipe(pipePath);
        return true;
    } catch (e) {
        diagErr(`[wcdbProxy] startMonitor exception: ${e.message || e}`);
        return false;
    }
}

function stopMonitor() {
    monitorCallback = null;
    if (monitorReconnectTimer) {
        clearTimeout(monitorReconnectTimer);
        monitorReconnectTimer = null;
    }
    if (monitorPipeClient) {
        monitorPipeClient.destroy();
        monitorPipeClient = null;
    }
    /* 异步调用停止监控，不等待结果 */
    if (client) {
        callProxy('wcdb_stop_monitor_pipe', []).catch(() => {});
    }
}

// ==================== 数据查询 ====================

function parseJsonResult(resp) {
    /* 代理返回格式: {ok: true, ret: 0, json: "..."} */
    if (resp.ok === false) {
        return { success: false, error: resp.error || 'Unknown error' };
    }
    if (resp.ret !== 0) {
        return { success: false, error: `DLL returned ${resp.ret}` };
    }
    if (resp.json !== undefined) {
        try {
            return { success: true, data: resp.json ? JSON.parse(resp.json) : null };
        } catch {
            return { success: true, data: resp.json };
        }
    }
    return { success: true };
}

async function getSessions() {
    if (!handle) return { success: false, error: 'Database not open' };
    diagLog('[wcdbProxy] getSessions() called, handle=' + handle);
    try {
        const resp = await callProxy('wcdb_get_sessions', [handle]);
        diagLog('[wcdbProxy] getSessions() got response, ok=' + resp.ok + ' ret=' + resp.ret);
        const parsed = parseJsonResult(resp);
        if (!parsed.success) {
            diagErr('[wcdbProxy] getSessions() parse failed: ' + (parsed.error || 'unknown'));
            return parsed;
        }
        const count = parsed.data ? (Array.isArray(parsed.data) ? parsed.data.length : 'object') : 0;
        diagLog('[wcdbProxy] getSessions() success, sessions count=' + count);
        return { success: true, sessions: parsed.data || [] };
    } catch (e) {
        diagErr('[wcdbProxy] getSessions() exception: ' + (e.message || e));
        return { success: false, error: String(e.message || e) };
    }
}

async function getNewMessages(sessionId, minTime, limit = 200) {
    if (!handle) return { success: false, error: 'Database not open' };
    try {
        /* 打开游标 */
        const openResp = await callProxy('wcdb_open_message_cursor',
            [handle, sessionId, limit, 1, minTime, 0]);
        if (openResp.ok === false || openResp.ret !== 0) {
            return { success: false, error: `Open cursor failed: ${openResp.ret}, cursor=${openResp.cursor}` };
        }
        const cursor = openResp.cursor;
        if (!cursor || cursor <= 0) {
            return { success: false, error: `Invalid cursor: ${cursor}` };
        }

        try {
            /* 获取消息批次 */
            const fetchResp = await callProxy('wcdb_fetch_message_batch', [handle, cursor]);
            const parsed = parseJsonResult(fetchResp);
            if (!parsed.success) return parsed;
            return { success: true, messages: parsed.data || [] };
        } finally {
            /* 关闭游标 */
            await callProxy('wcdb_close_message_cursor', [handle, cursor]).catch(() => {});
        }
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

async function getDisplayNames(usernames) {
    if (!handle) return { success: false, error: 'Database not open' };
    try {
        const jsonInput = JSON.stringify(usernames);
        const resp = await callProxy('wcdb_get_display_names', [handle, jsonInput]);
        const parsed = parseJsonResult(resp);
        if (!parsed.success) return parsed;
        return { success: true, map: parsed.data || {} };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

async function getAvatarUrls(usernames) {
    if (!handle) return { success: false, error: 'Database not open' };
    try {
        const jsonInput = JSON.stringify(usernames);
        const resp = await callProxy('wcdb_get_avatar_urls', [handle, jsonInput]);
        const parsed = parseJsonResult(resp);
        if (!parsed.success) return parsed;
        return { success: true, map: parsed.data || {} };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

// ==================== Worker 消息处理 ====================

if (parentPort) {
    parentPort.on('message', async (msg) => {
        const { id, type, payload } = msg;
        try {
            let result;
            switch (type) {
                case 'setPaths':
                    resourcesPath = payload.resourcesPath;
                    /* userDataPath 在 Node.js 端不再需要，C 代理有自己的路径逻辑 */
                    diagLog(`[wcdbProxy] setPaths: resourcesPath=${resourcesPath}`);
                    result = { success: true };
                    break;

                case 'open':
                    if (!resourcesPath) {
                        result = { success: false, error: 'Call setPaths first' };
                        break;
                    }
                    const openOk = await open(payload.accountDir, payload.hexKey);
                    result = { success: openOk };
                    break;

                case 'setMonitor':
                    if (!handle) {
                        result = { success: false, error: 'Database not open, call open first' };
                        break;
                    }
                    const monitorOk = await startMonitor((action, json) => {
                        parentPort.postMessage({
                            id: -1,
                            type: 'monitor',
                            payload: { type: action, json }
                        });
                    });
                    result = { success: monitorOk };
                    break;

                case 'close':
                    await close();
                    result = { success: true };
                    break;

                case 'getSessions':
                    result = await getSessions();
                    break;

                case 'getNewMessages':
                    result = await getNewMessages(
                        payload.sessionId,
                        payload.minTime || 0,
                        payload.limit || 200
                    );
                    break;

                case 'getDisplayNames':
                    result = await getDisplayNames(payload.usernames || []);
                    break;

                case 'getAvatarUrls':
                    result = await getAvatarUrls(payload.usernames || []);
                    break;

                default:
                    result = { success: false, error: `Unknown operation: ${type}` };
            }

            parentPort.postMessage({ id, result });
        } catch (e) {
            diagErr(`[wcdbProxy] Message handler exception: ${e.message || e}`);
            parentPort.postMessage({ id, error: String(e.message || e) });
        }
    });
}

// ==================== 启动：连接 C 代理 ====================

connectProxy().then(() => {
    diagLog('[wcdbProxy] Ready — connected to C proxy');
}).catch((err) => {
    diagErr(`[wcdbProxy] Failed to connect to C proxy: ${err.message}`);
    diagErr('[wcdbProxy] Make sure WeFlow.exe is running before starting WeMessage.js');
    if (parentPort) {
        /* 通知主线程代理不可用 */
        parentPort.postMessage({ id: -2, type: 'proxy_error', error: err.message });
    }
    process.exit(1);
});
