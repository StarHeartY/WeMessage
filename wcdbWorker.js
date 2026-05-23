const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');

// 诊断日志文件
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

// ==================== 状态 ====================
let resourcesPath = null;
let userDataPath = null;
let initialized = false;
let handle = null;
let currentPath = null;
let currentKey = null;

// koffi 函数引用
let lib = null;
let wcdbInit = null;
let wcdbShutdown = null;
let wcdbOpenAccount = null;
let wcdbCloseAccount = null;
let wcdbFreeString = null;
let wcdbStartMonitorPipe = null;
let wcdbStopMonitorPipe = null;
let wcdbGetMonitorPipeName = null;
let wcdbInitProtection = null;
let wcdbGetSessions = null;
let wcdbGetMessages = null;
let wcdbOpenMessageCursor = null;
let wcdbOpenMessageCursorLite = null;
let wcdbFetchMessageBatch = null;
let wcdbCloseMessageCursor = null;
let wcdbGetDisplayNames = null;
let wcdbGetAvatarUrls = null;

// 命名管道监控
let monitorPipeClient = null;
let monitorCallback = null;
let monitorReconnectTimer = null;
let monitorPipePath = '';

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

function getDllPath() {
    const libName = 'wcdb_api.dll';
    const roots = [
        resourcesPath ? path.join(resourcesPath, 'resources') : null,
        resourcesPath || null,
        path.join(process.cwd(), 'resources'),
        path.join(__dirname, 'resources')
    ].filter(Boolean);

    const relativeCandidates = [
        path.join('wcdb', 'win32', 'x64', libName),
        path.join('wcdb', libName)
    ];

    for (const root of roots) {
        for (const rel of relativeCandidates) {
            const fullPath = path.join(root, rel);
            if (fs.existsSync(fullPath)) return fullPath;
        }
        const directPath = path.join(root, libName);
        if (fs.existsSync(directPath)) return directPath;
    }
    return null;
}

// ==================== 初始化 ====================

