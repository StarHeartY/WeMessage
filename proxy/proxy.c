/*
 * proxy.c — WCDB API 薄代理
 *
 * 命名为 WeFlow.exe，加载 wcdb_api.dll 并通过 TCP JSON-line 协议
 * 暴露其函数给 Node.js。这是 wcdb_api.dll 进程名检查的最小化解决方案。
 *
 * 构建: gcc -O2 -Wall -o WeFlow.exe proxy.c -lws2_32
 */

#define _WIN32_WINNT 0x0601
#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <windows.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

/* ======================== 配置常量 ======================== */

#define DEFAULT_PORT     5037
#define DEFAULT_HOST     "127.0.0.1"
#define MAX_REQUEST_LEN   65536
#define MAX_RESPONSE_LEN  262144
#define MAX_METHOD_LEN    64
#define MAX_PARAM_LEN     4096
#define MAX_PARAM_COUNT   8
#define RECV_BUF_SIZE     8192

/* ======================== DLL 函数指针类型 ======================== */

typedef int32_t (*fn_InitProtection)(const char*);
typedef int32_t (*fn_wcdb_init)(void);
typedef int32_t (*fn_wcdb_shutdown)(void);
typedef int32_t (*fn_wcdb_open_account)(const char*, const char*, int64_t*);
typedef int32_t (*fn_wcdb_close_account)(int64_t);
typedef void    (*fn_wcdb_free_string)(void*);
typedef int32_t (*fn_wcdb_start_monitor_pipe)(void);
typedef void    (*fn_wcdb_stop_monitor_pipe)(void);
typedef int32_t (*fn_wcdb_get_monitor_pipe_name)(void**);
typedef int32_t (*fn_wcdb_get_sessions)(int64_t, void**);
typedef int32_t (*fn_wcdb_get_messages)(int64_t, const char*, int32_t, int32_t, void**);
typedef int32_t (*fn_wcdb_open_message_cursor)(int64_t, const char*, int32_t, int32_t, int32_t, int32_t, int64_t*);
typedef int32_t (*fn_wcdb_open_message_cursor_lite)(int64_t, const char*, int32_t, int32_t, int32_t, int32_t, int64_t*);
typedef int32_t (*fn_wcdb_fetch_message_batch)(int64_t, int64_t, void**, int32_t*);
typedef int32_t (*fn_wcdb_close_message_cursor)(int64_t, int64_t);
typedef int32_t (*fn_wcdb_get_display_names)(int64_t, const char*, void**);
typedef int32_t (*fn_wcdb_get_avatar_urls)(int64_t, const char*, void**);
typedef int32_t (*fn_wcdb_get_logs)(void**);

/* ======================== DLL 函数指针（全局） ======================== */

static HMODULE dll = NULL;

static fn_InitProtection          p_InitProtection;
static fn_wcdb_init               p_wcdb_init;
static fn_wcdb_shutdown           p_wcdb_shutdown;
static fn_wcdb_open_account       p_wcdb_open_account;
static fn_wcdb_close_account      p_wcdb_close_account;
static fn_wcdb_free_string        p_wcdb_free_string;
static fn_wcdb_start_monitor_pipe p_wcdb_start_monitor_pipe;
static fn_wcdb_stop_monitor_pipe  p_wcdb_stop_monitor_pipe;
static fn_wcdb_get_monitor_pipe_name p_wcdb_get_monitor_pipe_name;
static fn_wcdb_get_sessions       p_wcdb_get_sessions;
static fn_wcdb_get_messages       p_wcdb_get_messages;
static fn_wcdb_open_message_cursor p_wcdb_open_message_cursor;
static fn_wcdb_open_message_cursor_lite p_wcdb_open_message_cursor_lite;
static fn_wcdb_fetch_message_batch p_wcdb_fetch_message_batch;
static fn_wcdb_close_message_cursor p_wcdb_close_message_cursor;
static fn_wcdb_get_display_names  p_wcdb_get_display_names;
static fn_wcdb_get_avatar_urls    p_wcdb_get_avatar_urls;
static fn_wcdb_get_logs           p_wcdb_get_logs;

static char resources_path[MAX_PATH] = ".";
static int dll_initialized = 0;

/* ======================== JSON 工具函数 ======================== */

