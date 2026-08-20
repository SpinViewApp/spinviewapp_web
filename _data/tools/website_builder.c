/*
 * SpinView website builder
 * -------------------------
 * C99, Windows-native. No third-party libraries. No script runtime.
 *
 *  - Scans _data/<type>/<folder>/project.json
 *  - Validates each project.json (string-aware structural scan).
 *    Malformed project.json = hard error (exact path + reason), no writes.
 *  - Injects "_base":"./_data/<type>/<folder>/" into each project object so
 *    media paths resolve both over http(s) and from file://.
 *  - Injects "number" from the folder name for SpinFX entries that lack it.
 *  - Sorts projects (featured first, then featured_order, then title) and
 *    SpinFX (descending numeric "number", never string).
 *  - Merges _data/notes.json (its top-level "notes" array) if present.
 *  - Builds ONE in-memory catalog used for BOTH _data/catalog.json and the
 *    inline SPINVIEW_CATALOG constant inside index_source.html -> index.html
 *    so the two can never diverge.
 *  - Bumps version.txt -> version.js ONLY after all read-only validation
 *    passes; failed builds never consume a version number.
 *  - Writes .tmp files first, then atomically replaces the finals.
 *
 * Usage: website_builder.exe [project_root]
 *        (project_root defaults to the current directory)
 */

#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#  include <windows.h>
#else
#  include <sys/stat.h>
#  include <errno.h>
#  include <dirent.h>
#endif

#define MAX_SUBDIRS 512
#define MAX_NAME    260

/* ------------------------------ dynamic string ---------------------------- */

typedef struct {
    char  *s;
    size_t len;
    size_t cap;
} Str;

static void str_init(Str *b) {
    b->s = NULL;
    b->len = 0;
    b->cap = 0;
}

static void str_free(Str *b) {
    free(b->s);
    str_init(b);
}

static int str_reserve(Str *b, size_t extra) {
    if (b->len + extra + 1 <= b->cap) return 0;
    size_t nc = b->cap ? b->cap : 128;
    while (nc < b->len + extra + 1) nc *= 2;
    char *ns = (char *)realloc(b->s, nc);
    if (!ns) return -1;
    b->s = ns;
    b->cap = nc;
    return 0;
}

static void str_append(Str *b, const void *data, size_t n) {
    if (!n) return;
    if (str_reserve(b, n)) return;
    memcpy(b->s + b->len, data, n);
    b->len += n;
    b->s[b->len] = '\0';
}

static void str_append_cstr(Str *b, const char *s) {
    str_append(b, s, strlen(s));
}

static void str_char(Str *b, char c) {
    str_append(b, &c, 1);
}

/* -------------------------------- tiny utils ------------------------------ */