async function initialize() {
    if (initialized) return true;
    diagLog('[Worker] === initialize() 开始 ===');
    try {
        const dllPath = getDllPath();
        diagLog(`[Worker] DLL 搜索路径: ${dllPath}`);

        if (!dllPath || !fs.existsSync(dllPath)) {
            diagErr(`[Worker] wcdb_api.dll 未找到！resourcesPath=${resourcesPath}`);
            return false;
        }

        diagLog(`[Worker] 找到 wcdb_api.dll: ${dllPath}`);
        const dllDir = path.dirname(dllPath);
        diagLog(`[Worker] dllDir: ${dllDir}`);

        // 预加载依赖库
        const wcdbCorePath = path.join(dllDir, 'WCDB.dll');
        if (fs.existsSync(wcdbCorePath)) {
            try {
                koffi.load(wcdbCorePath);
                diagLog('[Worker] 预加载 WCDB.dll 成功');
            } catch (e) {
                diagLog(`[Worker] 预加载 WCDB.dll 失败: ${e.message}`);
            }
        }

        const sdl2Path = path.join(dllDir, 'SDL2.dll');
        if (fs.existsSync(sdl2Path)) {
            try {
                koffi.load(sdl2Path);
                diagLog('[Worker] 预加载 SDL2.dll 成功');
            } catch (e) {
                diagLog(`[Worker] 预加载 SDL2.dll 失败: ${e.message}`);
            }
        }

        // 模拟 Electron 环境
        if (!process.resourcesPath) {
            process.resourcesPath = resourcesPath;
        }
        diagLog(`[Worker] process.resourcesPath = ${process.resourcesPath}`);

        // 加载主 DLL
        diagLog('[Worker] 正在加载 wcdb_api.dll...');
        lib = koffi.load(dllPath);
        diagLog('[Worker] wcdb_api.dll koffi.load 成功');

        // 额外预加载 wx_key.dll (可能在 wcdb_init 时需要)
        const wxKeyPath = path.join(resourcesPath, 'key', 'win32', 'x64', 'wx_key.dll');
        if (fs.existsSync(wxKeyPath)) {
            try {
                koffi.load(wxKeyPath);
                diagLog(`[Worker] 预加载 wx_key.dll 成功: ${wxKeyPath}`);
            } catch (e) {
                diagLog(`[Worker] 预加载 wx_key.dll 失败: ${e.message}`);
            }
        } else {
            diagLog(`[Worker] wx_key.dll 不存在: ${wxKeyPath}`);
        }

        // 尝试所有 InitProtection 路径
        try {
            wcdbInitProtection = lib.func('int32 InitProtection(const char* resourcePath)');
            diagLog('[Worker] InitProtection 函数绑定成功');

            const resourcePaths = [
                resourcesPath,
                dllDir,
                path.dirname(dllDir),
                resourcesPath ? path.join(resourcesPath, 'resources') : null,
            ].filter(Boolean);
            diagLog(`[Worker] InitProtection 候选路径: ${JSON.stringify(resourcePaths)}`);

            let protectionOk = false;
            for (const resPath of resourcePaths) {
                try {
                    const code = Number(wcdbInitProtection(resPath));
                    diagLog(`[Worker] InitProtection(${resPath}) = ${code}`);
                    if (code === 0) {
                        protectionOk = true;
                        diagLog(`[Worker] InitProtection 验证通过 (路径: ${resPath})`);
                        break;
                    }
                } catch (err) {
                    diagLog(`[Worker] InitProtection(${resPath}) 异常: ${err.message}`);
                }
            }
            if (!protectionOk) {
                diagErr('[Worker] InitProtection 全部路径验证失败');
                return false;
            }
        } catch (e) {
            diagErr(`[Worker] InitProtection 阶段异常: ${e.message}`);
            return false;
        }

        // 绑定所有需要的函数
        diagLog('[Worker] 正在绑定 wcdbInit/wcdbShutdown...');
        wcdbInit = lib.func('int32 wcdb_init()');
        wcdbShutdown = lib.func('int32 wcdb_shutdown()');
        wcdbOpenAccount = lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)');
        wcdbCloseAccount = lib.func('int32 wcdb_close_account(int64 handle)');
        wcdbFreeString = lib.func('void wcdb_free_string(void* ptr)');
        diagLog('[Worker] 基础函数绑定成功');

        // 命名管道监控
        try {
            wcdbStartMonitorPipe = lib.func('int32 wcdb_start_monitor_pipe()');
            wcdbStopMonitorPipe = lib.func('void wcdb_stop_monitor_pipe()');
            wcdbGetMonitorPipeName = lib.func('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)');
            diagLog('[Worker] 命名管道监控接口加载成功');
        } catch (e) {
            diagLog(`[Worker] 命名管道监控接口加载失败: ${e.message}`);
            wcdbStartMonitorPipe = null;
            wcdbStopMonitorPipe = null;
            wcdbGetMonitorPipeName = null;
        }

        // 初始化 WCDB
        diagLog('[Worker] 即将调用 wcdbInit()...');
        const initResult = wcdbInit();
        diagLog(`[Worker] wcdbInit() 返回值: ${initResult}`);
        if (initResult !== 0) {
            diagErr(`[Worker] wcdb_init 失败, 返回值: ${initResult} (0x${(initResult >>> 0).toString(16)})`);
            // 尝试获取 DLL 内部日志
            try {
                const wcdbGetLogs = lib.func('int32 wcdb_get_logs(_Out_ void** outJson)');
                const outPtr = [null];
                const logResult = wcdbGetLogs(outPtr);
                if (logResult === 0 && outPtr[0]) {
                    const logStr = koffi.decode(outPtr[0], 'char', -1);
                    diagLog(`[Worker] DLL 内部日志: ${logStr}`);
                    try { wcdbFreeString(outPtr[0]); } catch {}
                } else {
                    diagLog(`[Worker] wcdb_get_logs 返回: ${logResult}`);
                }
            } catch (e) {
                diagLog(`[Worker] 无法获取 DLL 内部日志: ${e.message}`);
            }
            return false;
        }
        diagLog('[Worker] wcdb_init 成功');

        // 绑定会话和消息查询函数
        wcdbGetSessions = lib.func('int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)');
        wcdbGetMessages = lib.func('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)');
        wcdbOpenMessageCursor = lib.func('int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)');
        try {
            wcdbOpenMessageCursorLite = lib.func('int32 wcdb_open_message_cursor_lite(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, _Out_ int64* outCursor)');
        } catch { wcdbOpenMessageCursorLite = null; }
        wcdbFetchMessageBatch = lib.func('int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, _Out_ void** outJson, _Out_ int32* outHasMore)');
        wcdbCloseMessageCursor = lib.func('int32 wcdb_close_message_cursor(int64 handle, int64 cursor)');
        try {
            wcdbGetDisplayNames = lib.func('int32 wcdb_get_display_names(int64 handle, const char* usernamesJson, _Out_ void** outJson)');
            diagLog('[Worker] wcdb_get_display_names 绑定成功');
        } catch { wcdbGetDisplayNames = null; }
        try {
            wcdbGetAvatarUrls = lib.func('int32 wcdb_get_avatar_urls(int64 handle, const char* usernamesJson, _Out_ void** outJson)');
            diagLog('[Worker] wcdb_get_avatar_urls 绑定成功');
        } catch { wcdbGetAvatarUrls = null; }
        diagLog('[Worker] 查询接口绑定成功');

        initialized = true;
        diagLog('[Worker] === initialize() 成功完成 ===');
        return true;
    } catch (e) {
        diagErr(`[Worker] 初始化异常: ${e.message || e}\n${e.stack || ''}`);
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
            console.log('[Worker] 数据库已打开，参数未变，跳过');
            return true;
        }

        if (handle !== null) {
            close();
            const initOk = await initialize();
            if (!initOk) return false;
        }

        const dbStoragePath = path.join(accountDir, 'db_storage');
        console.log(`[Worker] accountDir=${accountDir}`);
        console.log(`[Worker] dbStoragePath=${dbStoragePath}`);

        if (!dbStoragePath || !fs.existsSync(dbStoragePath)) {
            console.error(`[Worker] 数据库目录不存在: ${accountDir}`);
            return false;
        }

        const sessionDbPath = findSessionDb(dbStoragePath);
        console.log(`[Worker] sessionDbPath=${sessionDbPath || '未找到'}`);

        if (!sessionDbPath) {
            console.error('[Worker] 未找到 session.db 文件');
            return false;
        }

        const handleOut = [0];
        const result = wcdbOpenAccount(sessionDbPath, hexKey, handleOut);
        console.log(`[Worker] wcdb_open_account 返回值: ${result}`);

        if (result !== 0) {
            console.error(`[Worker] 打开数据库失败，错误码: ${result}`);
            return false;
        }

        const h = handleOut[0];
        if (h <= 0) {
            console.error('[Worker] 数据库句柄无效');
            return false;
        }

        handle = h;
        currentPath = accountDir;
        currentKey = hexKey;
        console.log(`[Worker] 数据库打开成功，句柄: ${handle}`);
        return true;
    } catch (e) {
        console.error('[Worker] open 异常:', e.message || e);
        return false;
    }
}