/* 从 JSON 字符串中提取整数字段值，返回找到的值的地址，或 NULL */
static const char *json_find_int(const char *json, const char *key, int64_t *out) {
    char search[128];
    int keylen = (int)strlen(key);
    /* 构建搜索模式 "key": */
    if (keylen + 4 > (int)sizeof(search)) return NULL;
    search[0] = '"';
    memcpy(search + 1, key, keylen);
    search[1 + keylen] = '"';
    search[2 + keylen] = ':';
    search[3 + keylen] = '\0';

    const char *pos = strstr(json, search);
    if (!pos) return NULL;
    pos += strlen(search);
    while (*pos == ' ' || *pos == '\t') pos++;
    char *end;
    *out = (int64_t)strtoll(pos, &end, 10);
    return end;
}

/* 从 JSON 字符串中提取字符串字段值（不包含引号），写到 buf 中 */
static int json_find_string(const char *json, const char *key, char *buf, int bufsize) {
    char search[128];
    int keylen = (int)strlen(key);
    if (keylen + 4 > (int)sizeof(search)) return 0;
    search[0] = '"';
    memcpy(search + 1, key, keylen);
    search[1 + keylen] = '"';
    search[2 + keylen] = ':';
    search[3 + keylen] = '\0';

    const char *pos = strstr(json, search);
    if (!pos) return 0;
    pos += strlen(search);
    while (*pos == ' ' || *pos == '\t') pos++;
    if (*pos != '"') return 0;
    pos++;
    int i = 0;
    while (*pos && *pos != '"' && i < bufsize - 1) {
        if (*pos == '\\' && *(pos + 1)) {
            pos++;
            switch (*pos) {
                case '"':  buf[i++] = '"';  break;
                case '\\': buf[i++] = '\\'; break;
                case '/':  buf[i++] = '/';  break;
                case 'n':  buf[i++] = '\n'; break;
                case 'r':  buf[i++] = '\r'; break;
                case 't':  buf[i++] = '\t'; break;
                default:   buf[i++] = *pos; break;
            }
        } else {
            buf[i++] = *pos;
        }
        pos++;
    }
    buf[i] = '\0';
    return 1;
}

/* 在 JSON 中找到 "params":[ 的位置，返回 [ 之后的指针 */
static const char *json_find_params(const char *json) {
    const char *pos = strstr(json, "\"params\":");
    if (!pos) return NULL;
    pos += 9;
    while (*pos == ' ' || *pos == '\t') pos++;
    if (*pos != '[') return NULL;
    return pos + 1;
}

/* 解析 params 数组中的一个元素。
 * 将 *pp 推进到元素之后（逗号或 ] 之后）。
 * 对于整数填充 i_val，对于字符串填充 s_buf，对于 null 设置 is_null。 */
static int json_parse_next_param(const char **pp, int *type, char *s_buf, int s_size, int64_t *i_val) {
    const char *p = *pp;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;

    if (*p == ']' || *p == '\0') return 0; /* 数组结束 */

    if (*p == ',') { p++; while (*p == ' ' || *p == '\t') p++; }

    if (*p == '"') {
        /* 字符串 */
        p++;
        int i = 0;
        while (*p && *p != '"' && i < s_size - 1) {
            if (*p == '\\' && *(p + 1)) {
                p++;
                switch (*p) {
                    case '"':  s_buf[i++] = '"';  break;
                    case '\\': s_buf[i++] = '\\'; break;
                    case '/':  s_buf[i++] = '/';  break;
                    case 'n':  s_buf[i++] = '\n'; break;
                    case 'r':  s_buf[i++] = '\r'; break;
                    case 't':  s_buf[i++] = '\t'; break;
                    default:   s_buf[i++] = *p; break;
                }
            } else {
                s_buf[i++] = *p;
            }
            p++;
        }
        if (*p == '"') p++;
        s_buf[i] = '\0';
        *type = 1; /* string */
        *pp = p;
        return 1;
    }

    if (*p == '-' || (*p >= '0' && *p <= '9')) {
        /* 整数 */
        char *end;
        *i_val = (int64_t)strtoll(p, &end, 10);
        *type = 2; /* int */
        *pp = end;
        return 1;
    }

    if (strncmp(p, "null", 4) == 0) {
        *type = 0; /* null */
        *pp = p + 4;
        return 1;
    }

    if (strncmp(p, "true", 4) == 0) {
        *type = 3; /* bool true */
        *i_val = 1;
        *pp = p + 4;
        return 1;
    }

    if (strncmp(p, "false", 5) == 0) {
        *type = 3; /* bool false */
        *i_val = 0;
        *pp = p + 5;
        return 1;
    }

    *pp = p + 1;
    return 0;
}