static int is_ws(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static void skip_ws(const char *s, size_t n, size_t *i) {
    while (*i < n && is_ws(s[*i])) (*i)++;
}

static char *read_file(const char *path, size_t *out_len) {
    FILE    *f = fopen(path, "rb");
    long     sz;
    char    *buf;
    size_t   got;
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    sz = ftell(f);
    if (sz < 0) { fclose(f); return NULL; }
    rewind(f);
    buf = (char *)malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    if (got >= 3 && (unsigned char)buf[0] == 0xEF &&
        (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) {
        memmove(buf, buf + 3, got - 3);
        got -= 3;
    }
    buf[got] = '\0';
    if (out_len) *out_len = got;
    return buf;
}

static int ensure_dir(const char *path) {
#ifdef _WIN32
    if (CreateDirectoryA(path, NULL)) return 0;
    return GetLastError() == ERROR_ALREADY_EXISTS ? 0 : -1;
#else
    if (mkdir(path, 0755) == 0) return 0;
    return errno == EEXIST ? 0 : -1;
#endif
}

static int move_replace(const char *from, const char *to) {
#ifdef _WIN32
    return MoveFileExA(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED) ? 0 : -1;
#else
    remove(to);
    return rename(from, to);
#endif
}

/* Write via <path>.tmp then atomically replace <path>. */
static int atomic_write(const char *path, const char *data, size_t len) {
    char  tmp[MAX_NAME * 4];
    FILE *f;
    size_t wn;
    if ((size_t)snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= sizeof(tmp)) return -1;
    f = fopen(tmp, "wb");
    if (!f) return -1;
    wn = fwrite(data, 1, len, f);
    if (wn != len || fclose(f) != 0) { remove(tmp); return -1; }
    if (move_replace(tmp, path) != 0) { remove(tmp); return -1; }
    return 0;
}

/* List immediate subdirectories of `path` into names[][]. Returns count. */
static int list_subdirs(const char *path, char names[MAX_SUBDIRS][MAX_NAME]) {
    int count = 0;
#ifdef _WIN32
    char pat[MAX_NAME * 4];
    int plen = (int)strlen(path);
    int has_sep = plen > 0 && (path[plen - 1] == '\\' || path[plen - 1] == '/');
    WIN32_FIND_DATAA fd;
    HANDLE h;
    if ((size_t)snprintf(pat, sizeof(pat), "%s%s*", path, has_sep ? "" : "\\") >= sizeof(pat)) return 0;
    h = FindFirstFileA(pat, &fd);
    if (h == INVALID_HANDLE_VALUE) return 0;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (strcmp(fd.cFileName, ".") != 0 && strcmp(fd.cFileName, "..") != 0 &&
                count < MAX_SUBDIRS) {
                memcpy(names[count], fd.cFileName, MAX_NAME - 1);
                names[count][MAX_NAME - 1] = '\0';
                count++;
            }
        }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
#else
    DIR           *d = opendir(path);
    struct dirent *de;
    if (!d) return 0;
    while ((de = readdir(d)) != NULL && count < MAX_SUBDIRS) {
        if (de->d_name[0] == '.') continue;
        if (de->d_type == DT_DIR) {
            strncpy(names[count], de->d_name, MAX_NAME - 1);
            names[count][MAX_NAME - 1] = '\0';
            count++;
        }
    }
    closedir(d);
#endif
    return count;
}

/* --------------------------- minimal JSON scanner -------------------------- */

static const char *scan_reason = NULL;

/* Consume a JSON string starting at s[*i] == '"'. */
static int scan_string(const char *s, size_t n, size_t *i) {
    if (*i >= n || s[*i] != '"') { scan_reason = "not a string"; return -1; }
    (*i)++;
    while (*i < n) {
        char c = s[*i];
        if (c == '"') { (*i)++; return 0; }
        if (c == '\\') {
            (*i)++;
            if (*i >= n) { scan_reason = "unterminated string"; return -1; }
            if (s[*i] == 'u') {
                int k;
                (*i)++;
                for (k = 0; k < 4; k++) {
                    char h;
                    if (*i >= n) { scan_reason = "unterminated string"; return -1; }
                    h = s[*i];
                    if (!((h >= '0' && h <= '9') || (h >= 'a' && h <= 'f') || (h >= 'A' && h <= 'F'))) {
                        scan_reason = "invalid \\u escape in string";
                        return -1;
                    }
                    (*i)++;
                }
            } else {
                (*i)++;
            }
        } else if (c == '\n' || c == '\r') {
            scan_reason = "unterminated string";
            return -1;
        } else {
            (*i)++;
        }
    }
    scan_reason = "unterminated string";
    return -1;
}

/* Consume one JSON value; *i must already be at the value start. */
static int scan_value(const char *s, size_t n, size_t *i) {
    char c;
    if (*i >= n) { scan_reason = "unexpected end of file"; return -1; }
    c = s[*i];
    if (c == '"') return scan_string(s, n, i);
    if (c == '{' || c == '[') {
        char open = c, close = (c == '{') ? '}' : ']';
        int  depth = 0;
        for (;;) {
            if (*i >= n) { scan_reason = (open == '{') ? "unterminated object" : "unterminated array"; return -1; }
            c = s[*i];
            if (c == '"') {
                if (scan_string(s, n, i)) return -1;
                continue;
            }
            if (c == open) { depth++; (*i)++; continue; }
            if (c == close) {
                depth--;
                (*i)++;
                if (depth == 0) return 0;
                continue;
            }
            (*i)++;
        }
    }
    /* primitive token */
    while (*i < n) {
        char d = s[*i];
        if (is_ws(d) || d == ',' || d == ']' || d == '}' || d == ':') break;
        (*i)++;
    }
    return 0;
}

/* Validate a whole document; on success *vstart and *vend span the top value. */
static int scan_document(const char *s, size_t n, size_t *vstart, size_t *vend) {
    size_t i = 0;
    skip_ws(s, n, &i);
    *vstart = i;
    if (i >= n) { scan_reason = "empty document"; return -1; }
    if (scan_value(s, n, &i)) return -1;
    *vend = i;
    skip_ws(s, n, &i);
    if (i < n) { scan_reason = "trailing content after JSON value"; return -1; }
    return 0;
}

/* Find a top-level object member by name.
   Returns 1 (found, vb/vn = raw value span), 0 (absent), -1 (malformed). */
static int find_member(const char *s, size_t n, const char *key, size_t *vb, size_t *vn) {
    size_t keylen = strlen(key);
    size_t i = 0;
    size_t vs;
    skip_ws(s, n, &i);
    if (i >= n || s[i] != '{') { scan_reason = "expected object '{'"; return -1; }
    i++;
    for (;;) {
        size_t ks, kl;
        skip_ws(s, n, &i);
        if (i >= n) { scan_reason = "unterminated object"; return -1; }
        if (s[i] == '}') return 0;
        if (s[i] != '"') { scan_reason = "expected object key string"; return -1; }
        ks = i;
        if (scan_string(s, n, &i)) return -1;
        kl = i - ks; /* includes both quotes */
        skip_ws(s, n, &i);
        if (i >= n || s[i] != ':') { scan_reason = "expected ':' after object key"; return -1; }
        i++;
        skip_ws(s, n, &i);
        if (i >= n) { scan_reason = "unterminated object"; return -1; }
        vs = i;
        if (scan_value(s, n, &i)) return -1;
        if (kl == keylen + 2 && memcmp(s + ks + 1, key, keylen) == 0) {
            *vb = vs;
            *vn = i - vs;
            return 1;
        }
        skip_ws(s, n, &i);
        if (i >= n) { scan_reason = "unterminated object"; return -1; }
        if (s[i] == ',') { i++; continue; }
        if (s[i] == '}') return 0;
        scan_reason = "expected ',' or '}' between object members";
        return -1;
    }
}

/* ------------------------- simple value interpretation --------------------- */

static long json_value_long(const char *s, size_t n) {
    size_t i = 0;
    long   val = 0;
    int    neg = 0, any = 0;
    while (i < n && (is_ws(s[i]) || s[i] == '"')) i++;
    if (i < n && (s[i] == '-' || s[i] == '+')) { neg = (s[i] == '-'); i++; }
    for (; i < n; i++) {
        char c = s[i];
        if (c >= '0' && c <= '9') { val = val * 10 + (c - '0'); any = 1; }
        else if (any) break;
    }
    (void)any;
    return neg ? -val : val;
}

static int json_value_bool(const char *s, size_t n) {
    size_t i = 0;
    while (i < n && (is_ws(s[i]) || s[i] == '"')) i++;
    return i < n && s[i] == 't';
}

static void json_value_text(const char *s, size_t n, char *out, size_t outcap) {
    size_t i = 0;
    if (!outcap) return;
    out[0] = '\0';
    while (i < n && is_ws(s[i])) i++;
    if (i < n && s[i] == '"') {
        size_t end = (n && s[n - 1] == '"') ? n - 1 : n;
        size_t cnt;
        i++;
        if (end <= i) return;
        cnt = end - i;
        if (cnt >= outcap) cnt = outcap - 1;
        memcpy(out, s + i, cnt);
        out[cnt] = '\0';
        return;
    }
    {
        size_t cnt = n - i;
        if (cnt >= outcap) cnt = outcap - 1;
        if (cnt) memcpy(out, s + i, cnt);
        out[cnt] = '\0';
    }
}

/* Sanitize an already-valid JSON fragment so it can safely appear inside a
   <script> block: escape '<' and '>' (kills any possible </script> / <!--). */
static void str_body_sanitize(Str *b, const char *s, size_t n) {
    size_t i;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '<')      str_append_cstr(b, "\\u003c");
        else if (c == '>') str_append_cstr(b, "\\u003e");
        else               str_char(b, (char)c);
    }
}