// ==================== 关闭数据库 ====================

function close() {
    stopMonitor();
    if (handle !== null || initialized) {
        try {
            wcdbShutdown();
        } catch (e) {
            console.error('[Worker] wcdb_shutdown 异常:', e.message);
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
    const net = require('net');

    setTimeout(() => {
        if (!monitorCallback) return;

        console.log(`[Worker] 正在连接命名管道: ${monitorPipePath}`);
        monitorPipeClient = net.createConnection(monitorPipePath, () => {
            console.log(`[Worker] 命名管道已连接: ${monitorPipePath}`);
        });

        let buffer = '';
        monitorPipeClient.on('data', (data) => {
            const rawChunk = data.toString('utf8');
            const normalizedChunk = rawChunk
                .replace(/ /g, '\n')
                .replace(/}\s*\{/g, '}\n{');

            buffer += normalizedChunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const parsed = JSON.parse(line);
                        const action = parsed.action || 'update';
                        console.log(`[Worker] 管道数据: action=${action}`);
                        monitorCallback(action, line);
                    } catch {
                        monitorCallback('update', line);
                    }
                }
            }

            // 兜底：如果没有换行但 JSON 已完整
            const tail = buffer.trim();
            if (tail.startsWith('{') && tail.endsWith('}')) {
                try {
                    const parsed = JSON.parse(tail);
                    monitorCallback(parsed.action || 'update', tail);
                    buffer = '';
                } catch {}
            }
        });

        monitorPipeClient.on('error', (err) => {
            // 静默处理管道错误
        });

        monitorPipeClient.on('close', () => {
            console.log('[Worker] 命名管道已断开');
            monitorPipeClient = null;
            scheduleReconnect();
        });
    }, 100);
}