/* JSON 字符串转义（用于嵌入 JSON 中的字符串） */
static void json_escape(const char *src, char *dst, int dst_size) {
    int i = 0, j = 0;
    while (src[i] && j < dst_size - 2) {
        unsigned char c = (unsigned char)src[i];
        switch (c) {
            case '"':  dst[j++] = '\\'; dst[j++] = '"';  break;
            case '\\': dst[j++] = '\\'; dst[j++] = '\\'; break;
            case '\n': dst[j++] = '\\'; dst[j++] = 'n';  break;
            case '\r': dst[j++] = '\\'; dst[j++] = 'r';  break;
            case '\t': dst[j++] = '\\'; dst[j++] = 't';  break;
            default:
                if (c < 0x20) {
                    j += snprintf(dst + j, dst_size - j, "\\u%04x", c);
                } else {
                    dst[j++] = c;
                }
                break;
        }
        i++;
    }
    dst[j] = '\0';
}

/* ======================== DLL 加载与初始化 ======================== */

static int load_dll(const char *resources) {
    char dll_path[MAX_PATH];
    char wcdb_path[MAX_PATH];
    char sdl_path[MAX_PATH];
    char key_path[MAX_PATH];

    if (resources && resources[0]) {
        snprintf(resources_path, sizeof(resources_path), "%s", resources);
    }

    /* 尝试多个搜索路径 */
    const char *search_dirs[] = {
        resources_path,
        ".",
        NULL
    };

    int found = 0;
    for (int i = 0; search_dirs[i]; i++) {
        snprintf(dll_path, sizeof(dll_path), "%s\\resources\\wcdb\\win32\\x64\\wcdb_api.dll", search_dirs[i]);
        if (GetFileAttributesA(dll_path) != INVALID_FILE_ATTRIBUTES) { found = 1; break; }
        snprintf(dll_path, sizeof(dll_path), "%s\\wcdb\\win32\\x64\\wcdb_api.dll", search_dirs[i]);
        if (GetFileAttributesA(dll_path) != INVALID_FILE_ATTRIBUTES) { found = 1; break; }
        snprintf(dll_path, sizeof(dll_path), "%s\\resources\\wcdb\\wcdb_api.dll", search_dirs[i]);
        if (GetFileAttributesA(dll_path) != INVALID_FILE_ATTRIBUTES) { found = 1; break; }
    }

    if (!found) {
        fprintf(stderr, "[proxy] wcdb_api.dll not found, resources=%s\n", resources_path);
        return 0;
    }

    /* 提取 DLL 所在目录并设为 DLL 搜索路径 */
    char dll_dir[MAX_PATH];
    strncpy(dll_dir, dll_path, sizeof(dll_dir) - 1);
    dll_dir[sizeof(dll_dir) - 1] = '\0';
    char *slash = strrchr(dll_dir, '\\');
    if (slash) *slash = '\0';
    SetDllDirectoryA(dll_dir);

    /* 预加载依赖 DLL */
    snprintf(wcdb_path, sizeof(wcdb_path), "%s\\WCDB.dll", dll_dir);
    LoadLibraryA(wcdb_path);

    snprintf(sdl_path, sizeof(sdl_path), "%s\\SDL2.dll", dll_dir);
    LoadLibraryA(sdl_path);

    /* 尝试加载 wx_key.dll */
    for (int i = 0; search_dirs[i]; i++) {
        snprintf(key_path, sizeof(key_path), "%s\\key\\win32\\x64\\wx_key.dll", search_dirs[i]);
        if (GetFileAttributesA(key_path) != INVALID_FILE_ATTRIBUTES) {
            LoadLibraryA(key_path);
            break;
        }
        snprintf(key_path, sizeof(key_path), "%s\\resources\\key\\win32\\x64\\wx_key.dll", search_dirs[i]);
        if (GetFileAttributesA(key_path) != INVALID_FILE_ATTRIBUTES) {
            LoadLibraryA(key_path);
            break;
        }
    }

    /* 加载主 DLL */
    fprintf(stderr, "[proxy] Loading: %s\n", dll_path);
    dll = LoadLibraryA(dll_path);
    if (!dll) {
        fprintf(stderr, "[proxy] LoadLibraryA failed, error=%lu\n", GetLastError());
        return 0;
    }

    /* 绑定函数指针（必需的） */
    #define BIND(name) p_##name = (fn_##name)GetProcAddress(dll, #name)
    #define BIND_OPT(name) p_##name = (fn_##name)GetProcAddress(dll, #name)

    BIND(InitProtection);
    BIND(wcdb_init);
    BIND(wcdb_shutdown);
    BIND(wcdb_open_account);
    BIND(wcdb_close_account);
    BIND(wcdb_free_string);
    BIND(wcdb_get_sessions);
    BIND(wcdb_get_messages);
    BIND(wcdb_open_message_cursor);
    BIND(wcdb_fetch_message_batch);
    BIND(wcdb_close_message_cursor);

    /* 可选绑定 */
    BIND_OPT(wcdb_start_monitor_pipe);
    BIND_OPT(wcdb_stop_monitor_pipe);
    BIND_OPT(wcdb_get_monitor_pipe_name);
    BIND_OPT(wcdb_get_display_names);
    BIND_OPT(wcdb_get_avatar_urls);
    BIND_OPT(wcdb_get_logs);
    BIND_OPT(wcdb_open_message_cursor_lite);

    #undef BIND
    #undef BIND_OPT

    if (!p_InitProtection || !p_wcdb_init || !p_wcdb_open_account || !p_wcdb_get_sessions) {
        fprintf(stderr, "[proxy] Missing required DLL exports\n");
        FreeLibrary(dll);
        dll = NULL;
        return 0;
    }

    fprintf(stderr, "[proxy] DLL loaded and functions bound successfully\n");
    return 1;
}