/* JSON-string a generated string value (escape quotes/backslashes/controls). */
static void str_json_string(Str *b, const char *s) {
    size_t n = strlen(s), i;
    str_char(b, '"');
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  str_append_cstr(b, "\\\""); break;
            case '\\': str_append_cstr(b, "\\\\");  break;
            case '\b': str_append_cstr(b, "\\b");   break;
            case '\f': str_append_cstr(b, "\\f");   break;
            case '\n': str_append_cstr(b, "\\n");   break;
            case '\r': str_append_cstr(b, "\\r");   break;
            case '\t': str_append_cstr(b, "\\t");   break;
            default:
                if (c < 0x20) {
                    char tmp[8];
                    sprintf(tmp, "\\u%04x", c);
                    str_append_cstr(b, tmp);
                } else {
                    str_char(b, (char)c);
                }
        }
    }
    str_char(b, '"');
}

/* ------------------------------ project items ------------------------------ */

typedef struct {
    char   *type;          /* e.g. "game"                              */
    char   *folder;        /* e.g. "numeris"                           */
    char   *json;          /* raw project.json bytes (NUL-terminated)  */
    size_t  json_len;
    char   *base;          /* "./_data/<type>/<folder>/"               */
    size_t  obj_start;     /* offset of '{'                            */
    size_t  obj_end;       /* offset just past '}'                     */
    int     is_spinfx;
    long    number;
    int     had_number;
    int     featured;
    long    featured_order;
    int     has_fo;
    char    title[MAX_NAME];
} Item;