function scheduleReconnect() {
    if (monitorReconnectTimer || !monitorCallback) return;
    console.log('[Worker] 将在 3 秒后重连命名管道...');
    monitorReconnectTimer = setTimeout(() => {
        monitorReconnectTimer = null;
        if (monitorCallback && !monitorPipeClient) {
            connectMonitorPipe(monitorPipePath);
        }
    }, 3000);
}

function startMonitor(callback) {
    if (!wcdbStartMonitorPipe) {
        console.error('[Worker] 当前 DLL 不支持命名管道监控');
        return false;
    }

    monitorCallback = callback;
    try {
        const result = wcdbStartMonitorPipe();
        console.log(`[Worker] wcdb_start_monitor_pipe 返回值: ${result}`);
        if (result !== 0) {
            console.error('[Worker] 启动监控管道失败');
            return false;
        }

        let pipePath = '\\\\.\\pipe\\weflow_monitor';
        if (wcdbGetMonitorPipeName) {
            try {
                const namePtr = [null];
                if (wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
                    pipePath = koffi.decode(namePtr[0], 'char', -1);
                    wcdbFreeString(namePtr[0]);
                }
            } catch {}
        }
        console.log(`[Worker] 管道路径: ${pipePath}`);
        connectMonitorPipe(pipePath);
        return true;
    } catch (e) {
        console.error('[Worker] startMonitor 异常:', e.message || e);
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
    if (wcdbStopMonitorPipe) {
        try { wcdbStopMonitorPipe(); } catch {}
    }
}

// ==================== 数据查询 ====================

function decodeJsonPtr(outPtr) {
    if (!outPtr) return null;
    try {
        const jsonStr = koffi.decode(outPtr, 'char', -1);
        wcdbFreeString(outPtr);
        return jsonStr;
    } catch {
        try { wcdbFreeString(outPtr); } catch {}
        return null;
    }
}

async function getSessions() {
    if (!handle) return { success: false, error: '数据库未打开' };
    try {
        const outPtr = [null];
        const result = wcdbGetSessions(handle, outPtr);
        if (result !== 0 || !outPtr[0]) {
            return { success: false, error: `获取会话失败: ${result}` };
        }
        const jsonStr = decodeJsonPtr(outPtr[0]);
        if (!jsonStr) return { success: false, error: '解析会话数据失败' };
        return { success: true, sessions: JSON.parse(jsonStr) };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

async function getNewMessages(sessionId, minTime, limit = 200) {
    if (!handle) return { success: false, error: '数据库未打开' };
    try {
        const openFunc = wcdbOpenMessageCursor || wcdbOpenMessageCursorLite;
        const cursorOut = [0];
        const openResult = openFunc(handle, sessionId, limit, 1, minTime, 0, cursorOut);
        if (openResult !== 0 || cursorOut[0] <= 0) {
            return { success: false, error: `打开游标失败: ${openResult}, cursor=${cursorOut[0]}` };
        }

        const cursor = cursorOut[0];
        try {
            const outPtr = [null];
            const hasMoreOut = [0];
            const fetchResult = wcdbFetchMessageBatch(handle, cursor, outPtr, hasMoreOut);
            if (fetchResult !== 0) {
                return { success: false, error: `获取消息批次失败: ${fetchResult}` };
            }
            const jsonStr = decodeJsonPtr(outPtr[0]);
            if (!jsonStr) return { success: true, messages: [] };
            const parsed = JSON.parse(jsonStr);
            return { success: true, messages: parsed };
        } finally {
            wcdbCloseMessageCursor(handle, cursor);
        }
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

async function getDisplayNames(usernames) {
    if (!handle) return { success: false, error: '数据库未打开' };
    if (!wcdbGetDisplayNames) return { success: false, error: 'wcdb_get_display_names 不可用' };
    try {
        const jsonInput = JSON.stringify(usernames);
        const outPtr = [null];
        const result = wcdbGetDisplayNames(handle, jsonInput, outPtr);
        if (result !== 0) {
            return { success: false, error: `获取显示名失败: ${result}` };
        }
        const jsonStr = decodeJsonPtr(outPtr[0]);
        if (!jsonStr) return { success: true, map: {} };
        return { success: true, map: JSON.parse(jsonStr) };
    } catch (e) {
        return { success: false, error: String(e.message || e) };
    }
}

async function getAvatarUrls(usernames) {
    if (!handle) return { success: false, error: '数据库未打开' };
    if (!wcdbGetAvatarUrls) return { success: false, error: 'wcdb_get_avatar_urls 不可用' };
    try {
        const jsonInput = JSON.stringify(usernames);
        const outPtr = [null];
        const result = wcdbGetAvatarUrls(handle, jsonInput, outPtr);
        if (result !== 0) {
            return { success: true, map: {} };
        }
        const jsonStr = decodeJsonPtr(outPtr[0]);
        if (!jsonStr) return { success: true, map: {} };
        return { success: true, map: JSON.parse(jsonStr) };
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
                    userDataPath = payload.userDataPath;
                    console.log(`[Worker] setPaths: resourcesPath=${resourcesPath}, userDataPath=${userDataPath}`);
                    result = { success: true };
                    break;

                case 'open':
                    if (!resourcesPath) {
                        result = { success: false, error: '请先调用 setPaths' };
                        break;
                    }
                    const openOk = await open(payload.accountDir, payload.hexKey);
                    result = { success: openOk };
                    break;

                case 'setMonitor':
                    if (!handle) {
                        result = { success: false, error: '数据库未打开，请先调用 open' };
                        break;
                    }
                    const monitorOk = startMonitor((action, json) => {
                        parentPort.postMessage({
                            id: -1,
                            type: 'monitor',
                            payload: { type: action, json }
                        });
                    });
                    result = { success: monitorOk };
                    break;

                case 'close':
                    close();
                    result = { success: true };
                    break;

                case 'getSessions':
                    result = await getSessions();
                    break;

                case 'getNewMessages':
                    result = await getNewMessages(payload.sessionId, payload.minTime || 0, payload.limit || 200);
                    break;

                case 'getDisplayNames':
                    result = await getDisplayNames(payload.usernames || []);
                    break;

                case 'getAvatarUrls':
                    result = await getAvatarUrls(payload.usernames || []);
                    break;

                default:
                    result = { success: false, error: `未知操作: ${type}` };
            }

            parentPort.postMessage({ id, result });
        } catch (e) {
            console.error('[Worker] 处理消息异常:', e.message || e);
            parentPort.postMessage({ id, error: String(e.message || e) });
        }
    });
}