/* ======================== 字符串结果辅助函数 ======================== */

/* 读取 DLL 返回的 out-字符串，复制后释放 */
static char *read_and_free_string(void *ptr) {
    if (!ptr) return NULL;
    size_t len = strlen((const char*)ptr);
    char *copy = (char*)malloc(len + 1);
    if (copy) {
        memcpy(copy, ptr, len + 1);
    }
    if (p_wcdb_free_string) {
        p_wcdb_free_string(ptr);
    }
    return copy;
}

/* ======================== RPC 方法处理 ======================== */

/*
 * 每个 handler 接收 params JSON 数组指针（已跳过 '['），
 * 将响应写入 resp_buf，返回写入的字节数。
 */

static int handle_init_protection(const char *params, char *resp_buf, int resp_size) {
    /* params: ["resourcePath"] */
    char path[MAX_PATH] = ".";
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PATH]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0 && type == 1) {
            snprintf(path, sizeof(path), "%s", s_buf);
        }
        param_count++;
    }

    int32_t ret = p_InitProtection(path);
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d}", ret);
}

static int handle_wcdb_init(const char *params, char *resp_buf, int resp_size) {
    (void)params;
    int32_t ret = p_wcdb_init();

    if (ret != 0) {
        /* 尝试获取 DLL 内部日志 */
        char log_info[2048] = "";
        if (p_wcdb_get_logs) {
            void *logPtr = NULL;
            p_wcdb_get_logs(&logPtr);
            if (logPtr) {
                char *logs = read_and_free_string(logPtr);
                if (logs) {
                    char escaped[4096];
                    json_escape(logs, escaped, sizeof(escaped));
                    snprintf(log_info, sizeof(log_info), ",\"logs\":\"%s\"", escaped);
                    free(logs);
                }
            }
        }
        return snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d%s}", ret, log_info);
    }

    dll_initialized = 1;
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d}", ret);
}

static int handle_wcdb_shutdown(const char *params, char *resp_buf, int resp_size) {
    (void)params;
    if (p_wcdb_shutdown) {
        p_wcdb_shutdown();
    }
    dll_initialized = 0;
    return snprintf(resp_buf, resp_size, "{\"ok\":true,\"ret\":0}");
}

static int handle_wcdb_open_account(const char *params, char *resp_buf, int resp_size) {
    /* params: ["path", "hexKey"] */
    char path[MAX_PATH] = "";
    char key[256] = "";
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PARAM_LEN]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0) snprintf(path, sizeof(path), "%s", type == 1 ? s_buf : "");
        if (param_count == 1) snprintf(key, sizeof(key), "%s", type == 1 ? s_buf : "");
        param_count++;
    }

    if (!path[0] || !key[0]) {
        return snprintf(resp_buf, resp_size,
            "{\"ok\":false,\"error\":\"Missing path or key parameter\"}");
    }

    int64_t handle = 0;
    int32_t ret = p_wcdb_open_account(path, key, &handle);
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"handle\":%lld}", ret, (long long)handle);
}