typedef struct {
    Item  *v;
    size_t len;
    size_t cap;
} ItemArr;

static void arr_free(ItemArr *a) {
    size_t i;
    for (i = 0; i < a->len; i++) {
        free(a->v[i].type);
        free(a->v[i].folder);
        free(a->v[i].json);
        free(a->v[i].base);
    }
    free(a->v);
    a->v = NULL;
    a->len = a->cap = 0;
}

static int arr_push(ItemArr *a, const Item *it) {
    if (a->len == a->cap) {
        size_t nc = a->cap ? a->cap * 2 : 16;
        Item  *nv = (Item *)realloc(a->v, nc * sizeof(Item));
        if (!nv) return -1;
        a->v = nv;
        a->cap = nc;
    }
    a->v[a->len++] = *it;
    return 0;
}

static int cmp_project(const void *pa, const void *pb) {
    const Item *a = (const Item *)pa, *b = (const Item *)pb;
    int fa = a->featured, fb = b->featured;
    if (fa != fb) return fb - fa;
    {
        long oa = a->has_fo ? a->featured_order : 9999L;
        long ob = b->has_fo ? b->featured_order : 9999L;
        if (oa != ob) return oa < ob ? -1 : 1;
    }
    return strcmp(a->title, b->title);
}

static int cmp_spinfx(const void *pa, const void *pb) {
    const Item *a = (const Item *)pa, *b = (const Item *)pb;
    return (b->number > a->number) - (b->number < a->number);
}

/* ------------------------------ serialization ------------------------------ */

static void emit_item(Str *out, const Item *it) {
    size_t bs = it->obj_start + 1;
    size_t be = it->obj_end ? it->obj_end - 1 : it->json_len;
    str_char(out, '{');
    while (bs < be && is_ws(it->json[bs])) bs++;
    while (be > bs && is_ws(it->json[be - 1])) be--;
    if (bs < be) {
        str_body_sanitize(out, it->json + bs, be - bs);
        str_char(out, ',');
    }
    str_append_cstr(out, "\"_base\":");
    str_json_string(out, it->base);
    if (it->is_spinfx && !it->had_number) {
        char nb[48];
        sprintf(nb, ",\"number\":%ld", it->number);
        str_append_cstr(out, nb);
    }
    str_char(out, '}');
}

/* --------------------------------- version --------------------------------- */

/* Parse "v0031" (or "0031"); compute the next value.
   Returns 0 on success, -1 when no version digits are present. */