static int handle_wcdb_close_account(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    const char *p = params;
    int type; char s_buf[64]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (type == 2) handle = i_val;
    }

    if (p_wcdb_close_account) {
        p_wcdb_close_account(handle);
    }
    return snprintf(resp_buf, resp_size, "{\"ok\":true,\"ret\":0}");
}

static int handle_wcdb_get_sessions(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    const char *p = params;
    int type; char s_buf[64]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (type == 2) handle = i_val;
    }

    void *outJson = NULL;
    int32_t ret = p_wcdb_get_sessions(handle, &outJson);
    char *jsonStr = read_and_free_string(outJson);

    if (jsonStr) {
        int esc_size = resp_size - 100;
        if (esc_size < 256) esc_size = 256;
        char *escaped = (char*)malloc(esc_size);
        if (!escaped) { free(jsonStr); return snprintf(resp_buf, resp_size, "{\"ok\":false,\"error\":\"OOM\"}"); }
        json_escape(jsonStr, escaped, esc_size);
        int n = snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d,\"json\":\"%s\"}", ret, escaped);
        free(escaped);
        free(jsonStr);
        return n;
    }
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"json\":\"\"}", ret);
}

static int handle_wcdb_get_messages(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    char username[256] = "";
    int32_t limit = 200;
    int32_t offset = 0;
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PARAM_LEN]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0) handle = (type == 2) ? i_val : 0;
        if (param_count == 1 && type == 1) snprintf(username, sizeof(username), "%s", s_buf);
        if (param_count == 2 && type == 2) limit = (int32_t)i_val;
        if (param_count == 3 && type == 2) offset = (int32_t)i_val;
        param_count++;
    }

    void *outJson = NULL;
    int32_t ret = p_wcdb_get_messages(handle, username, limit, offset, &outJson);
    char *jsonStr = read_and_free_string(outJson);

    if (jsonStr) {
        int esc_size = resp_size - 100;
        if (esc_size < 256) esc_size = 256;
        char *escaped = (char*)malloc(esc_size);
        if (!escaped) { free(jsonStr); return snprintf(resp_buf, resp_size, "{\"ok\":false,\"error\":\"OOM\"}"); }
        json_escape(jsonStr, escaped, esc_size);
        int n = snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d,\"json\":\"%s\"}", ret, escaped);
        free(escaped);
        free(jsonStr);
        return n;
    }
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"json\":\"\"}", ret);
}

static int handle_wcdb_open_message_cursor(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    char sessionId[256] = "";
    int32_t batchSize = 200;
    int32_t ascending = 1;
    int32_t beginTimestamp = 0;
    int32_t endTimestamp = 0;
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PARAM_LEN]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0) handle = (type == 2) ? i_val : 0;
        if (param_count == 1 && type == 1) snprintf(sessionId, sizeof(sessionId), "%s", s_buf);
        if (param_count == 2 && type == 2) batchSize = (int32_t)i_val;
        if (param_count == 3 && type == 2) ascending = (int32_t)i_val;
        if (param_count == 4 && type == 2) beginTimestamp = (int32_t)i_val;
        if (param_count == 5 && type == 2) endTimestamp = (int32_t)i_val;
        param_count++;
    }

    int64_t cursor = 0;
    /* 优先使用非 lite 版本，与原版 wcdbWorker.js 行为一致 */
    fn_wcdb_open_message_cursor opener = p_wcdb_open_message_cursor
        ? p_wcdb_open_message_cursor : p_wcdb_open_message_cursor_lite;
    int32_t ret = opener(handle, sessionId, batchSize, ascending,
                         beginTimestamp, endTimestamp, &cursor);
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"cursor\":%lld}", ret, (long long)cursor);
}

static int handle_wcdb_fetch_message_batch(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    int64_t cursor = 0;
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[64]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0) handle = (type == 2) ? i_val : 0;
        if (param_count == 1) cursor = (type == 2) ? i_val : 0;
        param_count++;
    }

    void *outJson = NULL;
    int32_t hasMore = 0;
    int32_t ret = p_wcdb_fetch_message_batch(handle, cursor, &outJson, &hasMore);
    char *jsonStr = read_and_free_string(outJson);

    if (jsonStr) {
        int esc_size = resp_size - 100;
        if (esc_size < 256) esc_size = 256;
        char *escaped = (char*)malloc(esc_size);
        if (!escaped) { free(jsonStr); return snprintf(resp_buf, resp_size, "{\"ok\":false,\"error\":\"OOM\"}"); }
        json_escape(jsonStr, escaped, esc_size);
        int n = snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d,\"json\":\"%s\",\"hasMore\":%d}",
            ret, escaped, hasMore);
        free(escaped);
        free(jsonStr);
        return n;
    }
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"json\":\"\",\"hasMore\":%d}", ret, hasMore);
}

static int handle_wcdb_close_message_cursor(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    int64_t cursor = 0;
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[64]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0) handle = (type == 2) ? i_val : 0;
        if (param_count == 1) cursor = (type == 2) ? i_val : 0;
        param_count++;
    }

    int32_t ret = p_wcdb_close_message_cursor(handle, cursor);
    return snprintf(resp_buf, resp_size, "{\"ok\":true,\"ret\":%d}", ret);
}

static int handle_wcdb_get_display_names(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    char usernames[MAX_PARAM_LEN] = "";
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PARAM_LEN]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0 && type == 2) handle = i_val;
        if (param_count == 1 && type == 1) snprintf(usernames, sizeof(usernames), "%s", s_buf);
        param_count++;
    }

    if (!p_wcdb_get_display_names) {
        return snprintf(resp_buf, resp_size,
            "{\"ok\":false,\"error\":\"wcdb_get_display_names not available\"}");
    }

    void *outJson = NULL;
    int32_t ret = p_wcdb_get_display_names(handle, usernames, &outJson);
    char *jsonStr = read_and_free_string(outJson);

    if (jsonStr) {
        int esc_size = resp_size - 100;
        if (esc_size < 256) esc_size = 256;
        char *escaped = (char*)malloc(esc_size);
        if (!escaped) { free(jsonStr); return snprintf(resp_buf, resp_size, "{\"ok\":false,\"error\":\"OOM\"}"); }
        json_escape(jsonStr, escaped, esc_size);
        int n = snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d,\"json\":\"%s\"}", ret, escaped);
        free(escaped);
        free(jsonStr);
        return n;
    }
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"json\":\"\"}", ret);
}

static int handle_wcdb_get_avatar_urls(const char *params, char *resp_buf, int resp_size) {
    int64_t handle = 0;
    char usernames[MAX_PARAM_LEN] = "";
    int param_count = 0;
    const char *p = params;
    int type; char s_buf[MAX_PARAM_LEN]; int64_t i_val;
    while (json_parse_next_param(&p, &type, s_buf, sizeof(s_buf), &i_val)) {
        if (param_count == 0 && type == 2) handle = i_val;
        if (param_count == 1 && type == 1) snprintf(usernames, sizeof(usernames), "%s", s_buf);
        param_count++;
    }

    if (!p_wcdb_get_avatar_urls) {
        return snprintf(resp_buf, resp_size,
            "{\"ok\":false,\"error\":\"wcdb_get_avatar_urls not available\"}");
    }

    void *outJson = NULL;
    int32_t ret = p_wcdb_get_avatar_urls(handle, usernames, &outJson);
    char *jsonStr = read_and_free_string(outJson);

    if (jsonStr) {
        int esc_size = resp_size - 100;
        if (esc_size < 256) esc_size = 256;
        char *escaped = (char*)malloc(esc_size);
        if (!escaped) { free(jsonStr); return snprintf(resp_buf, resp_size, "{\"ok\":false,\"error\":\"OOM\"}"); }
        json_escape(jsonStr, escaped, esc_size);
        int n = snprintf(resp_buf, resp_size,
            "{\"ok\":true,\"ret\":%d,\"json\":\"%s\"}", ret, escaped);
        free(escaped);
        free(jsonStr);
        return n;
    }
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"json\":\"\"}", ret);
}