static int next_version(const char *txt, char out[MAX_NAME]) {
    size_t n = strlen(txt);
    size_t first, dstart, dend, pl, k;
    long   num = 0, nxt;
    int    width;
    char   pre[MAX_NAME];
    while (n > 0 && (txt[n - 1] == '\n' || txt[n - 1] == '\r' ||
                     txt[n - 1] == ' ' || txt[n - 1] == '\t')) n--;
    first = 0;
    while (first < n && is_ws(txt[first])) first++;
    dstart = first;
    while (dstart < n && !(txt[dstart] >= '0' && txt[dstart] <= '9')) dstart++;
    if (dstart >= n) return -1;
    dend = dstart;
    while (dend < n && txt[dend] >= '0' && txt[dend] <= '9') dend++;
    for (k = dstart; k < dend; k++) num = num * 10 + (txt[k] - '0');
    width = (int)(dend - dstart);
    if (width < 4) width = 4;
    pl = dstart - first;
    if (pl >= sizeof(pre)) pl = sizeof(pre) - 1;
    memcpy(pre, txt + first, pl);
    pre[pl] = '\0';
    nxt = num + 1;
    snprintf(out, MAX_NAME, "%s%0*ld", pre, width, nxt);
    return 0;
}

/* -------------------------------- build loop ------------------------------- */

static void perr(const char *path, const char *reason) {
    fprintf(stderr, "[SpinView] ERROR %s : %s\n", path, reason);
}

static char *dup_str(const char *s) {
    char *d = (char *)malloc(strlen(s) + 1);
    if (d) strcpy(d, s);
    return d;
}

static int dir_exists(const char *p) {
#ifdef _WIN32
    DWORD a = GetFileAttributesA(p);
    return (a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY)) ? 1 : 0;
#else
    DIR *d = opendir(p);
    if (!d) return 0;
    closedir(d);
    return 1;
#endif
}