static int handle_wcdb_start_monitor_pipe(const char *params, char *resp_buf, int resp_size) {
    (void)params;
    if (!p_wcdb_start_monitor_pipe) {
        return snprintf(resp_buf, resp_size,
            "{\"ok\":false,\"error\":\"wcdb_start_monitor_pipe not available\"}");
    }
    int32_t ret = p_wcdb_start_monitor_pipe();

    /* 获取管道名称 */
    char pipe_path[256] = "";
    if (p_wcdb_get_monitor_pipe_name) {
        void *namePtr = NULL;
        if (p_wcdb_get_monitor_pipe_name(&namePtr) == 0 && namePtr) {
            char *name = read_and_free_string(namePtr);
            if (name) {
                snprintf(pipe_path, sizeof(pipe_path), "%s", name);
                free(name);
            }
        }
    }
    if (!pipe_path[0]) {
        snprintf(pipe_path, sizeof(pipe_path), "\\\\.\\pipe\\weflow_monitor");
    }

    /* JSON-escape the pipe path */
    char escaped_pipe[512];
    json_escape(pipe_path, escaped_pipe, sizeof(escaped_pipe));
    return snprintf(resp_buf, resp_size,
        "{\"ok\":true,\"ret\":%d,\"pipePath\":\"%s\"}", ret, escaped_pipe);
}

static int handle_wcdb_stop_monitor_pipe(const char *params, char *resp_buf, int resp_size) {
    (void)params;
    if (p_wcdb_stop_monitor_pipe) {
        p_wcdb_stop_monitor_pipe();
    }
    return snprintf(resp_buf, resp_size, "{\"ok\":true,\"ret\":0}");
}

/* ======================== 方法路由表 ======================== */

typedef struct {
    const char *name;
    int (*handler)(const char *params, char *resp_buf, int resp_size);
} method_entry_t;

static method_entry_t methods[] = {
    {"init_protection",             handle_init_protection},
    {"wcdb_init",                   handle_wcdb_init},
    {"wcdb_shutdown",               handle_wcdb_shutdown},
    {"wcdb_open_account",           handle_wcdb_open_account},
    {"wcdb_close_account",          handle_wcdb_close_account},
    {"wcdb_get_sessions",           handle_wcdb_get_sessions},
    {"wcdb_get_messages",           handle_wcdb_get_messages},
    {"wcdb_open_message_cursor",    handle_wcdb_open_message_cursor},
    {"wcdb_fetch_message_batch",    handle_wcdb_fetch_message_batch},
    {"wcdb_close_message_cursor",   handle_wcdb_close_message_cursor},
    {"wcdb_get_display_names",      handle_wcdb_get_display_names},
    {"wcdb_get_avatar_urls",        handle_wcdb_get_avatar_urls},
    {"wcdb_start_monitor_pipe",     handle_wcdb_start_monitor_pipe},
    {"wcdb_stop_monitor_pipe",      handle_wcdb_stop_monitor_pipe},
    {NULL, NULL}
};

/* ======================== TCP 服务器 ======================== */

static SOCKET create_server(int port) {
    SOCKET sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock == INVALID_SOCKET) {
        fprintf(stderr, "[proxy] socket() failed: %d\n", WSAGetLastError());
        return INVALID_SOCKET;
    }

    int opt = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = inet_addr(DEFAULT_HOST);
    addr.sin_port = htons((unsigned short)port);

    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        fprintf(stderr, "[proxy] bind() failed: %d\n", WSAGetLastError());
        closesocket(sock);
        return INVALID_SOCKET;
    }

    if (listen(sock, 1) == SOCKET_ERROR) {
        fprintf(stderr, "[proxy] listen() failed: %d\n", WSAGetLastError());
        closesocket(sock);
        return INVALID_SOCKET;
    }

    return sock;
}

/*
 * 处理一条来自客户端的 JSON 请求。
 * 将响应直接写入 client 套接字。
 * 返回 0 表示客户端断开或出错。
 */