static int build(const char *root) {
    ItemArr proj = {NULL, 0, 0}, spin = {NULL, 0, 0};
    const char *BN = "/* SPINVIEW_CATALOG_BEGIN */";
    const char *EN = "/* SPINVIEW_CATALOG_END */";
    char  path[MAX_NAME * 4];
    char  dataDir[MAX_NAME * 4];
    size_t src_len, nlen;
    char *src = NULL, *vtxt = NULL, *nb = NULL;
    char *notes_buf = NULL;
    size_t notes_vs = 0, notes_vn = 0;
    int have_notes = 0;
    Str cat;
    Str out;
    char newver[MAX_NAME];
    char oldver[MAX_NAME];
    char vjs[256];
    int rc = 1;
    size_t i;

    str_init(&cat);
    str_init(&out);

    /* ---- index_source.html + markers (read-only validation #1) ---- */
    snprintf(path, sizeof(path), "%s/index_source.html", root);
    src = read_file(path, &src_len);
    if (!src) { perr(path, "cannot read"); goto cleanup; }
    {
        char *b = strstr(src, BN);
        char *e = strstr(src, EN);
        if (!b || !e || e < b) {
            perr("index_source.html", "missing SPINVIEW_CATALOG_BEGIN/END markers");
            goto cleanup;
        }
    }

    /* ---- scan _data (read-only validation #2) ---- */
    snprintf(path, sizeof(path), "%s/_data", root);
    snprintf(dataDir, sizeof(dataDir), "%s", path);
    if (!dir_exists(dataDir)) {
        fprintf(stderr, "[SpinView] WARN _data : folder missing; building empty catalog\n");
    } else {
        char typeDirs[MAX_SUBDIRS][MAX_NAME];
        int nTypes = list_subdirs(dataDir, typeDirs);
        int t;
        for (t = 0; t < nTypes; t++) {
            char tdir[MAX_NAME * 4];
            int is_spinfx;
            int p;
            char projDirs[MAX_SUBDIRS][MAX_NAME];
            int nProj;
            if (!strcmp(typeDirs[t], "catalog") || !strcmp(typeDirs[t], "tools")) continue;
            snprintf(tdir, sizeof(tdir), "%s/%s", dataDir, typeDirs[t]);
            is_spinfx = !strcmp(typeDirs[t], "spinfx");
            nProj = list_subdirs(tdir, projDirs);
            for (p = 0; p < nProj; p++) {
                char pj[MAX_NAME * 4];
                size_t jlen, vs, ve, vb, vn;
                char *j;
                int r;
                Item it;
                snprintf(pj, sizeof(pj), "%s/%s/project.json", tdir, projDirs[p]);
                j = read_file(pj, &jlen);
                if (!j) continue; /* no project.json -> skip gracefully */

                if (scan_document(j, jlen, &vs, &ve) != 0) {
                    perr(pj, scan_reason ? scan_reason : "invalid JSON");
                    free(j);
                    goto cleanup;
                }
                if (vs >= ve || j[vs] != '{') {
                    perr(pj, "top-level value must be a JSON object");
                    free(j);
                    goto cleanup;
                }

                memset(&it, 0, sizeof(it));
                it.type = dup_str(typeDirs[t]);
                it.folder = dup_str(projDirs[p]);
                it.is_spinfx = is_spinfx;
                it.json = j;
                it.json_len = jlen;
                it.obj_start = vs;
                it.obj_end = ve;
                {
                    size_t blen = strlen("./_data/") + strlen(typeDirs[t]) +
                                  strlen(projDirs[p]) + 3;
                    it.base = (char *)malloc(blen);
                    if (!it.base) { perr(pj, "out of memory"); free(j); goto cleanup; }
                    sprintf(it.base, "./_data/%s/%s/", typeDirs[t], projDirs[p]);
                }

                r = find_member(j, jlen, "featured", &vb, &vn);
                if (r < 0) { perr(pj, scan_reason); goto item_fail; }
                if (r == 1) it.featured = json_value_bool(j + vb, vn);

                r = find_member(j, jlen, "featured_order", &vb, &vn);
                if (r < 0) { perr(pj, scan_reason); goto item_fail; }
                if (r == 1) { it.featured_order = json_value_long(j + vb, vn); it.has_fo = 1; }

                r = find_member(j, jlen, "title", &vb, &vn);
                if (r < 0) { perr(pj, scan_reason); goto item_fail; }
                if (r == 1) json_value_text(j + vb, vn, it.title, sizeof(it.title));

                if (is_spinfx) {
                    r = find_member(j, jlen, "number", &vb, &vn);
                    if (r < 0) { perr(pj, scan_reason); goto item_fail; }
                    if (r == 1) { it.number = json_value_long(j + vb, vn); it.had_number = 1; }
                    else { it.number = atol(projDirs[p]); }
                }

                if (arr_push(is_spinfx ? &spin : &proj, &it) != 0) {
                    perr(pj, "out of memory");
                    goto item_fail;
                }
                continue;

item_fail:
                free(it.type);
                free(it.folder);
                free(it.base);
                free(j);
                goto cleanup;
            }
        }
    }

    /* ---- notes.json (optional, warnings only) ---- */
    snprintf(path, sizeof(path), "%s/_data/notes.json", root);
    nb = read_file(path, &nlen);
    if (nb) {
        size_t nvs, nve;
        if (scan_document(nb, nlen, &nvs, &nve) == 0) {
            size_t mvb, mvn;
            int mr = find_member(nb, nlen, "notes", &mvb, &mvn);
            if (mr == 1) { notes_buf = nb; notes_vs = mvb; notes_vn = mvn; have_notes = 1; }
            else if (mr < 0) fprintf(stderr, "[SpinView] WARN _data/notes.json : %s\n", scan_reason);
        } else {
            fprintf(stderr, "[SpinView] WARN _data/notes.json : %s\n",
                    scan_reason ? scan_reason : "invalid JSON");
        }
    }

    /* ---- version (read-only validation #3, still before any write) ---- */
    oldver[0] = '\0';
    snprintf(path, sizeof(path), "%s/version.txt", root);
    vtxt = read_file(path, &nlen);
    if (!vtxt) {
        fprintf(stderr, "[SpinView] WARN version.txt : missing; starting at v0001\n");
        strncpy(oldver, "v0000", sizeof(oldver));
    } else {
        strncpy(oldver, vtxt, sizeof(oldver) - 1);
        oldver[sizeof(oldver) - 1] = '\0';
    }
    if (next_version(oldver, newver) != 0) {
        perr("version.txt", "no version digits found");
        goto cleanup;
    }

    /* ---- sort ---- */
    if (proj.len) qsort(proj.v, proj.len, sizeof(Item), cmp_project);
    if (spin.len) qsort(spin.v, spin.len, sizeof(Item), cmp_spinfx);

    /* ---- serialize the single in-memory catalog ---- */
    {
        time_t now = time(NULL);
        struct tm *lt = localtime(&now);
        char gen[40];
        strftime(gen, sizeof(gen), "%Y-%m-%dT%H:%M:%S", lt);
        str_append_cstr(&cat, "{\"generated\":");
        str_json_string(&cat, gen);
        str_append_cstr(&cat, ",\"projects\":[");
        for (i = 0; i < proj.len; i++) { if (i) str_char(&cat, ','); emit_item(&cat, &proj.v[i]); }
        str_append_cstr(&cat, "],\"spinfx\":[");
        for (i = 0; i < spin.len; i++) { if (i) str_char(&cat, ','); emit_item(&cat, &spin.v[i]); }
        str_append_cstr(&cat, "]");
        if (have_notes) {
            str_append_cstr(&cat, ",\"notes\":");
            str_body_sanitize(&cat, notes_buf + notes_vs, notes_vn);
        }
        str_append_cstr(&cat, "}");
    }

    /* ---- write outputs (version files last so failed runs never consume) ---- */
    snprintf(path, sizeof(path), "%s/_data", root);
    if (ensure_dir(path) != 0) { perr("_data", "cannot create directory"); goto cleanup; }

    snprintf(path, sizeof(path), "%s/_data/catalog.json", root);
    if (atomic_write(path, cat.s, cat.len) != 0) { perr(path, "cannot write"); goto cleanup; }
    printf("[SpinView] Wrote %s\n", path);

    snprintf(path, sizeof(path), "%s/index.html", root);
    {
        char *b = strstr(src, BN);
        char *e = strstr(src, EN);
        size_t bend = (size_t)(b + strlen(BN) - src);
        size_t estr = (size_t)(e - src);
        str_init(&out);
        str_append(&out, src, bend);
        str_append(&out, cat.s, cat.len);
        str_append(&out, src + estr, src_len - estr);
        if (atomic_write(path, out.s, out.len) != 0) { perr(path, "cannot write"); str_free(&out); goto cleanup; }
        str_free(&out);
    }
    printf("[SpinView] Wrote %s\n", path);

    snprintf(path, sizeof(path), "%s/version.js", root);
    snprintf(vjs, sizeof(vjs), "window.SPINVIEW_VERSION=\"%s\";\n", newver);
    if (atomic_write(path, vjs, strlen(vjs)) != 0) { perr(path, "cannot write"); goto cleanup; }
    printf("[SpinView] Wrote %s\n", path);

    snprintf(path, sizeof(path), "%s/version.txt", root);
    {
        size_t nl = strlen(newver);
        char vt[MAX_NAME + 2];
        memcpy(vt, newver, nl);
        vt[nl] = '\n';
        vt[nl + 1] = '\0';
        if (atomic_write(path, vt, nl + 1) != 0) { perr(path, "cannot write"); goto cleanup; }
    }
    printf("[SpinView] Wrote %s\n", path);

    printf("[SpinView] %zu project(s), %zu spinfx, notes %s\n",
           proj.len, spin.len, have_notes ? "merged" : "none");
    printf("[SpinView] Version %s\n", newver);
    printf("[SpinView] Build OK.\n");
    rc = 0;

cleanup:
    free(src);
    free(vtxt);
    if (nb && nb != notes_buf) free(nb);
    free(notes_buf);
    str_free(&cat);
    str_free(&out);
    arr_free(&proj);
    arr_free(&spin);
    return rc;
}

int main(int argc, char **argv) {
    const char *root = (argc >= 2 && argv[1][0]) ? argv[1] : ".";
    char rootc[MAX_NAME * 4];
    size_t rl, i;
    strncpy(rootc, root, sizeof(rootc) - 1);
    rootc[sizeof(rootc) - 1] = '\0';
    rl = strlen(rootc);
    while (rl > 0 && (rootc[rl - 1] == '\\' || rootc[rl - 1] == '/' || rootc[rl - 1] == '"')) rootc[--rl] = '\0';
    for (i = 0; i < rl && (rootc[i] == '"' || is_ws(rootc[i])); i++);
    if (i) memmove(rootc, rootc + i, rl - i + 1);
    return build(rootc);
}