static int handle_client(SOCKET client) {
    char buf[MAX_REQUEST_LEN];
    int total = 0;
    int id = 0;

    /* 读取一行（以 \n 结尾） */
    while (total < (int)sizeof(buf) - 1) {
        int n = recv(client, buf + total, 1, 0);
        if (n <= 0) return 0;
        if (buf[total] == '\n') {
            buf[total] = '\0';
            break;
        }
        total++;
    }

    if (total == 0) return 1; /* 空行，忽略 */

    /* 解析 id */
    int64_t id_val = 0;
    if (!json_find_int(buf, "id", &id_val)) {
        const char *resp = "{\"ok\":false,\"error\":\"Missing id field\"}\n";
        send(client, resp, (int)strlen(resp), 0);
        return 1;
    }
    id = (int)id_val;

    /* 解析 method */
    char method[MAX_METHOD_LEN];
    if (!json_find_string(buf, "method", method, sizeof(method))) {
        char resp[256];
        int n = snprintf(resp, sizeof(resp),
            "{\"id\":%d,\"ok\":false,\"error\":\"Missing method field\"}\n", id);
        send(client, resp, n, 0);
        return 1;
    }

    /* 查找并调用 handler */
    const char *params_start = json_find_params(buf);
    if (!params_start) params_start = "";

    for (method_entry_t *m = methods; m->name; m++) {
        if (strcmp(m->name, method) == 0) {
            fprintf(stderr, "[proxy] RPC call: id=%d method=%s\n", id, method);
            fflush(stderr);

            char *resp = (char*)malloc(MAX_RESPONSE_LEN);
            if (!resp) {
                const char *err = "{\"ok\":false,\"error\":\"Out of memory\"}\n";
                send(client, err, (int)strlen(err), 0);
                return 1;
            }
            int handler_len = m->handler(params_start, resp, MAX_RESPONSE_LEN - 2);

            /* 分片发送以避免 snprintf 截断大响应 */
            /* 第1片: {"id":<id>, */
            char prefix[32];
            int pn = snprintf(prefix, sizeof(prefix), "{\"id\":%d,", id);
            send(client, prefix, pn, 0);

            /* 第2片: handler 响应体（跳过开头的 {） */
            int body_len = (int)strlen(resp + 1);
            send(client, resp + 1, body_len, 0);

            /* 第3片: 换行 */
            send(client, "\n", 1, 0);

            fprintf(stderr, "[proxy] RPC response: id=%d total_len=%d\n",
                    id, pn + body_len + 1);
            fflush(stderr);

            free(resp);
            return 1;
        }
    }

    /* 未知方法 */
    {
        char resp[256];
        int n = snprintf(resp, sizeof(resp),
            "{\"id\":%d,\"ok\":false,\"error\":\"Unknown method: %s\"}\n", id, method);
        send(client, resp, n, 0);
    }
    return 1;
}

/* ======================== 清理 ======================== */

static void cleanup(void) {
    if (dll_initialized && p_wcdb_shutdown) {
        p_wcdb_shutdown();
        dll_initialized = 0;
    }
    if (dll) {
        FreeLibrary(dll);
        dll = NULL;
    }
    WSACleanup();
}

/* ======================== 主入口 ======================== */

static void print_usage(const char *exe) {
    fprintf(stderr,
        "WeMessage WCDB API Proxy\n"
        "Usage: %s [--port PORT] [--resources PATH]\n"
        "  --port PORT       TCP port to listen on (default: %d)\n"
        "  --resources PATH  Path to resources directory (default: .)\n",
        exe, DEFAULT_PORT);
}

int main(int argc, char **argv) {
    int port = DEFAULT_PORT;
    const char *resources = ".";

    /* 解析命令行参数 */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = atoi(argv[++i]);
            if (port <= 0 || port > 65535) port = DEFAULT_PORT;
        } else if (strcmp(argv[i], "--resources") == 0 && i + 1 < argc) {
            resources = argv[++i];
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        }
    }

    /* 初始化 Winsock */
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "[proxy] WSAStartup failed\n");
        return 1;
    }

    /* 加载 DLL */
    if (!load_dll(resources)) {
        fprintf(stderr, "[proxy] Failed to load wcdb_api.dll\n");
        WSACleanup();
        return 1;
    }

    /* 创建 TCP 服务器 */
    SOCKET server = create_server(port);
    if (server == INVALID_SOCKET) {
        fprintf(stderr, "[proxy] Failed to create TCP server\n");
        cleanup();
        return 1;
    }

    fprintf(stderr, "[proxy] Listening on %s:%d, resources=%s\n",
            DEFAULT_HOST, port, resources_path);
    fprintf(stderr, "[proxy] READY\n");
    fflush(stderr);

    /* 主循环：接受连接并处理请求 */
    while (1) {
        struct sockaddr_in client_addr;
        int addr_len = sizeof(client_addr);
        SOCKET client = accept(server, (struct sockaddr*)&client_addr, &addr_len);
        if (client == INVALID_SOCKET) {
            fprintf(stderr, "[proxy] accept() failed: %d\n", WSAGetLastError());
            continue;
        }

        /* 处理该连接上的请求，直到断开 */
        fprintf(stderr, "[proxy] Client connected\n");
        fflush(stderr);
        while (handle_client(client)) {
            /* continue */
        }

        closesocket(client);
        fprintf(stderr, "[proxy] Client disconnected\n");
        fflush(stderr);
    }

    closesocket(server);
    cleanup();
    return 0;
}
