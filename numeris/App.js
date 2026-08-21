// include: shell.js
// include: minimum_runtime_check.js
(function() {
  // "30.0.0" -> 300000
  function humanReadableVersionToPacked(str) {
    str = str.split("-")[0];
    // Remove any trailing part from e.g. "12.53.3-alpha"
    var vers = str.split(".").slice(0, 3);
    while (vers.length < 3) vers.push("00");
    vers = vers.map((n, i, arr) => n.padStart(2, "0"));
    return vers.join("");
  }
  // 300000 -> "30.0.0"
  var packedVersionToHumanReadable = n => [ n / 1e4 | 0, (n / 100 | 0) % 100, n % 100 ].join(".");
  var TARGET_NOT_SUPPORTED = 2147483647;
  // Note: We use a typeof check here instead of optional chaining using
  // globalThis because older browsers might not have globalThis defined.
  var currentNodeVersion = typeof process !== "undefined" && process.versions?.node ? humanReadableVersionToPacked(process.versions.node) : TARGET_NOT_SUPPORTED;
  if (currentNodeVersion < 16e4) {
    throw new Error(`This emscripten-generated code requires node v${packedVersionToHumanReadable(16e4)} (detected v${packedVersionToHumanReadable(currentNodeVersion)})`);
  }
  var userAgent = typeof navigator !== "undefined" && navigator.userAgent;
  if (!userAgent) {
    return;
  }
  var currentSafariVersion = userAgent.includes("Safari/") && !userAgent.includes("Chrome/") && userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/) ? humanReadableVersionToPacked(userAgent.match(/Version\/(\d+\.?\d*\.?\d*)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentSafariVersion < 15e4) {
    throw new Error(`This emscripten-generated code requires Safari v${packedVersionToHumanReadable(15e4)} (detected v${currentSafariVersion})`);
  }
  var currentFirefoxVersion = userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/) ? parseFloat(userAgent.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentFirefoxVersion < 79) {
    throw new Error(`This emscripten-generated code requires Firefox v79 (detected v${currentFirefoxVersion})`);
  }
  var currentChromeVersion = userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/) ? parseFloat(userAgent.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]) : TARGET_NOT_SUPPORTED;
  if (currentChromeVersion < 85) {
    throw new Error(`This emscripten-generated code requires Chrome v85 (detected v${currentChromeVersion})`);
  }
})();

// end include: minimum_runtime_check.js
// The Module object: Our interface to the outside world. We import
// and export values on it. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(moduleArg) => Promise<Module>
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to check if Module already exists (e.g. case 3 above).
// Substitution will be replaced with actual code on later stage of the build,
// this way Closure Compiler will not mangle it (e.g. case 4. above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module = typeof Module != "undefined" ? Module : {};

// Determine the runtime environment we are in. You can customize this by
// setting the ENVIRONMENT setting at compile time (see settings.js).
// Attempt to auto-detect the environment
var ENVIRONMENT_IS_WEB = !!globalThis.window;

var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;

// N.b. Electron.js environment is simultaneously a NODE-environment, but
// also a web environment.
var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

// --pre-jses are emitted after the Module integration code, so that they can
// refer to Module (if they choose; they can also define Module)
// include: web/fs_assets.js
/* Numeris web: copy pane/layout/Rc next to App, then pull them into MEMFS
 * before main() (no --preload-file / file_packager).
 * Linked with: --pre-js web/fs_assets.js
 */ (function() {
  var M = (typeof Module !== "undefined") ? Module : (window.Module = window.Module || {});
  M.preRun = M.preRun || [];
  var ASSETS = [ "pane/options.pane", "layout/layout.json", "Rc/font/legacy_clean.sdffont.json", "Rc/defaults/app.json", "Rc/localization/en.json", "Rc/localization/fr.json" ];
  function ensureDir(path) {
    var parts = path.split("/");
    var dir = "";
    for (var i = 0; i < parts.length - 1; i++) {
      dir = dir ? (dir + "/" + parts[i]) : parts[i];
      try {
        FS.mkdir(dir);
      } catch (e) {}
    }
  }
  function assetUrl(path) {
    var v = "dev", t = Date.now(), sep;
    try {
      if (typeof window !== "undefined") {
        if (typeof window.getCurrentVersion === "function") v = window.getCurrentVersion() || v;
        if (window.__spinBootTok) t = window.__spinBootTok;
      }
    } catch (e) {}
    sep = path.indexOf("?") >= 0 ? "&" : "?";
    return path + sep + "_v=" + encodeURIComponent(v) + "&_t=" + t;
  }
  function fnv1a32(bytes) {
    var hash = 2166136261, hex;
    for (var i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    hex = (hash >>> 0).toString(16);
    return "00000000".slice(hex.length) + hex;
  }
  function logSdfFontDiag(path, bytes) {
    var doc, glyphs, keys, gKey = "", i;
    if (path !== "Rc/font/legacy_clean.sdffont.json") return;
    try {
      doc = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      glyphs = doc && doc.glyphs ? doc.glyphs : {};
      keys = Object.keys(glyphs);
      for (i = 0; i < keys.length; i++) {
        if ((glyphs[keys[i]].codepoint | 0) === 71) {
          gKey = keys[i];
          break;
        }
      }
      console.info("[fs_assets][sdf-diag] bytes=" + bytes.byteLength + " fnv1a32=" + fnv1a32(bytes) + " declared=" + (doc.glyph_count | 0) + " nodes=" + keys.length + " U+0047=" + (gKey || "MISSING"));
    } catch (err) {
      console.error("[fs_assets][sdf-diag] parse failed bytes=" + bytes.byteLength + " fnv1a32=" + fnv1a32(bytes), err);
    }
  }
  function loadOne(path) {
    var dep = "numeris_asset:" + path;
    addRunDependency(dep);
    fetch(assetUrl(path), {
      credentials: "same-origin",
      cache: "no-store"
    }).then(function(res) {
      if (!res.ok) throw new Error(path + " HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function(buf) {
      var bytes = new Uint8Array(buf);
      ensureDir(path);
      FS.writeFile(path, bytes);
      if (typeof console !== "undefined" && console.info) console.info("[fs_assets] mounted", path, "(" + buf.byteLength + " bytes)");
      logSdfFontDiag(path, bytes);
      removeRunDependency(dep);
    }).catch(function(err) {
      if (typeof console !== "undefined" && console.error) console.error("[fs_assets] failed", path, err);
      removeRunDependency(dep);
    });
  }
  M.preRun.push(function() {
    for (var i = 0; i < ASSETS.length; i++) loadOne(ASSETS[i]);
  });
})();

// end include: web/fs_assets.js
var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
  throw toThrow;
};

// In MODULARIZE mode _scriptName needs to be captured already at the very top of the page immediately when the page is parsed, so it is generated there
// before the page load. In non-MODULARIZE modes generate it here.
var _scriptName = globalThis.document?.currentScript?.src;

if (typeof __filename != "undefined") {
  // Node
  _scriptName = __filename;
} else if (ENVIRONMENT_IS_WORKER) {
  _scriptName = self.location.href;
}

// `/` should be present at the end if `scriptDirectory` is not empty
var scriptDirectory = "";

function locateFile(path) {
  if (Module["locateFile"]) {
    return Module["locateFile"](path, scriptDirectory);
  }
  return scriptDirectory + path;
}

// Hooks that are implemented differently in different runtime environments.
var readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
  const isNode = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";
  if (!isNode) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
  // These modules will usually be used on Node.js. Load them eagerly to avoid
  // the complexity of lazy-loading.
  var fs = require("node:fs");
  scriptDirectory = __dirname + "/";
  // include: node_shell_read.js
  readBinary = filename => {
    // We need to re-wrap `file://` strings to URLs.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename);
    assert(Buffer.isBuffer(ret));
    return ret;
  };
  readAsync = async (filename, binary = true) => {
    // See the comment in the `readBinary` function.
    filename = isFileURI(filename) ? new URL(filename) : filename;
    var ret = fs.readFileSync(filename, binary ? undefined : "utf8");
    assert(binary ? Buffer.isBuffer(ret) : typeof ret == "string");
    return ret;
  };
  // end include: node_shell_read.js
  if (process.argv.length > 1) {
    thisProgram = process.argv[1].replace(/\\/g, "/");
  }
  arguments_ = process.argv.slice(2);
  // MODULARIZE will export the module in the proper place outside, we don't need to export here
  if (typeof module != "undefined") {
    module["exports"] = Module;
  }
  quit_ = (status, toThrow) => {
    process.exitCode = status;
    throw toThrow;
  };
} else if (ENVIRONMENT_IS_SHELL) {} else // Note that this includes Node.js workers when relevant (pthreads is enabled).
// Node.js workers are detected as a combination of ENVIRONMENT_IS_WORKER and
// ENVIRONMENT_IS_NODE.
if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
  try {
    scriptDirectory = new URL(".", _scriptName).href;
  } catch {}
  if (!(globalThis.window || globalThis.WorkerGlobalScope)) throw new Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
  {
    // include: web_or_worker_shell_read.js
    if (ENVIRONMENT_IS_WORKER) {
      readBinary = url => {
        var xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.responseType = "arraybuffer";
        xhr.send(null);
        return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
      };
    }
    readAsync = async url => {
      // Fetch has some additional restrictions over XHR, like it can't be used on a file:// url.
      // See https://github.com/github/fetch/pull/92#issuecomment-140665932
      // Cordova or Electron apps are typically loaded from a file:// url.
      // So use XHR on webview if URL is a file URL.
      if (isFileURI(url)) {
        return new Promise((resolve, reject) => {
          var xhr = new XMLHttpRequest;
          xhr.open("GET", url, true);
          xhr.responseType = "arraybuffer";
          xhr.onload = () => {
            if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) {
              // file URLs can return 0
              resolve(xhr.response);
              return;
            }
            reject(xhr.status);
          };
          xhr.onerror = reject;
          xhr.send(null);
        });
      }
      var response = await fetch(url, {
        credentials: "same-origin"
      });
      if (response.ok) {
        return response.arrayBuffer();
      }
      throw new Error(response.status + " : " + response.url);
    };
  }
} else {
  throw new Error("environment detection error");
}

var out = console.log.bind(console);

var err = console.error.bind(console);

// perform assertions in shell.js after we set up out() and err(), as otherwise
// if an assertion fails it cannot print the message
assert(!ENVIRONMENT_IS_SHELL, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");

// end include: shell.js
// include: preamble.js
// === Preamble library stuff ===
// Documentation for the public APIs defined in this file must be updated in:
//    site/source/docs/api_reference/preamble.js.rst
// A prebuilt local version of the documentation is available at:
//    site/build/text/docs/api_reference/preamble.js.txt
// You can also build docs locally as HTML or other formats in site/
// An online HTML version (which may be of a different version of Emscripten)
//    is up at http://kripken.github.io/emscripten-site/docs/api_reference/preamble.js.html
var wasmBinary;

if (!globalThis.WebAssembly) {
  err("no native wasm support detected");
}

// Wasm globals
//========================================
// Runtime essentials
//========================================
// whether we are quitting the application. no code should run after this.
// set in exit() and abort()
var ABORT = false;

// set by exit() and abort().  Passed to 'onExit' handler.
// NOTE: This is also used as the process return code in shell environments
// but only when noExitRuntime is false.
var EXITSTATUS;

// In STRICT mode, we only define assert() when ASSERTIONS is set.  i.e. we
// don't define it at all in release modes.  This matches the behaviour of
// MINIMAL_RUNTIME.
// TODO(sbc): Make this the default even without STRICT enabled.
/** @type {function(*, string=)} */ function assert(condition, text) {
  if (!condition) {
    abort("Assertion failed" + (text ? ": " + text : ""));
  }
}

// We used to include malloc/free by default in the past. Show a helpful error in
// builds with assertions.
/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

// include: runtime_common.js
// include: runtime_stack_check.js
// Initializes the stack cookie. Called at the startup of main and at the startup of each thread in pthreads mode.
function writeStackCookie() {
  var max = _emscripten_stack_get_end();
  assert((max & 3) == 0);
  // If the stack ends at address zero we write our cookies 4 bytes into the
  // stack.  This prevents interference with SAFE_HEAP and ASAN which also
  // monitor writes to address zero.
  if (max == 0) {
    max += 4;
  }
  // The stack grow downwards towards _emscripten_stack_get_end.
  // We write cookies to the final two words in the stack and detect if they are
  // ever overwritten.
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((max) >> 2), "storing")] = 34821223;
  checkInt32(34821223);
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((max) + (4)) >> 2), "storing")] = 2310721022;
  checkInt32(2310721022);
}

function checkStackCookie() {
  if (ABORT) return;
  var max = _emscripten_stack_get_end();
  // See writeStackCookie().
  if (max == 0) {
    max += 4;
  }
  var cookie1 = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((max) >> 2), "loading")];
  var cookie2 = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((max) + (4)) >> 2), "loading")];
  if (cookie1 != 34821223 || cookie2 != 2310721022) {
    abort(`Stack overflow! Stack cookie has been overwritten at ${ptrToString(max)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${ptrToString(cookie2)} ${ptrToString(cookie1)}`);
  }
}

// end include: runtime_stack_check.js
// include: runtime_exceptions.js
// end include: runtime_exceptions.js
// include: runtime_debug.js
var runtimeDebug = true;

// Switch to false at runtime to disable logging at the right times
// Used by XXXXX_DEBUG settings to output debug messages.
function dbg(...args) {
  if (!runtimeDebug && typeof runtimeDebug != "undefined") return;
  // TODO(sbc): Make this configurable somehow.  Its not always convenient for
  // logging to show up as warnings.
  console.warn(...args);
}

// Endianness check
(() => {
  var h16 = new Int16Array(1);
  var h8 = new Int8Array(h16.buffer);
  h16[0] = 25459;
  if (h8[0] !== 115 || h8[1] !== 99) abort("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
})();

function consumedModuleProp(prop) {
  if (!Object.getOwnPropertyDescriptor(Module, prop)) {
    Object.defineProperty(Module, prop, {
      configurable: true,
      set() {
        abort(`Attempt to set \`Module.${prop}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
      }
    });
  }
}

function makeInvalidEarlyAccess(name) {
  return () => assert(false, `call to '${name}' via reference taken before Wasm module initialization`);
}

function ignoredModuleProp(prop) {
  if (Object.getOwnPropertyDescriptor(Module, prop)) {
    abort(`\`Module.${prop}\` was supplied but \`${prop}\` not included in INCOMING_MODULE_JS_API`);
  }
}

// forcing the filesystem exports a few things by default
function isExportedByForceFilesystem(name) {
  return name === "FS_createPath" || name === "FS_createDataFile" || name === "FS_createPreloadedFile" || name === "FS_preloadFile" || name === "FS_unlink" || name === "addRunDependency" || // The old FS has some functionality that WasmFS lacks.
  name === "FS_createLazyFile" || name === "FS_createDevice" || name === "removeRunDependency";
}

/**
 * Intercept access to a symbols in the global symbol.  This enables us to give
 * informative warnings/errors when folks attempt to use symbols they did not
 * include in their build, or no symbols that no longer exist.
 *
 * We don't define this in MODULARIZE mode since in that mode emscripten symbols
 * are never placed in the global scope.
 */ function hookGlobalSymbolAccess(sym, func) {
  if (!Object.getOwnPropertyDescriptor(globalThis, sym)) {
    Object.defineProperty(globalThis, sym, {
      configurable: true,
      get() {
        func();
        return undefined;
      }
    });
  }
}

function missingGlobal(sym, msg) {
  hookGlobalSymbolAccess(sym, () => {
    warnOnce(`\`${sym}\` is no longer defined by emscripten. ${msg}`);
  });
}

missingGlobal("buffer", "Please use HEAP8.buffer or wasmMemory.buffer");

missingGlobal("asm", "Please use wasmExports instead");

function missingLibrarySymbol(sym) {
  hookGlobalSymbolAccess(sym, () => {
    // Can't `abort()` here because it would break code that does runtime
    // checks.  e.g. `if (typeof SDL === 'undefined')`.
    var msg = `\`${sym}\` is a library symbol and not included by default; add it to your library.js __deps or to DEFAULT_LIBRARY_FUNCS_TO_INCLUDE on the command line`;
    // DEFAULT_LIBRARY_FUNCS_TO_INCLUDE requires the name as it appears in
    // library.js, which means $name for a JS name with no prefix, or name
    // for a JS name like _name.
    var librarySymbol = sym;
    if (!librarySymbol.startsWith("_")) {
      librarySymbol = "$" + sym;
    }
    msg += ` (e.g. -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='${librarySymbol}')`;
    if (isExportedByForceFilesystem(sym)) {
      msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
    }
    warnOnce(msg);
  });
  // Any symbol that is not included from the JS library is also (by definition)
  // not exported on the Module object.
  unexportedRuntimeSymbol(sym);
}

function unexportedRuntimeSymbol(sym) {
  if (!Object.getOwnPropertyDescriptor(Module, sym)) {
    Object.defineProperty(Module, sym, {
      configurable: true,
      get() {
        var msg = `'${sym}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
        if (isExportedByForceFilesystem(sym)) {
          msg += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you";
        }
        abort(msg);
      }
    });
  }
}

var MAX_UINT8 = (2 ** 8) - 1;

var MAX_UINT16 = (2 ** 16) - 1;

var MAX_UINT32 = (2 ** 32) - 1;

var MAX_UINT53 = (2 ** 53) - 1;

var MAX_UINT64 = (2 ** 64) - 1;

var MIN_INT8 = -(2 ** (8 - 1));

var MIN_INT16 = -(2 ** (16 - 1));

var MIN_INT32 = -(2 ** (32 - 1));

var MIN_INT53 = -(2 ** (53 - 1));

var MIN_INT64 = -(2 ** (64 - 1));

function checkInt(value, bits, min, max) {
  assert(Number.isInteger(Number(value)), `attempt to write non-integer (${value}) into integer heap`);
  assert(value <= max, `value (${value}) too large to write as ${bits}-bit value`);
  assert(value >= min, `value (${value}) too small to write as ${bits}-bit value`);
}

var checkInt8 = value => checkInt(value, 8, MIN_INT8, MAX_UINT8);

var checkInt16 = value => checkInt(value, 16, MIN_INT16, MAX_UINT16);

var checkInt32 = value => checkInt(value, 32, MIN_INT32, MAX_UINT32);

var checkInt64 = value => checkInt(value, 64, MIN_INT64, MAX_UINT64);

// end include: runtime_debug.js
// include: runtime_safe_heap.js
function SAFE_HEAP_INDEX(arr, idx, action) {
  const bytes = arr.BYTES_PER_ELEMENT;
  const dest = idx * bytes;
  if (idx <= 0) abort(`segmentation fault ${action} ${bytes} bytes at address ${dest}`);
  if (runtimeInitialized) {
    var brk = _sbrk(0);
    if (dest + bytes > brk) abort(`segmentation fault, exceeded the top of the available dynamic heap when ${action} ${bytes} bytes at address ${dest}. DYNAMICTOP=${brk}`);
    if (brk < _emscripten_stack_get_base()) abort(`brk >= _emscripten_stack_get_base() (brk=${brk}, _emscripten_stack_get_base()=${_emscripten_stack_get_base()})`);
    // sbrk-managed memory must be above the stack
    if (brk > wasmMemory.buffer.byteLength) abort(`brk <= wasmMemory.buffer.byteLength (brk=${brk}, wasmMemory.buffer.byteLength=${wasmMemory.buffer.byteLength})`);
  }
  return idx;
}

function segfault() {
  abort("segmentation fault");
}

function alignfault() {
  warnOnce("alignment fault");
}

// end include: runtime_safe_heap.js
// Memory management
var /** @type {!Int8Array} */ HEAP8, /** @type {!Uint8Array} */ HEAPU8, /** @type {!Int16Array} */ HEAP16, /** @type {!Uint16Array} */ HEAPU16, /** @type {!Int32Array} */ HEAP32, /** @type {!Uint32Array} */ HEAPU32, /** @type {!Float32Array} */ HEAPF32, /** @type {!Float64Array} */ HEAPF64;

// BigInt64Array type is not correctly defined in closure
var /** not-@type {!BigInt64Array} */ HEAP64, /* BigUint64Array type is not correctly defined in closure
/** not-@type {!BigUint64Array} */ HEAPU64;

var runtimeInitialized = false;

function updateMemoryViews() {
  var b = wasmMemory.buffer;
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}

// include: memoryprofiler.js
// end include: memoryprofiler.js
// end include: runtime_common.js
assert(globalThis.Int32Array && globalThis.Float64Array && Int32Array.prototype.subarray && Int32Array.prototype.set, "JS engine does not provide full typed array support");

function preRun() {
  if (Module["preRun"]) {
    if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
    while (Module["preRun"].length) {
      addOnPreRun(Module["preRun"].shift());
    }
  }
  consumedModuleProp("preRun");
  // Begin ATPRERUNS hooks
  callRuntimeCallbacks(onPreRuns);
}

function initRuntime() {
  assert(!runtimeInitialized);
  runtimeInitialized = true;
  setStackLimits();
  checkStackCookie();
  // Begin ATINITS hooks
  if (!Module["noFSInit"] && !FS.initialized) FS.init();
  TTY.init();
  // End ATINITS hooks
  wasmExports["__wasm_call_ctors"]();
  // Begin ATPOSTCTORS hooks
  FS.ignorePermissions = false;
}

function preMain() {
  checkStackCookie();
}

function postRun() {
  checkStackCookie();
  // PThreads reuse the runtime from the main thread.
  if (Module["postRun"]) {
    if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
    while (Module["postRun"].length) {
      addOnPostRun(Module["postRun"].shift());
    }
  }
  consumedModuleProp("postRun");
  // Begin ATPOSTRUNS hooks
  callRuntimeCallbacks(onPostRuns);
}

/** @param {string|number=} what */ function abort(what) {
  Module["onAbort"]?.(what);
  what = "Aborted(" + what + ")";
  // TODO(sbc): Should we remove printing and leave it up to whoever
  // catches the exception?
  err(what);
  ABORT = true;
  // Use a wasm runtime error, because a JS error might be seen as a foreign
  // exception, which means we'd run destructors on it. We need the error to
  // simply make the program stop.
  // FIXME This approach does not work in Wasm EH because it currently does not assume
  // all RuntimeErrors are from traps; it decides whether a RuntimeError is from
  // a trap or not based on a hidden field within the object. So at the moment
  // we don't have a way of throwing a wasm trap from JS. TODO Make a JS API that
  // allows this in the wasm spec.
  // Suppress closure compiler warning here. Closure compiler's builtin extern
  // definition for WebAssembly.RuntimeError claims it takes no arguments even
  // though it can.
  // TODO(https://github.com/google/closure-compiler/pull/3913): Remove if/when upstream closure gets fixed.
  /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
  // Throw the error whether or not MODULARIZE is set because abort is used
  // in code paths apart from instantiation where an exception is expected
  // to be thrown when abort is called.
  throw e;
}

function createExportWrapper(name, nargs) {
  return (...args) => {
    assert(runtimeInitialized, `native function \`${name}\` called before runtime initialization`);
    var f = wasmExports[name];
    assert(f, `exported native function \`${name}\` not found`);
    // Only assert for too many arguments. Too few can be valid since the missing arguments will be zero filled.
    assert(args.length <= nargs, `native function \`${name}\` called with ${args.length} args but expects ${nargs}`);
    return f(...args);
  };
}

var wasmBinaryFile;

function findWasmBinary() {
  return locateFile("App.wasm");
}

function getBinarySync(file) {
  if (file == wasmBinaryFile && wasmBinary) {
    return new Uint8Array(wasmBinary);
  }
  if (readBinary) {
    return readBinary(file);
  }
  // Throwing a plain string here, even though it not normally advisable since
  // this gets turning into an `abort` in instantiateArrayBuffer.
  throw "both async and sync fetching of the wasm failed";
}

async function getWasmBinary(binaryFile) {
  // If we don't have the binary yet, load it asynchronously using readAsync.
  if (!wasmBinary) {
    // Fetch the binary using readAsync
    try {
      var response = await readAsync(binaryFile);
      return new Uint8Array(response);
    } catch {}
  }
  // Otherwise, getBinarySync should be able to get it synchronously
  return getBinarySync(binaryFile);
}

async function instantiateArrayBuffer(binaryFile, imports) {
  try {
    var binary = await getWasmBinary(binaryFile);
    var instance = await WebAssembly.instantiate(binary, imports);
    return instance;
  } catch (reason) {
    err(`failed to asynchronously prepare wasm: ${reason}`);
    // Warn on some common problems.
    if (isFileURI(binaryFile)) {
      err(`warning: Loading from a file URI (${binaryFile}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`);
    }
    abort(reason);
  }
}

async function instantiateAsync(binary, binaryFile, imports) {
  if (!binary && !isFileURI(binaryFile) && !ENVIRONMENT_IS_NODE) {
    try {
      var response = fetch(binaryFile, {
        credentials: "same-origin"
      });
      var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);
      return instantiationResult;
    } catch (reason) {
      // We expect the most common failure cause to be a bad MIME type for the binary,
      // in which case falling back to ArrayBuffer instantiation should work.
      err(`wasm streaming compile failed: ${reason}`);
      err("falling back to ArrayBuffer instantiation");
    }
  }
  return instantiateArrayBuffer(binaryFile, imports);
}

function getWasmImports() {
  // prepare imports
  var imports = {
    "env": wasmImports,
    "wasi_snapshot_preview1": wasmImports
  };
  return imports;
}

// Create the wasm instance.
// Receives the wasm imports, returns the exports.
async function createWasm() {
  // Load the wasm module and create an instance of using native support in the JS engine.
  // handle a generated wasm instance, receiving its exports and
  // performing other necessary setup
  /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    assignWasmExports(wasmExports);
    updateMemoryViews();
    removeRunDependency("wasm-instantiate");
    return wasmExports;
  }
  addRunDependency("wasm-instantiate");
  // Prefer streaming instantiation if available.
  // Async compilation can be confusing when an error on the page overwrites Module
  // (for example, if the order of elements is wrong, and the one defining Module is
  // later), so we save Module and check it later.
  var trueModule = Module;
  function receiveInstantiationResult(result) {
    // 'result' is a ResultObject object which has both the module and instance.
    // receiveInstance() will swap in the exports (to Module.asm) so they can be called
    assert(Module === trueModule, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
    trueModule = null;
    // TODO: Due to Closure regression https://github.com/google/closure-compiler/issues/3193, the above line no longer optimizes out down to the following line.
    // When the regression is fixed, can restore the above PTHREADS-enabled path.
    return receiveInstance(result["instance"]);
  }
  var info = getWasmImports();
  // User shell pages can write their own Module.instantiateWasm = function(imports, successCallback) callback
  // to manually instantiate the Wasm module themselves. This allows pages to
  // run the instantiation parallel to any other async startup actions they are
  // performing.
  // Also pthreads and wasm workers initialize the wasm instance through this
  // path.
  if (Module["instantiateWasm"]) {
    return new Promise((resolve, reject) => {
      try {
        Module["instantiateWasm"](info, (inst, mod) => {
          resolve(receiveInstance(inst, mod));
        });
      } catch (e) {
        err(`Module.instantiateWasm callback failed with error: ${e}`);
        reject(e);
      }
    });
  }
  wasmBinaryFile ??= findWasmBinary();
  var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info);
  var exports = receiveInstantiationResult(result);
  return exports;
}

// end include: preamble.js
// Begin JS library code
class ExitStatus {
  name="ExitStatus";
  constructor(status) {
    this.message = `Program terminated with exit(${status})`;
    this.status = status;
  }
}

var callRuntimeCallbacks = callbacks => {
  while (callbacks.length > 0) {
    // Pass the module as the first argument.
    callbacks.shift()(Module);
  }
};

var onPostRuns = [];

var addOnPostRun = cb => onPostRuns.push(cb);

var onPreRuns = [];

var addOnPreRun = cb => onPreRuns.push(cb);

var runDependencies = 0;

var dependenciesFulfilled = null;

var runDependencyTracking = {};

var runDependencyWatcher = null;

var removeRunDependency = id => {
  runDependencies--;
  Module["monitorRunDependencies"]?.(runDependencies);
  assert(id, "removeRunDependency requires an ID");
  assert(runDependencyTracking[id]);
  delete runDependencyTracking[id];
  if (runDependencies == 0) {
    if (runDependencyWatcher !== null) {
      clearInterval(runDependencyWatcher);
      runDependencyWatcher = null;
    }
    if (dependenciesFulfilled) {
      var callback = dependenciesFulfilled;
      dependenciesFulfilled = null;
      callback();
    }
  }
};

var addRunDependency = id => {
  runDependencies++;
  Module["monitorRunDependencies"]?.(runDependencies);
  assert(id, "addRunDependency requires an ID");
  assert(!runDependencyTracking[id]);
  runDependencyTracking[id] = 1;
  if (runDependencyWatcher === null && globalThis.setInterval) {
    // Check for missing dependencies every few seconds
    runDependencyWatcher = setInterval(() => {
      if (ABORT) {
        clearInterval(runDependencyWatcher);
        runDependencyWatcher = null;
        return;
      }
      var shown = false;
      for (var dep in runDependencyTracking) {
        if (!shown) {
          shown = true;
          err("still waiting on run dependencies:");
        }
        err(`dependency: ${dep}`);
      }
      if (shown) {
        err("(end of list)");
      }
    }, 1e4);
    // Prevent this timer from keeping the runtime alive if nothing
    // else is.
    runDependencyWatcher.unref?.();
  }
};

var noExitRuntime = true;

var ptrToString = ptr => {
  assert(typeof ptr === "number", `ptrToString expects a number, got ${typeof ptr}`);
  // Convert to 32-bit unsigned value
  ptr >>>= 0;
  return "0x" + ptr.toString(16).padStart(8, "0");
};

var setStackLimits = () => {
  var stackLow = _emscripten_stack_get_base();
  var stackHigh = _emscripten_stack_get_end();
  ___set_stack_limits(stackLow, stackHigh);
};

/**
   * @param {number} ptr
   * @param {number} value
   * @param {string} type
   */ function setValue(ptr, value, type = "i8") {
  if (type.endsWith("*")) type = "*";
  switch (type) {
   case "i1":
    HEAP8[SAFE_HEAP_INDEX(HEAP8, ptr, "storing")] = value;
    checkInt8(value);
    break;

   case "i8":
    HEAP8[SAFE_HEAP_INDEX(HEAP8, ptr, "storing")] = value;
    checkInt8(value);
    break;

   case "i16":
    HEAP16[SAFE_HEAP_INDEX(HEAP16, ((ptr) >> 1), "storing")] = value;
    checkInt16(value);
    break;

   case "i32":
    HEAP32[SAFE_HEAP_INDEX(HEAP32, ((ptr) >> 2), "storing")] = value;
    checkInt32(value);
    break;

   case "i64":
    HEAP64[SAFE_HEAP_INDEX(HEAP64, ((ptr) >> 3), "storing")] = BigInt(value);
    checkInt64(value);
    break;

   case "float":
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, ((ptr) >> 2), "storing")] = value;
    break;

   case "double":
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((ptr) >> 3), "storing")] = value;
    break;

   case "*":
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "storing")] = value;
    break;

   default:
    abort(`invalid type for setValue: ${type}`);
  }
}

var stackRestore = val => __emscripten_stack_restore(val);

var stackSave = () => _emscripten_stack_get_current();

var warnOnce = text => {
  warnOnce.shown ||= {};
  if (!warnOnce.shown[text]) {
    warnOnce.shown[text] = 1;
    if (ENVIRONMENT_IS_NODE) text = "warning: " + text;
    err(text);
  }
};

var UTF8Decoder = globalThis.TextDecoder && new TextDecoder;

var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
  var maxIdx = idx + maxBytesToRead;
  if (ignoreNul) return maxIdx;
  // TextDecoder needs to know the byte length in advance, it doesn't stop on
  // null terminator by itself.
  // As a tiny code save trick, compare idx against maxIdx using a negation,
  // so that maxBytesToRead=undefined/NaN means Infinity.
  while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
  return idx;
};

/**
   * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
   * array that contains uint8 values, returns a copy of that string as a
   * Javascript String object.
   * heapOrArray is either a regular array, or a JavaScript typed array view.
   * @param {number=} idx
   * @param {number=} maxBytesToRead
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
  var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
  // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
  if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
    return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
  }
  var str = "";
  while (idx < endPtr) {
    // For UTF8 byte structure, see:
    // http://en.wikipedia.org/wiki/UTF-8#Description
    // https://www.ietf.org/rfc/rfc2279.txt
    // https://tools.ietf.org/html/rfc3629
    var u0 = heapOrArray[idx++];
    if (!(u0 & 128)) {
      str += String.fromCharCode(u0);
      continue;
    }
    var u1 = heapOrArray[idx++] & 63;
    if ((u0 & 224) == 192) {
      str += String.fromCharCode(((u0 & 31) << 6) | u1);
      continue;
    }
    var u2 = heapOrArray[idx++] & 63;
    if ((u0 & 240) == 224) {
      u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
    } else {
      if ((u0 & 248) != 240) warnOnce("Invalid UTF-8 leading byte " + ptrToString(u0) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!");
      u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
    }
    if (u0 < 65536) {
      str += String.fromCharCode(u0);
    } else {
      var ch = u0 - 65536;
      str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
    }
  }
  return str;
};

/**
   * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
   * emscripten HEAP, returns a copy of that string as a Javascript String object.
   *
   * @param {number} ptr
   * @param {number=} maxBytesToRead - An optional length that specifies the
   *   maximum number of bytes to read. You can omit this parameter to scan the
   *   string until the first 0 byte. If maxBytesToRead is passed, and the string
   *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
   *   string will cut short at that byte index.
   * @param {boolean=} ignoreNul - If true, the function will not stop on a NUL character.
   * @return {string}
   */ var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => {
  assert(typeof ptr == "number", `UTF8ToString expects a number (got ${typeof ptr})`);
  return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead, ignoreNul) : "";
};

var ___assert_fail = (condition, filename, line, func) => abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [ filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function" ]);

var ___handle_stack_overflow = requested => {
  var base = _emscripten_stack_get_base();
  var end = _emscripten_stack_get_end();
  abort(`stack overflow (Attempt to set SP to ${ptrToString(requested)}` + `, with stack limits [${ptrToString(end)} - ${ptrToString(base)}` + "]). If you require more stack space build with -sSTACK_SIZE=<bytes>");
};

var syscallGetVarargI = () => {
  assert(SYSCALLS.varargs != undefined);
  // the `+` prepended here is necessary to convince the JSCompiler that varargs is indeed a number.
  var ret = HEAP32[SAFE_HEAP_INDEX(HEAP32, ((+SYSCALLS.varargs) >> 2), "loading")];
  SYSCALLS.varargs += 4;
  return ret;
};

var syscallGetVarargP = syscallGetVarargI;

var PATH = {
  isAbs: path => path.charAt(0) === "/",
  splitPath: filename => {
    var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
    return splitPathRe.exec(filename).slice(1);
  },
  normalizeArray: (parts, allowAboveRoot) => {
    // if the path tries to go above the root, `up` ends up > 0
    var up = 0;
    for (var i = parts.length - 1; i >= 0; i--) {
      var last = parts[i];
      if (last === ".") {
        parts.splice(i, 1);
      } else if (last === "..") {
        parts.splice(i, 1);
        up++;
      } else if (up) {
        parts.splice(i, 1);
        up--;
      }
    }
    // if the path is allowed to go above the root, restore leading ..s
    if (allowAboveRoot) {
      for (;up; up--) {
        parts.unshift("..");
      }
    }
    return parts;
  },
  normalize: path => {
    var isAbsolute = PATH.isAbs(path), trailingSlash = path.slice(-1) === "/";
    // Normalize the path
    path = PATH.normalizeArray(path.split("/").filter(p => !!p), !isAbsolute).join("/");
    if (!path && !isAbsolute) {
      path = ".";
    }
    if (path && trailingSlash) {
      path += "/";
    }
    return (isAbsolute ? "/" : "") + path;
  },
  dirname: path => {
    var result = PATH.splitPath(path), root = result[0], dir = result[1];
    if (!root && !dir) {
      // No dirname whatsoever
      return ".";
    }
    if (dir) {
      // It has a dirname, strip trailing slash
      dir = dir.slice(0, -1);
    }
    return root + dir;
  },
  basename: path => path && path.match(/([^\/]+|\/)\/*$/)[1],
  join: (...paths) => PATH.normalize(paths.join("/")),
  join2: (l, r) => PATH.normalize(l + "/" + r)
};

var initRandomFill = () => {
  // This block is not needed on v19+ since crypto.getRandomValues is builtin
  if (ENVIRONMENT_IS_NODE) {
    var nodeCrypto = require("node:crypto");
    return view => nodeCrypto.randomFillSync(view);
  }
  return view => crypto.getRandomValues(view);
};

var randomFill = view => {
  // Lazily init on the first invocation.
  (randomFill = initRandomFill())(view);
};

var PATH_FS = {
  resolve: (...args) => {
    var resolvedPath = "", resolvedAbsolute = false;
    for (var i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
      var path = (i >= 0) ? args[i] : FS.cwd();
      // Skip empty and invalid entries
      if (typeof path != "string") {
        throw new TypeError("Arguments to path.resolve must be strings");
      } else if (!path) {
        return "";
      }
      resolvedPath = path + "/" + resolvedPath;
      resolvedAbsolute = PATH.isAbs(path);
    }
    // At this point the path should be resolved to a full absolute path, but
    // handle relative paths to be safe (might happen when process.cwd() fails)
    resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(p => !!p), !resolvedAbsolute).join("/");
    return ((resolvedAbsolute ? "/" : "") + resolvedPath) || ".";
  },
  relative: (from, to) => {
    from = PATH_FS.resolve(from).slice(1);
    to = PATH_FS.resolve(to).slice(1);
    function trim(arr) {
      var start = 0;
      for (;start < arr.length; start++) {
        if (arr[start] !== "") break;
      }
      var end = arr.length - 1;
      for (;end >= 0; end--) {
        if (arr[end] !== "") break;
      }
      if (start > end) return [];
      return arr.slice(start, end - start + 1);
    }
    var fromParts = trim(from.split("/"));
    var toParts = trim(to.split("/"));
    var length = Math.min(fromParts.length, toParts.length);
    var samePartsLength = length;
    for (var i = 0; i < length; i++) {
      if (fromParts[i] !== toParts[i]) {
        samePartsLength = i;
        break;
      }
    }
    var outputParts = [];
    for (var i = samePartsLength; i < fromParts.length; i++) {
      outputParts.push("..");
    }
    outputParts = outputParts.concat(toParts.slice(samePartsLength));
    return outputParts.join("/");
  }
};

var FS_stdin_getChar_buffer = [];

var lengthBytesUTF8 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code
    // unit, not a Unicode code point of the character! So decode
    // UTF16->UTF32->UTF8.
    // See http://unicode.org/faq/utf_bom.html#utf16-3
    var c = str.charCodeAt(i);
    // possibly a lead surrogate
    if (c <= 127) {
      len++;
    } else if (c <= 2047) {
      len += 2;
    } else if (c >= 55296 && c <= 57343) {
      len += 4;
      ++i;
    } else {
      len += 3;
    }
  }
  return len;
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
  assert(typeof str === "string", `stringToUTF8Array expects a string (got ${typeof str})`);
  // Parameter maxBytesToWrite is not optional. Negative values, 0, null,
  // undefined and false each don't write out any bytes.
  if (!(maxBytesToWrite > 0)) return 0;
  var startIdx = outIdx;
  var endIdx = outIdx + maxBytesToWrite - 1;
  // -1 for string null terminator.
  for (var i = 0; i < str.length; ++i) {
    // For UTF8 byte structure, see http://en.wikipedia.org/wiki/UTF-8#Description
    // and https://www.ietf.org/rfc/rfc2279.txt
    // and https://tools.ietf.org/html/rfc3629
    var u = str.codePointAt(i);
    if (u <= 127) {
      if (outIdx >= endIdx) break;
      heap[outIdx++] = u;
    } else if (u <= 2047) {
      if (outIdx + 1 >= endIdx) break;
      heap[outIdx++] = 192 | (u >> 6);
      heap[outIdx++] = 128 | (u & 63);
    } else if (u <= 65535) {
      if (outIdx + 2 >= endIdx) break;
      heap[outIdx++] = 224 | (u >> 12);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
    } else {
      if (outIdx + 3 >= endIdx) break;
      if (u > 1114111) warnOnce("Invalid Unicode code point " + ptrToString(u) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
      heap[outIdx++] = 240 | (u >> 18);
      heap[outIdx++] = 128 | ((u >> 12) & 63);
      heap[outIdx++] = 128 | ((u >> 6) & 63);
      heap[outIdx++] = 128 | (u & 63);
      // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
      // We need to manually skip over the second code unit for correct iteration.
      i++;
    }
  }
  // Null-terminate the pointer to the buffer.
  heap[outIdx] = 0;
  return outIdx - startIdx;
};

/** @type {function(string, boolean=, number=)} */ var intArrayFromString = (stringy, dontAddNull, length) => {
  var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
  var u8array = new Array(len);
  var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
  if (dontAddNull) u8array.length = numBytesWritten;
  return u8array;
};

var FS_stdin_getChar = () => {
  if (!FS_stdin_getChar_buffer.length) {
    var result = null;
    if (ENVIRONMENT_IS_NODE) {
      // we will read data by chunks of BUFSIZE
      var BUFSIZE = 256;
      var buf = Buffer.alloc(BUFSIZE);
      var bytesRead = 0;
      // For some reason we must suppress a closure warning here, even though
      // fd definitely exists on process.stdin, and is even the proper way to
      // get the fd of stdin,
      // https://github.com/nodejs/help/issues/2136#issuecomment-523649904
      // This started to happen after moving this logic out of library_tty.js,
      // so it is related to the surrounding code in some unclear manner.
      /** @suppress {missingProperties} */ var fd = process.stdin.fd;
      try {
        bytesRead = fs.readSync(fd, buf, 0, BUFSIZE);
      } catch (e) {
        // Cross-platform differences: on Windows, reading EOF throws an
        // exception, but on other OSes, reading EOF returns 0. Uniformize
        // behavior by treating the EOF exception to return 0.
        if (e.toString().includes("EOF")) bytesRead = 0; else throw e;
      }
      if (bytesRead > 0) {
        result = buf.slice(0, bytesRead).toString("utf-8");
      }
    } else if (globalThis.window?.prompt) {
      // Browser.
      result = window.prompt("Input: ");
      // returns null on cancel
      if (result !== null) {
        result += "\n";
      }
    } else {}
    if (!result) {
      return null;
    }
    FS_stdin_getChar_buffer = intArrayFromString(result, true);
  }
  return FS_stdin_getChar_buffer.shift();
};

var TTY = {
  ttys: [],
  init() {},
  shutdown() {},
  register(dev, ops) {
    TTY.ttys[dev] = {
      input: [],
      output: [],
      ops
    };
    FS.registerDevice(dev, TTY.stream_ops);
  },
  stream_ops: {
    open(stream) {
      var tty = TTY.ttys[stream.node.rdev];
      if (!tty) {
        throw new FS.ErrnoError(43);
      }
      stream.tty = tty;
      stream.seekable = false;
    },
    close(stream) {
      // flush any pending line data
      stream.tty.ops.fsync(stream.tty);
    },
    fsync(stream) {
      stream.tty.ops.fsync(stream.tty);
    },
    read(stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.get_char) {
        throw new FS.ErrnoError(60);
      }
      var bytesRead = 0;
      for (var i = 0; i < length; i++) {
        var result;
        try {
          result = stream.tty.ops.get_char(stream.tty);
        } catch (e) {
          throw new FS.ErrnoError(29);
        }
        if (result === undefined && bytesRead === 0) {
          throw new FS.ErrnoError(6);
        }
        if (result === null || result === undefined) break;
        bytesRead++;
        buffer[offset + i] = result;
      }
      if (bytesRead) {
        stream.node.atime = Date.now();
      }
      return bytesRead;
    },
    write(stream, buffer, offset, length, pos) {
      if (!stream.tty || !stream.tty.ops.put_char) {
        throw new FS.ErrnoError(60);
      }
      try {
        for (var i = 0; i < length; i++) {
          stream.tty.ops.put_char(stream.tty, buffer[offset + i]);
        }
      } catch (e) {
        throw new FS.ErrnoError(29);
      }
      if (length) {
        stream.node.mtime = stream.node.ctime = Date.now();
      }
      return i;
    }
  },
  default_tty_ops: {
    get_char(tty) {
      return FS_stdin_getChar();
    },
    put_char(tty, val) {
      if (val === null || val === 10) {
        out(UTF8ArrayToString(tty.output));
        tty.output = [];
      } else {
        if (val != 0) tty.output.push(val);
      }
    },
    fsync(tty) {
      if (tty.output?.length > 0) {
        out(UTF8ArrayToString(tty.output));
        tty.output = [];
      }
    },
    ioctl_tcgets(tty) {
      // typical setting
      return {
        c_iflag: 25856,
        c_oflag: 5,
        c_cflag: 191,
        c_lflag: 35387,
        c_cc: [ 3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ]
      };
    },
    ioctl_tcsets(tty, optional_actions, data) {
      // currently just ignore
      return 0;
    },
    ioctl_tiocgwinsz(tty) {
      return [ 24, 80 ];
    }
  },
  default_tty1_ops: {
    put_char(tty, val) {
      if (val === null || val === 10) {
        err(UTF8ArrayToString(tty.output));
        tty.output = [];
      } else {
        if (val != 0) tty.output.push(val);
      }
    },
    fsync(tty) {
      if (tty.output?.length > 0) {
        err(UTF8ArrayToString(tty.output));
        tty.output = [];
      }
    }
  }
};

var mmapAlloc = size => {
  abort("internal error: mmapAlloc called but `emscripten_builtin_memalign` native symbol not exported");
};

var MEMFS = {
  ops_table: null,
  mount(mount) {
    return MEMFS.createNode(null, "/", 16895, 0);
  },
  createNode(parent, name, mode, dev) {
    if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
      // not supported
      throw new FS.ErrnoError(63);
    }
    MEMFS.ops_table ||= {
      dir: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr,
          lookup: MEMFS.node_ops.lookup,
          mknod: MEMFS.node_ops.mknod,
          rename: MEMFS.node_ops.rename,
          unlink: MEMFS.node_ops.unlink,
          rmdir: MEMFS.node_ops.rmdir,
          readdir: MEMFS.node_ops.readdir,
          symlink: MEMFS.node_ops.symlink
        },
        stream: {
          llseek: MEMFS.stream_ops.llseek
        }
      },
      file: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr
        },
        stream: {
          llseek: MEMFS.stream_ops.llseek,
          read: MEMFS.stream_ops.read,
          write: MEMFS.stream_ops.write,
          mmap: MEMFS.stream_ops.mmap,
          msync: MEMFS.stream_ops.msync
        }
      },
      link: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr,
          readlink: MEMFS.node_ops.readlink
        },
        stream: {}
      },
      chrdev: {
        node: {
          getattr: MEMFS.node_ops.getattr,
          setattr: MEMFS.node_ops.setattr
        },
        stream: FS.chrdev_stream_ops
      }
    };
    var node = FS.createNode(parent, name, mode, dev);
    if (FS.isDir(node.mode)) {
      node.node_ops = MEMFS.ops_table.dir.node;
      node.stream_ops = MEMFS.ops_table.dir.stream;
      node.contents = {};
    } else if (FS.isFile(node.mode)) {
      node.node_ops = MEMFS.ops_table.file.node;
      node.stream_ops = MEMFS.ops_table.file.stream;
      node.usedBytes = 0;
      // The actual number of bytes used in the typed array, as opposed to contents.length which gives the whole capacity.
      // When the byte data of the file is populated, this will point to either a typed array, or a normal JS array. Typed arrays are preferred
      // for performance, and used by default. However, typed arrays are not resizable like normal JS arrays are, so there is a small disk size
      // penalty involved for appending file writes that continuously grow a file similar to std::vector capacity vs used -scheme.
      node.contents = null;
    } else if (FS.isLink(node.mode)) {
      node.node_ops = MEMFS.ops_table.link.node;
      node.stream_ops = MEMFS.ops_table.link.stream;
    } else if (FS.isChrdev(node.mode)) {
      node.node_ops = MEMFS.ops_table.chrdev.node;
      node.stream_ops = MEMFS.ops_table.chrdev.stream;
    }
    node.atime = node.mtime = node.ctime = Date.now();
    // add the new node to the parent
    if (parent) {
      parent.contents[name] = node;
      parent.atime = parent.mtime = parent.ctime = node.atime;
    }
    return node;
  },
  getFileDataAsTypedArray(node) {
    if (!node.contents) return new Uint8Array(0);
    if (node.contents.subarray) return node.contents.subarray(0, node.usedBytes);
    // Make sure to not return excess unused bytes.
    return new Uint8Array(node.contents);
  },
  expandFileStorage(node, newCapacity) {
    var prevCapacity = node.contents ? node.contents.length : 0;
    if (prevCapacity >= newCapacity) return;
    // No need to expand, the storage was already large enough.
    // Don't expand strictly to the given requested limit if it's only a very small increase, but instead geometrically grow capacity.
    // For small filesizes (<1MB), perform size*2 geometric increase, but for large sizes, do a much more conservative size*1.125 increase to
    // avoid overshooting the allocation cap by a very large margin.
    var CAPACITY_DOUBLING_MAX = 1024 * 1024;
    newCapacity = Math.max(newCapacity, (prevCapacity * (prevCapacity < CAPACITY_DOUBLING_MAX ? 2 : 1.125)) >>> 0);
    if (prevCapacity != 0) newCapacity = Math.max(newCapacity, 256);
    // At minimum allocate 256b for each file when expanding.
    var oldContents = node.contents;
    node.contents = new Uint8Array(newCapacity);
    // Allocate new storage.
    if (node.usedBytes > 0) node.contents.set(oldContents.subarray(0, node.usedBytes), 0);
  },
  resizeFileStorage(node, newSize) {
    if (node.usedBytes == newSize) return;
    if (newSize == 0) {
      node.contents = null;
      // Fully decommit when requesting a resize to zero.
      node.usedBytes = 0;
    } else {
      var oldContents = node.contents;
      node.contents = new Uint8Array(newSize);
      // Allocate new storage.
      if (oldContents) {
        node.contents.set(oldContents.subarray(0, Math.min(newSize, node.usedBytes)));
      }
      node.usedBytes = newSize;
    }
  },
  node_ops: {
    getattr(node) {
      var attr = {};
      // device numbers reuse inode numbers.
      attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
      attr.ino = node.id;
      attr.mode = node.mode;
      attr.nlink = 1;
      attr.uid = 0;
      attr.gid = 0;
      attr.rdev = node.rdev;
      if (FS.isDir(node.mode)) {
        attr.size = 4096;
      } else if (FS.isFile(node.mode)) {
        attr.size = node.usedBytes;
      } else if (FS.isLink(node.mode)) {
        attr.size = node.link.length;
      } else {
        attr.size = 0;
      }
      attr.atime = new Date(node.atime);
      attr.mtime = new Date(node.mtime);
      attr.ctime = new Date(node.ctime);
      // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
      //       but this is not required by the standard.
      attr.blksize = 4096;
      attr.blocks = Math.ceil(attr.size / attr.blksize);
      return attr;
    },
    setattr(node, attr) {
      for (const key of [ "mode", "atime", "mtime", "ctime" ]) {
        if (attr[key] != null) {
          node[key] = attr[key];
        }
      }
      if (attr.size !== undefined) {
        MEMFS.resizeFileStorage(node, attr.size);
      }
    },
    lookup(parent, name) {
      throw new FS.ErrnoError(44);
    },
    mknod(parent, name, mode, dev) {
      return MEMFS.createNode(parent, name, mode, dev);
    },
    rename(old_node, new_dir, new_name) {
      var new_node;
      try {
        new_node = FS.lookupNode(new_dir, new_name);
      } catch (e) {}
      if (new_node) {
        if (FS.isDir(old_node.mode)) {
          // if we're overwriting a directory at new_name, make sure it's empty.
          for (var i in new_node.contents) {
            throw new FS.ErrnoError(55);
          }
        }
        FS.hashRemoveNode(new_node);
      }
      // do the internal rewiring
      delete old_node.parent.contents[old_node.name];
      new_dir.contents[new_name] = old_node;
      old_node.name = new_name;
      new_dir.ctime = new_dir.mtime = old_node.parent.ctime = old_node.parent.mtime = Date.now();
    },
    unlink(parent, name) {
      delete parent.contents[name];
      parent.ctime = parent.mtime = Date.now();
    },
    rmdir(parent, name) {
      var node = FS.lookupNode(parent, name);
      for (var i in node.contents) {
        throw new FS.ErrnoError(55);
      }
      delete parent.contents[name];
      parent.ctime = parent.mtime = Date.now();
    },
    readdir(node) {
      return [ ".", "..", ...Object.keys(node.contents) ];
    },
    symlink(parent, newname, oldpath) {
      var node = MEMFS.createNode(parent, newname, 511 | 40960, 0);
      node.link = oldpath;
      return node;
    },
    readlink(node) {
      if (!FS.isLink(node.mode)) {
        throw new FS.ErrnoError(28);
      }
      return node.link;
    }
  },
  stream_ops: {
    read(stream, buffer, offset, length, position) {
      var contents = stream.node.contents;
      if (position >= stream.node.usedBytes) return 0;
      var size = Math.min(stream.node.usedBytes - position, length);
      assert(size >= 0);
      if (size > 8 && contents.subarray) {
        // non-trivial, and typed array
        buffer.set(contents.subarray(position, position + size), offset);
      } else {
        for (var i = 0; i < size; i++) buffer[offset + i] = contents[position + i];
      }
      return size;
    },
    write(stream, buffer, offset, length, position, canOwn) {
      // The data buffer should be a typed array view
      assert(!(buffer instanceof ArrayBuffer));
      // If the buffer is located in main memory (HEAP), and if
      // memory can grow, we can't hold on to references of the
      // memory buffer, as they may get invalidated. That means we
      // need to copy its contents.
      if (buffer.buffer === HEAP8.buffer) {
        canOwn = false;
      }
      if (!length) return 0;
      var node = stream.node;
      node.mtime = node.ctime = Date.now();
      if (buffer.subarray && (!node.contents || node.contents.subarray)) {
        // This write is from a typed array to a typed array?
        if (canOwn) {
          assert(position === 0, "canOwn must imply no weird position inside the file");
          node.contents = buffer.subarray(offset, offset + length);
          node.usedBytes = length;
          return length;
        } else if (node.usedBytes === 0 && position === 0) {
          // If this is a simple first write to an empty file, do a fast set since we don't need to care about old data.
          node.contents = buffer.slice(offset, offset + length);
          node.usedBytes = length;
          return length;
        } else if (position + length <= node.usedBytes) {
          // Writing to an already allocated and used subrange of the file?
          node.contents.set(buffer.subarray(offset, offset + length), position);
          return length;
        }
      }
      // Appending to an existing file and we need to reallocate, or source data did not come as a typed array.
      MEMFS.expandFileStorage(node, position + length);
      if (node.contents.subarray && buffer.subarray) {
        // Use typed array write which is available.
        node.contents.set(buffer.subarray(offset, offset + length), position);
      } else {
        for (var i = 0; i < length; i++) {
          node.contents[position + i] = buffer[offset + i];
        }
      }
      node.usedBytes = Math.max(node.usedBytes, position + length);
      return length;
    },
    llseek(stream, offset, whence) {
      var position = offset;
      if (whence === 1) {
        position += stream.position;
      } else if (whence === 2) {
        if (FS.isFile(stream.node.mode)) {
          position += stream.node.usedBytes;
        }
      }
      if (position < 0) {
        throw new FS.ErrnoError(28);
      }
      return position;
    },
    mmap(stream, length, position, prot, flags) {
      if (!FS.isFile(stream.node.mode)) {
        throw new FS.ErrnoError(43);
      }
      var ptr;
      var allocated;
      var contents = stream.node.contents;
      // Only make a new copy when MAP_PRIVATE is specified.
      if (!(flags & 2) && contents && contents.buffer === HEAP8.buffer) {
        // We can't emulate MAP_SHARED when the file is not backed by the
        // buffer we're mapping to (e.g. the HEAP buffer).
        allocated = false;
        ptr = contents.byteOffset;
      } else {
        allocated = true;
        ptr = mmapAlloc(length);
        if (!ptr) {
          throw new FS.ErrnoError(48);
        }
        if (contents) {
          // Try to avoid unnecessary slices.
          if (position > 0 || position + length < contents.length) {
            if (contents.subarray) {
              contents = contents.subarray(position, position + length);
            } else {
              contents = Array.prototype.slice.call(contents, position, position + length);
            }
          }
          HEAP8.set(contents, ptr);
        }
      }
      return {
        ptr,
        allocated
      };
    },
    msync(stream, buffer, offset, length, mmapFlags) {
      MEMFS.stream_ops.write(stream, buffer, 0, length, offset, false);
      // should we check if bytesWritten and length are the same?
      return 0;
    }
  }
};

var FS_modeStringToFlags = str => {
  var flagModes = {
    "r": 0,
    "r+": 2,
    "w": 512 | 64 | 1,
    "w+": 512 | 64 | 2,
    "a": 1024 | 64 | 1,
    "a+": 1024 | 64 | 2
  };
  var flags = flagModes[str];
  if (typeof flags == "undefined") {
    throw new Error(`Unknown file open mode: ${str}`);
  }
  return flags;
};

var FS_getMode = (canRead, canWrite) => {
  var mode = 0;
  if (canRead) mode |= 292 | 73;
  if (canWrite) mode |= 146;
  return mode;
};

var IDBFS = {
  dbs: {},
  indexedDB: () => {
    assert(typeof indexedDB != "undefined", "IDBFS used, but indexedDB not supported");
    return indexedDB;
  },
  DB_VERSION: 21,
  DB_STORE_NAME: "FILE_DATA",
  queuePersist: mount => {
    function onPersistComplete() {
      if (mount.idbPersistState === "again") startPersist(); else mount.idbPersistState = 0;
    }
    function startPersist() {
      mount.idbPersistState = "idb";
      // Mark that we are currently running a sync operation
      IDBFS.syncfs(mount, /*populate:*/ false, onPersistComplete);
    }
    if (!mount.idbPersistState) {
      // Programs typically write/copy/move multiple files in the in-memory
      // filesystem within a single app frame, so when a filesystem sync
      // command is triggered, do not start it immediately, but only after
      // the current frame is finished. This way all the modified files
      // inside the main loop tick will be batched up to the same sync.
      mount.idbPersistState = setTimeout(startPersist, 0);
    } else if (mount.idbPersistState === "idb") {
      // There is an active IndexedDB sync operation in-flight, but we now
      // have accumulated more files to sync. We should therefore queue up
      // a new sync after the current one finishes so that all writes
      // will be properly persisted.
      mount.idbPersistState = "again";
    }
  },
  mount: mount => {
    // reuse core MEMFS functionality
    var mnt = MEMFS.mount(mount);
    // If the automatic IDBFS persistence option has been selected, then automatically persist
    // all modifications to the filesystem as they occur.
    if (mount?.opts?.autoPersist) {
      mount.idbPersistState = 0;
      // IndexedDB sync starts in idle state
      var memfs_node_ops = mnt.node_ops;
      mnt.node_ops = {
        ...mnt.node_ops
      };
      // Clone node_ops to inject write tracking
      mnt.node_ops.mknod = (parent, name, mode, dev) => {
        var node = memfs_node_ops.mknod(parent, name, mode, dev);
        // Propagate injected node_ops to the newly created child node
        node.node_ops = mnt.node_ops;
        // Remember for each IDBFS node which IDBFS mount point they came from so we know which mount to persist on modification.
        node.idbfs_mount = mnt.mount;
        // Remember original MEMFS stream_ops for this node
        node.memfs_stream_ops = node.stream_ops;
        // Clone stream_ops to inject write tracking
        node.stream_ops = {
          ...node.stream_ops
        };
        // Track all file writes
        node.stream_ops.write = (stream, buffer, offset, length, position, canOwn) => {
          // This file has been modified, we must persist IndexedDB when this file closes
          stream.node.isModified = true;
          return node.memfs_stream_ops.write(stream, buffer, offset, length, position, canOwn);
        };
        // Persist IndexedDB on file close
        node.stream_ops.close = stream => {
          var n = stream.node;
          if (n.isModified) {
            IDBFS.queuePersist(n.idbfs_mount);
            n.isModified = false;
          }
          if (n.memfs_stream_ops.close) return n.memfs_stream_ops.close(stream);
        };
        // Persist the node we just created to IndexedDB
        IDBFS.queuePersist(mnt.mount);
        return node;
      };
      // Also kick off persisting the filesystem on other operations that modify the filesystem.
      mnt.node_ops.rmdir = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rmdir(...args));
      mnt.node_ops.symlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.symlink(...args));
      mnt.node_ops.unlink = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.unlink(...args));
      mnt.node_ops.rename = (...args) => (IDBFS.queuePersist(mnt.mount), memfs_node_ops.rename(...args));
    }
    return mnt;
  },
  syncfs: (mount, populate, callback) => {
    IDBFS.getLocalSet(mount, (err, local) => {
      if (err) return callback(err);
      IDBFS.getRemoteSet(mount, (err, remote) => {
        if (err) return callback(err);
        var src = populate ? remote : local;
        var dst = populate ? local : remote;
        IDBFS.reconcile(src, dst, callback);
      });
    });
  },
  quit: () => {
    for (var value of Object.values(IDBFS.dbs)) {
      value.close();
    }
    IDBFS.dbs = {};
  },
  getDB: (name, callback) => {
    // check the cache first
    var db = IDBFS.dbs[name];
    if (db) {
      return callback(null, db);
    }
    var req;
    try {
      req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
    } catch (e) {
      return callback(e);
    }
    if (!req) {
      return callback("Unable to connect to IndexedDB");
    }
    req.onupgradeneeded = e => {
      var db = /** @type {IDBDatabase} */ (e.target.result);
      var transaction = e.target.transaction;
      var fileStore;
      if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
        fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
      } else {
        fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
      }
      if (!fileStore.indexNames.contains("timestamp")) {
        fileStore.createIndex("timestamp", "timestamp", {
          unique: false
        });
      }
    };
    req.onsuccess = () => {
      db = /** @type {IDBDatabase} */ (req.result);
      // add to the cache
      IDBFS.dbs[name] = db;
      callback(null, db);
    };
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  getLocalSet: (mount, callback) => {
    var entries = {};
    function isRealDir(p) {
      return p !== "." && p !== "..";
    }
    function toAbsolute(root) {
      return p => PATH.join2(root, p);
    }
    var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
    while (check.length) {
      var path = check.pop();
      var stat;
      try {
        stat = FS.stat(path);
      } catch (e) {
        return callback(e);
      }
      if (FS.isDir(stat.mode)) {
        check.push(...FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
      }
      entries[path] = {
        "timestamp": stat.mtime
      };
    }
    return callback(null, {
      type: "local",
      entries
    });
  },
  getRemoteSet: (mount, callback) => {
    var entries = {};
    IDBFS.getDB(mount.mountpoint, (err, db) => {
      if (err) return callback(err);
      try {
        var transaction = db.transaction([ IDBFS.DB_STORE_NAME ], "readonly");
        transaction.onerror = e => {
          callback(e.target.error);
          e.preventDefault();
        };
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
        var index = store.index("timestamp");
        index.openKeyCursor().onsuccess = event => {
          var cursor = event.target.result;
          if (!cursor) {
            return callback(null, {
              type: "remote",
              db,
              entries
            });
          }
          entries[cursor.primaryKey] = {
            "timestamp": cursor.key
          };
          cursor.continue();
        };
      } catch (e) {
        return callback(e);
      }
    });
  },
  loadLocalEntry: (path, callback) => {
    var stat, node;
    try {
      var lookup = FS.lookupPath(path);
      node = lookup.node;
      stat = FS.stat(path);
    } catch (e) {
      return callback(e);
    }
    if (FS.isDir(stat.mode)) {
      return callback(null, {
        "timestamp": stat.mtime,
        "mode": stat.mode
      });
    } else if (FS.isFile(stat.mode)) {
      // Performance consideration: storing a normal JavaScript array to a IndexedDB is much slower than storing a typed array.
      // Therefore always convert the file contents to a typed array first before writing the data to IndexedDB.
      node.contents = MEMFS.getFileDataAsTypedArray(node);
      return callback(null, {
        "timestamp": stat.mtime,
        "mode": stat.mode,
        "contents": node.contents
      });
    } else {
      return callback(new Error("node type not supported"));
    }
  },
  storeLocalEntry: (path, entry, callback) => {
    try {
      if (FS.isDir(entry["mode"])) {
        FS.mkdirTree(path, entry["mode"]);
      } else if (FS.isFile(entry["mode"])) {
        FS.writeFile(path, entry["contents"], {
          canOwn: true
        });
      } else {
        return callback(new Error("node type not supported"));
      }
      FS.chmod(path, entry["mode"]);
      FS.utime(path, entry["timestamp"], entry["timestamp"]);
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  removeLocalEntry: (path, callback) => {
    try {
      var stat = FS.stat(path);
      if (FS.isDir(stat.mode)) {
        FS.rmdir(path);
      } else if (FS.isFile(stat.mode)) {
        FS.unlink(path);
      }
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  loadRemoteEntry: (store, path, callback) => {
    var req = store.get(path);
    req.onsuccess = event => callback(null, event.target.result);
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  storeRemoteEntry: (store, path, entry, callback) => {
    try {
      var req = store.put(entry, path);
    } catch (e) {
      callback(e);
      return;
    }
    req.onsuccess = event => callback();
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  removeRemoteEntry: (store, path, callback) => {
    var req = store.delete(path);
    req.onsuccess = event => callback();
    req.onerror = e => {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  reconcile: (src, dst, callback) => {
    var total = 0;
    var create = [];
    for (var [key, e] of Object.entries(src.entries)) {
      var e2 = dst.entries[key];
      if (!e2 || e["timestamp"].getTime() != e2["timestamp"].getTime()) {
        create.push(key);
        total++;
      }
    }
    var remove = [];
    for (var key of Object.keys(dst.entries)) {
      if (!src.entries[key]) {
        remove.push(key);
        total++;
      }
    }
    if (!total) {
      return callback(null);
    }
    var errored = false;
    var db = src.type === "remote" ? src.db : dst.db;
    var transaction = db.transaction([ IDBFS.DB_STORE_NAME ], "readwrite");
    var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
    function done(err) {
      if (err && !errored) {
        errored = true;
        return callback(err);
      }
    }
    // transaction may abort if (for example) there is a QuotaExceededError
    transaction.onerror = transaction.onabort = e => {
      done(e.target.error);
      e.preventDefault();
    };
    transaction.oncomplete = e => {
      if (!errored) {
        callback(null);
      }
    };
    // sort paths in ascending order so directory entries are created
    // before the files inside them
    for (const path of create.sort()) {
      if (dst.type === "local") {
        IDBFS.loadRemoteEntry(store, path, (err, entry) => {
          if (err) return done(err);
          IDBFS.storeLocalEntry(path, entry, done);
        });
      } else {
        IDBFS.loadLocalEntry(path, (err, entry) => {
          if (err) return done(err);
          IDBFS.storeRemoteEntry(store, path, entry, done);
        });
      }
    }
    // sort paths in descending order so files are deleted before their
    // parent directories
    for (var path of remove.sort().reverse()) {
      if (dst.type === "local") {
        IDBFS.removeLocalEntry(path, done);
      } else {
        IDBFS.removeRemoteEntry(store, path, done);
      }
    }
  }
};

var strError = errno => UTF8ToString(_strerror(errno));

var ERRNO_CODES = {
  "EPERM": 63,
  "ENOENT": 44,
  "ESRCH": 71,
  "EINTR": 27,
  "EIO": 29,
  "ENXIO": 60,
  "E2BIG": 1,
  "ENOEXEC": 45,
  "EBADF": 8,
  "ECHILD": 12,
  "EAGAIN": 6,
  "EWOULDBLOCK": 6,
  "ENOMEM": 48,
  "EACCES": 2,
  "EFAULT": 21,
  "ENOTBLK": 105,
  "EBUSY": 10,
  "EEXIST": 20,
  "EXDEV": 75,
  "ENODEV": 43,
  "ENOTDIR": 54,
  "EISDIR": 31,
  "EINVAL": 28,
  "ENFILE": 41,
  "EMFILE": 33,
  "ENOTTY": 59,
  "ETXTBSY": 74,
  "EFBIG": 22,
  "ENOSPC": 51,
  "ESPIPE": 70,
  "EROFS": 69,
  "EMLINK": 34,
  "EPIPE": 64,
  "EDOM": 18,
  "ERANGE": 68,
  "ENOMSG": 49,
  "EIDRM": 24,
  "ECHRNG": 106,
  "EL2NSYNC": 156,
  "EL3HLT": 107,
  "EL3RST": 108,
  "ELNRNG": 109,
  "EUNATCH": 110,
  "ENOCSI": 111,
  "EL2HLT": 112,
  "EDEADLK": 16,
  "ENOLCK": 46,
  "EBADE": 113,
  "EBADR": 114,
  "EXFULL": 115,
  "ENOANO": 104,
  "EBADRQC": 103,
  "EBADSLT": 102,
  "EDEADLOCK": 16,
  "EBFONT": 101,
  "ENOSTR": 100,
  "ENODATA": 116,
  "ETIME": 117,
  "ENOSR": 118,
  "ENONET": 119,
  "ENOPKG": 120,
  "EREMOTE": 121,
  "ENOLINK": 47,
  "EADV": 122,
  "ESRMNT": 123,
  "ECOMM": 124,
  "EPROTO": 65,
  "EMULTIHOP": 36,
  "EDOTDOT": 125,
  "EBADMSG": 9,
  "ENOTUNIQ": 126,
  "EBADFD": 127,
  "EREMCHG": 128,
  "ELIBACC": 129,
  "ELIBBAD": 130,
  "ELIBSCN": 131,
  "ELIBMAX": 132,
  "ELIBEXEC": 133,
  "ENOSYS": 52,
  "ENOTEMPTY": 55,
  "ENAMETOOLONG": 37,
  "ELOOP": 32,
  "EOPNOTSUPP": 138,
  "EPFNOSUPPORT": 139,
  "ECONNRESET": 15,
  "ENOBUFS": 42,
  "EAFNOSUPPORT": 5,
  "EPROTOTYPE": 67,
  "ENOTSOCK": 57,
  "ENOPROTOOPT": 50,
  "ESHUTDOWN": 140,
  "ECONNREFUSED": 14,
  "EADDRINUSE": 3,
  "ECONNABORTED": 13,
  "ENETUNREACH": 40,
  "ENETDOWN": 38,
  "ETIMEDOUT": 73,
  "EHOSTDOWN": 142,
  "EHOSTUNREACH": 23,
  "EINPROGRESS": 26,
  "EALREADY": 7,
  "EDESTADDRREQ": 17,
  "EMSGSIZE": 35,
  "EPROTONOSUPPORT": 66,
  "ESOCKTNOSUPPORT": 137,
  "EADDRNOTAVAIL": 4,
  "ENETRESET": 39,
  "EISCONN": 30,
  "ENOTCONN": 53,
  "ETOOMANYREFS": 141,
  "EUSERS": 136,
  "EDQUOT": 19,
  "ESTALE": 72,
  "ENOTSUP": 138,
  "ENOMEDIUM": 148,
  "EILSEQ": 25,
  "EOVERFLOW": 61,
  "ECANCELED": 11,
  "ENOTRECOVERABLE": 56,
  "EOWNERDEAD": 62,
  "ESTRPIPE": 135
};

var asyncLoad = async url => {
  var arrayBuffer = await readAsync(url);
  assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
  return new Uint8Array(arrayBuffer);
};

var FS_createDataFile = (...args) => FS.createDataFile(...args);

var getUniqueRunDependency = id => {
  var orig = id;
  while (1) {
    if (!runDependencyTracking[id]) return id;
    id = orig + Math.random();
  }
};

var preloadPlugins = [];

var FS_handledByPreloadPlugin = async (byteArray, fullname) => {
  // Ensure plugins are ready.
  if (typeof Browser != "undefined") Browser.init();
  for (var plugin of preloadPlugins) {
    if (plugin["canHandle"](fullname)) {
      assert(plugin["handle"].constructor.name === "AsyncFunction", "Filesystem plugin handlers must be async functions (See #24914)");
      return plugin["handle"](byteArray, fullname);
    }
  }
  // If no plugin handled this file then return the original/unmodified
  // byteArray.
  return byteArray;
};

var FS_preloadFile = async (parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish) => {
  // TODO we should allow people to just pass in a complete filename instead
  // of parent and name being that we just join them anyways
  var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
  var dep = getUniqueRunDependency(`cp ${fullname}`);
  // might have several active requests for the same fullname
  addRunDependency(dep);
  try {
    var byteArray = url;
    if (typeof url == "string") {
      byteArray = await asyncLoad(url);
    }
    byteArray = await FS_handledByPreloadPlugin(byteArray, fullname);
    preFinish?.();
    if (!dontCreateFile) {
      FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
    }
  } finally {
    removeRunDependency(dep);
  }
};

var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
  FS_preloadFile(parent, name, url, canRead, canWrite, dontCreateFile, canOwn, preFinish).then(onload).catch(onerror);
};

var FS = {
  root: null,
  mounts: [],
  devices: {},
  streams: [],
  nextInode: 1,
  nameTable: null,
  currentPath: "/",
  initialized: false,
  ignorePermissions: true,
  filesystems: null,
  syncFSRequests: 0,
  ErrnoError: class extends Error {
    name="ErrnoError";
    // We set the `name` property to be able to identify `FS.ErrnoError`
    // - the `name` is a standard ECMA-262 property of error objects. Kind of good to have it anyway.
    // - when using PROXYFS, an error can come from an underlying FS
    // as different FS objects have their own FS.ErrnoError each,
    // the test `err instanceof FS.ErrnoError` won't detect an error coming from another filesystem, causing bugs.
    // we'll use the reliable test `err.name == "ErrnoError"` instead
    constructor(errno) {
      super(runtimeInitialized ? strError(errno) : "");
      this.errno = errno;
      for (var key in ERRNO_CODES) {
        if (ERRNO_CODES[key] === errno) {
          this.code = key;
          break;
        }
      }
    }
  },
  FSStream: class {
    shared={};
    get object() {
      return this.node;
    }
    set object(val) {
      this.node = val;
    }
    get isRead() {
      return (this.flags & 2097155) !== 1;
    }
    get isWrite() {
      return (this.flags & 2097155) !== 0;
    }
    get isAppend() {
      return (this.flags & 1024);
    }
    get flags() {
      return this.shared.flags;
    }
    set flags(val) {
      this.shared.flags = val;
    }
    get position() {
      return this.shared.position;
    }
    set position(val) {
      this.shared.position = val;
    }
  },
  FSNode: class {
    node_ops={};
    stream_ops={};
    readMode=292 | 73;
    writeMode=146;
    mounted=null;
    constructor(parent, name, mode, rdev) {
      if (!parent) {
        parent = this;
      }
      this.parent = parent;
      this.mount = parent.mount;
      this.id = FS.nextInode++;
      this.name = name;
      this.mode = mode;
      this.rdev = rdev;
      this.atime = this.mtime = this.ctime = Date.now();
    }
    get read() {
      return (this.mode & this.readMode) === this.readMode;
    }
    set read(val) {
      val ? this.mode |= this.readMode : this.mode &= ~this.readMode;
    }
    get write() {
      return (this.mode & this.writeMode) === this.writeMode;
    }
    set write(val) {
      val ? this.mode |= this.writeMode : this.mode &= ~this.writeMode;
    }
    get isFolder() {
      return FS.isDir(this.mode);
    }
    get isDevice() {
      return FS.isChrdev(this.mode);
    }
  },
  lookupPath(path, opts = {}) {
    if (!path) {
      throw new FS.ErrnoError(44);
    }
    opts.follow_mount ??= true;
    if (!PATH.isAbs(path)) {
      path = FS.cwd() + "/" + path;
    }
    // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
    linkloop: for (var nlinks = 0; nlinks < 40; nlinks++) {
      // split the absolute path
      var parts = path.split("/").filter(p => !!p);
      // start at the root
      var current = FS.root;
      var current_path = "/";
      for (var i = 0; i < parts.length; i++) {
        var islast = (i === parts.length - 1);
        if (islast && opts.parent) {
          // stop resolving
          break;
        }
        if (parts[i] === ".") {
          continue;
        }
        if (parts[i] === "..") {
          current_path = PATH.dirname(current_path);
          if (FS.isRoot(current)) {
            path = current_path + "/" + parts.slice(i + 1).join("/");
            // We're making progress here, don't let many consecutive ..'s
            // lead to ELOOP
            nlinks--;
            continue linkloop;
          } else {
            current = current.parent;
          }
          continue;
        }
        current_path = PATH.join2(current_path, parts[i]);
        try {
          current = FS.lookupNode(current, parts[i]);
        } catch (e) {
          // if noent_okay is true, suppress a ENOENT in the last component
          // and return an object with an undefined node. This is needed for
          // resolving symlinks in the path when creating a file.
          if ((e?.errno === 44) && islast && opts.noent_okay) {
            return {
              path: current_path
            };
          }
          throw e;
        }
        // jump to the mount's root node if this is a mountpoint
        if (FS.isMountpoint(current) && (!islast || opts.follow_mount)) {
          current = current.mounted.root;
        }
        // by default, lookupPath will not follow a symlink if it is the final path component.
        // setting opts.follow = true will override this behavior.
        if (FS.isLink(current.mode) && (!islast || opts.follow)) {
          if (!current.node_ops.readlink) {
            throw new FS.ErrnoError(52);
          }
          var link = current.node_ops.readlink(current);
          if (!PATH.isAbs(link)) {
            link = PATH.dirname(current_path) + "/" + link;
          }
          path = link + "/" + parts.slice(i + 1).join("/");
          continue linkloop;
        }
      }
      return {
        path: current_path,
        node: current
      };
    }
    throw new FS.ErrnoError(32);
  },
  getPath(node) {
    var path;
    while (true) {
      if (FS.isRoot(node)) {
        var mount = node.mount.mountpoint;
        if (!path) return mount;
        return mount[mount.length - 1] !== "/" ? `${mount}/${path}` : mount + path;
      }
      path = path ? `${node.name}/${path}` : node.name;
      node = node.parent;
    }
  },
  hashName(parentid, name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return ((parentid + hash) >>> 0) % FS.nameTable.length;
  },
  hashAddNode(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    node.name_next = FS.nameTable[hash];
    FS.nameTable[hash] = node;
  },
  hashRemoveNode(node) {
    var hash = FS.hashName(node.parent.id, node.name);
    if (FS.nameTable[hash] === node) {
      FS.nameTable[hash] = node.name_next;
    } else {
      var current = FS.nameTable[hash];
      while (current) {
        if (current.name_next === node) {
          current.name_next = node.name_next;
          break;
        }
        current = current.name_next;
      }
    }
  },
  lookupNode(parent, name) {
    var errCode = FS.mayLookup(parent);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    var hash = FS.hashName(parent.id, name);
    for (var node = FS.nameTable[hash]; node; node = node.name_next) {
      var nodeName = node.name;
      if (node.parent.id === parent.id && nodeName === name) {
        return node;
      }
    }
    // if we failed to find it in the cache, call into the VFS
    return FS.lookup(parent, name);
  },
  createNode(parent, name, mode, rdev) {
    assert(typeof parent == "object");
    var node = new FS.FSNode(parent, name, mode, rdev);
    FS.hashAddNode(node);
    return node;
  },
  destroyNode(node) {
    FS.hashRemoveNode(node);
  },
  isRoot(node) {
    return node === node.parent;
  },
  isMountpoint(node) {
    return !!node.mounted;
  },
  isFile(mode) {
    return (mode & 61440) === 32768;
  },
  isDir(mode) {
    return (mode & 61440) === 16384;
  },
  isLink(mode) {
    return (mode & 61440) === 40960;
  },
  isChrdev(mode) {
    return (mode & 61440) === 8192;
  },
  isBlkdev(mode) {
    return (mode & 61440) === 24576;
  },
  isFIFO(mode) {
    return (mode & 61440) === 4096;
  },
  isSocket(mode) {
    return (mode & 49152) === 49152;
  },
  flagsToPermissionString(flag) {
    var perms = [ "r", "w", "rw" ][flag & 3];
    if ((flag & 512)) {
      perms += "w";
    }
    return perms;
  },
  nodePermissions(node, perms) {
    if (FS.ignorePermissions) {
      return 0;
    }
    // return 0 if any user, group or owner bits are set.
    if (perms.includes("r") && !(node.mode & 292)) {
      return 2;
    }
    if (perms.includes("w") && !(node.mode & 146)) {
      return 2;
    }
    if (perms.includes("x") && !(node.mode & 73)) {
      return 2;
    }
    return 0;
  },
  mayLookup(dir) {
    if (!FS.isDir(dir.mode)) return 54;
    var errCode = FS.nodePermissions(dir, "x");
    if (errCode) return errCode;
    if (!dir.node_ops.lookup) return 2;
    return 0;
  },
  mayCreate(dir, name) {
    if (!FS.isDir(dir.mode)) {
      return 54;
    }
    try {
      var node = FS.lookupNode(dir, name);
      return 20;
    } catch (e) {}
    return FS.nodePermissions(dir, "wx");
  },
  mayDelete(dir, name, isdir) {
    var node;
    try {
      node = FS.lookupNode(dir, name);
    } catch (e) {
      return e.errno;
    }
    var errCode = FS.nodePermissions(dir, "wx");
    if (errCode) {
      return errCode;
    }
    if (isdir) {
      if (!FS.isDir(node.mode)) {
        return 54;
      }
      if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
        return 10;
      }
    } else if (FS.isDir(node.mode)) {
      return 31;
    }
    return 0;
  },
  mayOpen(node, flags) {
    if (!node) {
      return 44;
    }
    if (FS.isLink(node.mode)) {
      return 32;
    }
    var mode = FS.flagsToPermissionString(flags);
    if (FS.isDir(node.mode)) {
      // opening for write
      // TODO: check for O_SEARCH? (== search for dir only)
      if (mode !== "r" || (flags & (512 | 64))) {
        return 31;
      }
    }
    return FS.nodePermissions(node, mode);
  },
  checkOpExists(op, err) {
    if (!op) {
      throw new FS.ErrnoError(err);
    }
    return op;
  },
  MAX_OPEN_FDS: 4096,
  nextfd() {
    for (var fd = 0; fd <= FS.MAX_OPEN_FDS; fd++) {
      if (!FS.streams[fd]) {
        return fd;
      }
    }
    throw new FS.ErrnoError(33);
  },
  getStreamChecked(fd) {
    var stream = FS.getStream(fd);
    if (!stream) {
      throw new FS.ErrnoError(8);
    }
    return stream;
  },
  getStream: fd => FS.streams[fd],
  createStream(stream, fd = -1) {
    assert(fd >= -1);
    // clone it, so we can return an instance of FSStream
    stream = Object.assign(new FS.FSStream, stream);
    if (fd == -1) {
      fd = FS.nextfd();
    }
    stream.fd = fd;
    FS.streams[fd] = stream;
    return stream;
  },
  closeStream(fd) {
    FS.streams[fd] = null;
  },
  dupStream(origStream, fd = -1) {
    var stream = FS.createStream(origStream, fd);
    stream.stream_ops?.dup?.(stream);
    return stream;
  },
  doSetAttr(stream, node, attr) {
    var setattr = stream?.stream_ops.setattr;
    var arg = setattr ? stream : node;
    setattr ??= node.node_ops.setattr;
    FS.checkOpExists(setattr, 63);
    setattr(arg, attr);
  },
  chrdev_stream_ops: {
    open(stream) {
      var device = FS.getDevice(stream.node.rdev);
      // override node's stream ops with the device's
      stream.stream_ops = device.stream_ops;
      // forward the open call
      stream.stream_ops.open?.(stream);
    },
    llseek() {
      throw new FS.ErrnoError(70);
    }
  },
  major: dev => ((dev) >> 8),
  minor: dev => ((dev) & 255),
  makedev: (ma, mi) => ((ma) << 8 | (mi)),
  registerDevice(dev, ops) {
    FS.devices[dev] = {
      stream_ops: ops
    };
  },
  getDevice: dev => FS.devices[dev],
  getMounts(mount) {
    var mounts = [];
    var check = [ mount ];
    while (check.length) {
      var m = check.pop();
      mounts.push(m);
      check.push(...m.mounts);
    }
    return mounts;
  },
  syncfs(populate, callback) {
    if (typeof populate == "function") {
      callback = populate;
      populate = false;
    }
    FS.syncFSRequests++;
    if (FS.syncFSRequests > 1) {
      err(`warning: ${FS.syncFSRequests} FS.syncfs operations in flight at once, probably just doing extra work`);
    }
    var mounts = FS.getMounts(FS.root.mount);
    var completed = 0;
    function doCallback(errCode) {
      assert(FS.syncFSRequests > 0);
      FS.syncFSRequests--;
      return callback(errCode);
    }
    function done(errCode) {
      if (errCode) {
        if (!done.errored) {
          done.errored = true;
          return doCallback(errCode);
        }
        return;
      }
      if (++completed >= mounts.length) {
        doCallback(null);
      }
    }
    // sync all mounts
    for (var mount of mounts) {
      if (mount.type.syncfs) {
        mount.type.syncfs(mount, populate, done);
      } else {
        done(null);
      }
    }
  },
  mount(type, opts, mountpoint) {
    if (typeof type == "string") {
      // The filesystem was not included, and instead we have an error
      // message stored in the variable.
      throw type;
    }
    var root = mountpoint === "/";
    var pseudo = !mountpoint;
    var node;
    if (root && FS.root) {
      throw new FS.ErrnoError(10);
    } else if (!root && !pseudo) {
      var lookup = FS.lookupPath(mountpoint, {
        follow_mount: false
      });
      mountpoint = lookup.path;
      // use the absolute path
      node = lookup.node;
      if (FS.isMountpoint(node)) {
        throw new FS.ErrnoError(10);
      }
      if (!FS.isDir(node.mode)) {
        throw new FS.ErrnoError(54);
      }
    }
    var mount = {
      type,
      opts,
      mountpoint,
      mounts: []
    };
    // create a root node for the fs
    var mountRoot = type.mount(mount);
    mountRoot.mount = mount;
    mount.root = mountRoot;
    if (root) {
      FS.root = mountRoot;
    } else if (node) {
      // set as a mountpoint
      node.mounted = mount;
      // add the new mount to the current mount's children
      if (node.mount) {
        node.mount.mounts.push(mount);
      }
    }
    return mountRoot;
  },
  unmount(mountpoint) {
    var lookup = FS.lookupPath(mountpoint, {
      follow_mount: false
    });
    if (!FS.isMountpoint(lookup.node)) {
      throw new FS.ErrnoError(28);
    }
    // destroy the nodes for this mount, and all its child mounts
    var node = lookup.node;
    var mount = node.mounted;
    var mounts = FS.getMounts(mount);
    for (var [hash, current] of Object.entries(FS.nameTable)) {
      while (current) {
        var next = current.name_next;
        if (mounts.includes(current.mount)) {
          FS.destroyNode(current);
        }
        current = next;
      }
    }
    // no longer a mountpoint
    node.mounted = null;
    // remove this mount from the child mounts
    var idx = node.mount.mounts.indexOf(mount);
    assert(idx !== -1);
    node.mount.mounts.splice(idx, 1);
  },
  lookup(parent, name) {
    return parent.node_ops.lookup(parent, name);
  },
  mknod(path, mode, dev) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    if (!name) {
      throw new FS.ErrnoError(28);
    }
    if (name === "." || name === "..") {
      throw new FS.ErrnoError(20);
    }
    var errCode = FS.mayCreate(parent, name);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.mknod) {
      throw new FS.ErrnoError(63);
    }
    return parent.node_ops.mknod(parent, name, mode, dev);
  },
  statfs(path) {
    return FS.statfsNode(FS.lookupPath(path, {
      follow: true
    }).node);
  },
  statfsStream(stream) {
    // We keep a separate statfsStream function because noderawfs overrides
    // it. In noderawfs, stream.node is sometimes null. Instead, we need to
    // look at stream.path.
    return FS.statfsNode(stream.node);
  },
  statfsNode(node) {
    // NOTE: None of the defaults here are true. We're just returning safe and
    //       sane values. Currently nodefs and rawfs replace these defaults,
    //       other file systems leave them alone.
    var rtn = {
      bsize: 4096,
      frsize: 4096,
      blocks: 1e6,
      bfree: 5e5,
      bavail: 5e5,
      files: FS.nextInode,
      ffree: FS.nextInode - 1,
      fsid: 42,
      flags: 2,
      namelen: 255
    };
    if (node.node_ops.statfs) {
      Object.assign(rtn, node.node_ops.statfs(node.mount.opts.root));
    }
    return rtn;
  },
  create(path, mode = 438) {
    mode &= 4095;
    mode |= 32768;
    return FS.mknod(path, mode, 0);
  },
  mkdir(path, mode = 511) {
    mode &= 511 | 512;
    mode |= 16384;
    return FS.mknod(path, mode, 0);
  },
  mkdirTree(path, mode) {
    var dirs = path.split("/");
    var d = "";
    for (var dir of dirs) {
      if (!dir) continue;
      if (d || PATH.isAbs(path)) d += "/";
      d += dir;
      try {
        FS.mkdir(d, mode);
      } catch (e) {
        if (e.errno != 20) throw e;
      }
    }
  },
  mkdev(path, mode, dev) {
    if (typeof dev == "undefined") {
      dev = mode;
      mode = 438;
    }
    mode |= 8192;
    return FS.mknod(path, mode, dev);
  },
  symlink(oldpath, newpath) {
    if (!PATH_FS.resolve(oldpath)) {
      throw new FS.ErrnoError(44);
    }
    var lookup = FS.lookupPath(newpath, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(44);
    }
    var newname = PATH.basename(newpath);
    var errCode = FS.mayCreate(parent, newname);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.symlink) {
      throw new FS.ErrnoError(63);
    }
    return parent.node_ops.symlink(parent, newname, oldpath);
  },
  rename(old_path, new_path) {
    var old_dirname = PATH.dirname(old_path);
    var new_dirname = PATH.dirname(new_path);
    var old_name = PATH.basename(old_path);
    var new_name = PATH.basename(new_path);
    // parents must exist
    var lookup, old_dir, new_dir;
    // let the errors from non existent directories percolate up
    lookup = FS.lookupPath(old_path, {
      parent: true
    });
    old_dir = lookup.node;
    lookup = FS.lookupPath(new_path, {
      parent: true
    });
    new_dir = lookup.node;
    if (!old_dir || !new_dir) throw new FS.ErrnoError(44);
    // need to be part of the same mount
    if (old_dir.mount !== new_dir.mount) {
      throw new FS.ErrnoError(75);
    }
    // source must exist
    var old_node = FS.lookupNode(old_dir, old_name);
    // old path should not be an ancestor of the new path
    var relative = PATH_FS.relative(old_path, new_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(28);
    }
    // new path should not be an ancestor of the old path
    relative = PATH_FS.relative(new_path, old_dirname);
    if (relative.charAt(0) !== ".") {
      throw new FS.ErrnoError(55);
    }
    // see if the new path already exists
    var new_node;
    try {
      new_node = FS.lookupNode(new_dir, new_name);
    } catch (e) {}
    // early out if nothing needs to change
    if (old_node === new_node) {
      return;
    }
    // we'll need to delete the old entry
    var isdir = FS.isDir(old_node.mode);
    var errCode = FS.mayDelete(old_dir, old_name, isdir);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    // need delete permissions if we'll be overwriting.
    // need create permissions if new doesn't already exist.
    errCode = new_node ? FS.mayDelete(new_dir, new_name, isdir) : FS.mayCreate(new_dir, new_name);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!old_dir.node_ops.rename) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
      throw new FS.ErrnoError(10);
    }
    // if we are going to change the parent, check write permissions
    if (new_dir !== old_dir) {
      errCode = FS.nodePermissions(old_dir, "w");
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
    }
    // remove the node from the lookup hash
    FS.hashRemoveNode(old_node);
    // do the underlying fs rename
    try {
      old_dir.node_ops.rename(old_node, new_dir, new_name);
      // update old node (we do this here to avoid each backend
      // needing to)
      old_node.parent = new_dir;
    } catch (e) {
      throw e;
    } finally {
      // add the node back to the hash (in case node_ops.rename
      // changed its name)
      FS.hashAddNode(old_node);
    }
  },
  rmdir(path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var errCode = FS.mayDelete(parent, name, true);
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.rmdir) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(10);
    }
    parent.node_ops.rmdir(parent, name);
    FS.destroyNode(node);
  },
  readdir(path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    var node = lookup.node;
    var readdir = FS.checkOpExists(node.node_ops.readdir, 54);
    return readdir(node);
  },
  unlink(path) {
    var lookup = FS.lookupPath(path, {
      parent: true
    });
    var parent = lookup.node;
    if (!parent) {
      throw new FS.ErrnoError(44);
    }
    var name = PATH.basename(path);
    var node = FS.lookupNode(parent, name);
    var errCode = FS.mayDelete(parent, name, false);
    if (errCode) {
      // According to POSIX, we should map EISDIR to EPERM, but
      // we instead do what Linux does (and we must, as we use
      // the musl linux libc).
      throw new FS.ErrnoError(errCode);
    }
    if (!parent.node_ops.unlink) {
      throw new FS.ErrnoError(63);
    }
    if (FS.isMountpoint(node)) {
      throw new FS.ErrnoError(10);
    }
    parent.node_ops.unlink(parent, name);
    FS.destroyNode(node);
  },
  readlink(path) {
    var lookup = FS.lookupPath(path);
    var link = lookup.node;
    if (!link) {
      throw new FS.ErrnoError(44);
    }
    if (!link.node_ops.readlink) {
      throw new FS.ErrnoError(28);
    }
    return link.node_ops.readlink(link);
  },
  stat(path, dontFollow) {
    var lookup = FS.lookupPath(path, {
      follow: !dontFollow
    });
    var node = lookup.node;
    var getattr = FS.checkOpExists(node.node_ops.getattr, 63);
    return getattr(node);
  },
  fstat(fd) {
    var stream = FS.getStreamChecked(fd);
    var node = stream.node;
    var getattr = stream.stream_ops.getattr;
    var arg = getattr ? stream : node;
    getattr ??= node.node_ops.getattr;
    FS.checkOpExists(getattr, 63);
    return getattr(arg);
  },
  lstat(path) {
    return FS.stat(path, true);
  },
  doChmod(stream, node, mode, dontFollow) {
    FS.doSetAttr(stream, node, {
      mode: (mode & 4095) | (node.mode & ~4095),
      ctime: Date.now(),
      dontFollow
    });
  },
  chmod(path, mode, dontFollow) {
    var node;
    if (typeof path == "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doChmod(null, node, mode, dontFollow);
  },
  lchmod(path, mode) {
    FS.chmod(path, mode, true);
  },
  fchmod(fd, mode) {
    var stream = FS.getStreamChecked(fd);
    FS.doChmod(stream, stream.node, mode, false);
  },
  doChown(stream, node, dontFollow) {
    FS.doSetAttr(stream, node, {
      timestamp: Date.now(),
      dontFollow
    });
  },
  chown(path, uid, gid, dontFollow) {
    var node;
    if (typeof path == "string") {
      var lookup = FS.lookupPath(path, {
        follow: !dontFollow
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doChown(null, node, dontFollow);
  },
  lchown(path, uid, gid) {
    FS.chown(path, uid, gid, true);
  },
  fchown(fd, uid, gid) {
    var stream = FS.getStreamChecked(fd);
    FS.doChown(stream, stream.node, false);
  },
  doTruncate(stream, node, len) {
    if (FS.isDir(node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!FS.isFile(node.mode)) {
      throw new FS.ErrnoError(28);
    }
    var errCode = FS.nodePermissions(node, "w");
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    FS.doSetAttr(stream, node, {
      size: len,
      timestamp: Date.now()
    });
  },
  truncate(path, len) {
    if (len < 0) {
      throw new FS.ErrnoError(28);
    }
    var node;
    if (typeof path == "string") {
      var lookup = FS.lookupPath(path, {
        follow: true
      });
      node = lookup.node;
    } else {
      node = path;
    }
    FS.doTruncate(null, node, len);
  },
  ftruncate(fd, len) {
    var stream = FS.getStreamChecked(fd);
    if (len < 0 || (stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(28);
    }
    FS.doTruncate(stream, stream.node, len);
  },
  utime(path, atime, mtime) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    var node = lookup.node;
    var setattr = FS.checkOpExists(node.node_ops.setattr, 63);
    setattr(node, {
      atime,
      mtime
    });
  },
  open(path, flags, mode = 438) {
    if (path === "") {
      throw new FS.ErrnoError(44);
    }
    flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
    if ((flags & 64)) {
      mode = (mode & 4095) | 32768;
    } else {
      mode = 0;
    }
    var node;
    var isDirPath;
    if (typeof path == "object") {
      node = path;
    } else {
      isDirPath = path.endsWith("/");
      // noent_okay makes it so that if the final component of the path
      // doesn't exist, lookupPath returns `node: undefined`. `path` will be
      // updated to point to the target of all symlinks.
      var lookup = FS.lookupPath(path, {
        follow: !(flags & 131072),
        noent_okay: true
      });
      node = lookup.node;
      path = lookup.path;
    }
    // perhaps we need to create the node
    var created = false;
    if ((flags & 64)) {
      if (node) {
        // if O_CREAT and O_EXCL are set, error out if the node already exists
        if ((flags & 128)) {
          throw new FS.ErrnoError(20);
        }
      } else if (isDirPath) {
        throw new FS.ErrnoError(31);
      } else {
        // node doesn't exist, try to create it
        // Ignore the permission bits here to ensure we can `open` this new
        // file below. We use chmod below to apply the permissions once the
        // file is open.
        node = FS.mknod(path, mode | 511, 0);
        created = true;
      }
    }
    if (!node) {
      throw new FS.ErrnoError(44);
    }
    // can't truncate a device
    if (FS.isChrdev(node.mode)) {
      flags &= ~512;
    }
    // if asked only for a directory, then this must be one
    if ((flags & 65536) && !FS.isDir(node.mode)) {
      throw new FS.ErrnoError(54);
    }
    // check permissions, if this is not a file we just created now (it is ok to
    // create and write to a file with read-only permissions; it is read-only
    // for later use)
    if (!created) {
      var errCode = FS.mayOpen(node, flags);
      if (errCode) {
        throw new FS.ErrnoError(errCode);
      }
    }
    // do truncation if necessary
    if ((flags & 512) && !created) {
      FS.truncate(node, 0);
    }
    // we've already handled these, don't pass down to the underlying vfs
    flags &= ~(128 | 512 | 131072);
    // register the stream with the filesystem
    var stream = FS.createStream({
      node,
      path: FS.getPath(node),
      // we want the absolute path to the node
      flags,
      seekable: true,
      position: 0,
      stream_ops: node.stream_ops,
      // used by the file family libc calls (fopen, fwrite, ferror, etc.)
      ungotten: [],
      error: false
    });
    // call the new stream's open function
    if (stream.stream_ops.open) {
      stream.stream_ops.open(stream);
    }
    if (created) {
      FS.chmod(node, mode & 511);
    }
    return stream;
  },
  close(stream) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if (stream.getdents) stream.getdents = null;
    // free readdir state
    try {
      if (stream.stream_ops.close) {
        stream.stream_ops.close(stream);
      }
    } catch (e) {
      throw e;
    } finally {
      FS.closeStream(stream.fd);
    }
    stream.fd = null;
  },
  isClosed(stream) {
    return stream.fd === null;
  },
  llseek(stream, offset, whence) {
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if (!stream.seekable || !stream.stream_ops.llseek) {
      throw new FS.ErrnoError(70);
    }
    if (whence != 0 && whence != 1 && whence != 2) {
      throw new FS.ErrnoError(28);
    }
    stream.position = stream.stream_ops.llseek(stream, offset, whence);
    stream.ungotten = [];
    return stream.position;
  },
  read(stream, buffer, offset, length, position) {
    assert(offset >= 0);
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(28);
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(8);
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!stream.stream_ops.read) {
      throw new FS.ErrnoError(28);
    }
    var seeking = typeof position != "undefined";
    if (!seeking) {
      position = stream.position;
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(70);
    }
    var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
    if (!seeking) stream.position += bytesRead;
    return bytesRead;
  },
  write(stream, buffer, offset, length, position, canOwn) {
    assert(offset >= 0);
    if (length < 0 || position < 0) {
      throw new FS.ErrnoError(28);
    }
    if (FS.isClosed(stream)) {
      throw new FS.ErrnoError(8);
    }
    if ((stream.flags & 2097155) === 0) {
      throw new FS.ErrnoError(8);
    }
    if (FS.isDir(stream.node.mode)) {
      throw new FS.ErrnoError(31);
    }
    if (!stream.stream_ops.write) {
      throw new FS.ErrnoError(28);
    }
    if (stream.seekable && stream.flags & 1024) {
      // seek to the end before writing in append mode
      FS.llseek(stream, 0, 2);
    }
    var seeking = typeof position != "undefined";
    if (!seeking) {
      position = stream.position;
    } else if (!stream.seekable) {
      throw new FS.ErrnoError(70);
    }
    var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
    if (!seeking) stream.position += bytesWritten;
    return bytesWritten;
  },
  mmap(stream, length, position, prot, flags) {
    // User requests writing to file (prot & PROT_WRITE != 0).
    // Checking if we have permissions to write to the file unless
    // MAP_PRIVATE flag is set. According to POSIX spec it is possible
    // to write to file opened in read-only mode with MAP_PRIVATE flag,
    // as all modifications will be visible only in the memory of
    // the current process.
    if ((prot & 2) !== 0 && (flags & 2) === 0 && (stream.flags & 2097155) !== 2) {
      throw new FS.ErrnoError(2);
    }
    if ((stream.flags & 2097155) === 1) {
      throw new FS.ErrnoError(2);
    }
    if (!stream.stream_ops.mmap) {
      throw new FS.ErrnoError(43);
    }
    if (!length) {
      throw new FS.ErrnoError(28);
    }
    return stream.stream_ops.mmap(stream, length, position, prot, flags);
  },
  msync(stream, buffer, offset, length, mmapFlags) {
    assert(offset >= 0);
    if (!stream.stream_ops.msync) {
      return 0;
    }
    return stream.stream_ops.msync(stream, buffer, offset, length, mmapFlags);
  },
  ioctl(stream, cmd, arg) {
    if (!stream.stream_ops.ioctl) {
      throw new FS.ErrnoError(59);
    }
    return stream.stream_ops.ioctl(stream, cmd, arg);
  },
  readFile(path, opts = {}) {
    opts.flags = opts.flags || 0;
    opts.encoding = opts.encoding || "binary";
    if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
      abort(`Invalid encoding type "${opts.encoding}"`);
    }
    var stream = FS.open(path, opts.flags);
    var stat = FS.stat(path);
    var length = stat.size;
    var buf = new Uint8Array(length);
    FS.read(stream, buf, 0, length, 0);
    if (opts.encoding === "utf8") {
      buf = UTF8ArrayToString(buf);
    }
    FS.close(stream);
    return buf;
  },
  writeFile(path, data, opts = {}) {
    opts.flags = opts.flags || 577;
    var stream = FS.open(path, opts.flags, opts.mode);
    if (typeof data == "string") {
      data = new Uint8Array(intArrayFromString(data, true));
    }
    if (ArrayBuffer.isView(data)) {
      FS.write(stream, data, 0, data.byteLength, undefined, opts.canOwn);
    } else {
      abort("Unsupported data type");
    }
    FS.close(stream);
  },
  cwd: () => FS.currentPath,
  chdir(path) {
    var lookup = FS.lookupPath(path, {
      follow: true
    });
    if (lookup.node === null) {
      throw new FS.ErrnoError(44);
    }
    if (!FS.isDir(lookup.node.mode)) {
      throw new FS.ErrnoError(54);
    }
    var errCode = FS.nodePermissions(lookup.node, "x");
    if (errCode) {
      throw new FS.ErrnoError(errCode);
    }
    FS.currentPath = lookup.path;
  },
  createDefaultDirectories() {
    FS.mkdir("/tmp");
    FS.mkdir("/home");
    FS.mkdir("/home/web_user");
  },
  createDefaultDevices() {
    // create /dev
    FS.mkdir("/dev");
    // setup /dev/null
    FS.registerDevice(FS.makedev(1, 3), {
      read: () => 0,
      write: (stream, buffer, offset, length, pos) => length,
      llseek: () => 0
    });
    FS.mkdev("/dev/null", FS.makedev(1, 3));
    // setup /dev/tty and /dev/tty1
    // stderr needs to print output using err() rather than out()
    // so we register a second tty just for it.
    TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
    TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
    FS.mkdev("/dev/tty", FS.makedev(5, 0));
    FS.mkdev("/dev/tty1", FS.makedev(6, 0));
    // setup /dev/[u]random
    // use a buffer to avoid overhead of individual crypto calls per byte
    var randomBuffer = new Uint8Array(1024), randomLeft = 0;
    var randomByte = () => {
      if (randomLeft === 0) {
        randomFill(randomBuffer);
        randomLeft = randomBuffer.byteLength;
      }
      return randomBuffer[--randomLeft];
    };
    FS.createDevice("/dev", "random", randomByte);
    FS.createDevice("/dev", "urandom", randomByte);
    // we're not going to emulate the actual shm device,
    // just create the tmp dirs that reside in it commonly
    FS.mkdir("/dev/shm");
    FS.mkdir("/dev/shm/tmp");
  },
  createSpecialDirectories() {
    // create /proc/self/fd which allows /proc/self/fd/6 => readlink gives the
    // name of the stream for fd 6 (see test_unistd_ttyname)
    FS.mkdir("/proc");
    var proc_self = FS.mkdir("/proc/self");
    FS.mkdir("/proc/self/fd");
    FS.mount({
      mount() {
        var node = FS.createNode(proc_self, "fd", 16895, 73);
        node.stream_ops = {
          llseek: MEMFS.stream_ops.llseek
        };
        node.node_ops = {
          lookup(parent, name) {
            var fd = +name;
            var stream = FS.getStreamChecked(fd);
            var ret = {
              parent: null,
              mount: {
                mountpoint: "fake"
              },
              node_ops: {
                readlink: () => stream.path
              },
              id: fd + 1
            };
            ret.parent = ret;
            // make it look like a simple root node
            return ret;
          },
          readdir() {
            return Array.from(FS.streams.entries()).filter(([k, v]) => v).map(([k, v]) => k.toString());
          }
        };
        return node;
      }
    }, {}, "/proc/self/fd");
  },
  createStandardStreams(input, output, error) {
    // TODO deprecate the old functionality of a single
    // input / output callback and that utilizes FS.createDevice
    // and instead require a unique set of stream ops
    // by default, we symlink the standard streams to the
    // default tty devices. however, if the standard streams
    // have been overwritten we create a unique device for
    // them instead.
    if (input) {
      FS.createDevice("/dev", "stdin", input);
    } else {
      FS.symlink("/dev/tty", "/dev/stdin");
    }
    if (output) {
      FS.createDevice("/dev", "stdout", null, output);
    } else {
      FS.symlink("/dev/tty", "/dev/stdout");
    }
    if (error) {
      FS.createDevice("/dev", "stderr", null, error);
    } else {
      FS.symlink("/dev/tty1", "/dev/stderr");
    }
    // open default streams for the stdin, stdout and stderr devices
    var stdin = FS.open("/dev/stdin", 0);
    var stdout = FS.open("/dev/stdout", 1);
    var stderr = FS.open("/dev/stderr", 1);
    assert(stdin.fd === 0, `invalid handle for stdin (${stdin.fd})`);
    assert(stdout.fd === 1, `invalid handle for stdout (${stdout.fd})`);
    assert(stderr.fd === 2, `invalid handle for stderr (${stderr.fd})`);
  },
  staticInit() {
    FS.nameTable = new Array(4096);
    FS.mount(MEMFS, {}, "/");
    FS.createDefaultDirectories();
    FS.createDefaultDevices();
    FS.createSpecialDirectories();
    FS.filesystems = {
      "MEMFS": MEMFS,
      "IDBFS": IDBFS
    };
  },
  init(input, output, error) {
    assert(!FS.initialized, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
    FS.initialized = true;
    // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
    input ??= Module["stdin"];
    output ??= Module["stdout"];
    error ??= Module["stderr"];
    FS.createStandardStreams(input, output, error);
  },
  quit() {
    FS.initialized = false;
    // force-flush all streams, so we get musl std streams printed out
    _fflush(0);
    // close all of our streams
    for (var stream of FS.streams) {
      if (stream) {
        FS.close(stream);
      }
    }
  },
  findObject(path, dontResolveLastLink) {
    var ret = FS.analyzePath(path, dontResolveLastLink);
    if (!ret.exists) {
      return null;
    }
    return ret.object;
  },
  analyzePath(path, dontResolveLastLink) {
    // operate from within the context of the symlink's target
    try {
      var lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      path = lookup.path;
    } catch (e) {}
    var ret = {
      isRoot: false,
      exists: false,
      error: 0,
      name: null,
      path: null,
      object: null,
      parentExists: false,
      parentPath: null,
      parentObject: null
    };
    try {
      var lookup = FS.lookupPath(path, {
        parent: true
      });
      ret.parentExists = true;
      ret.parentPath = lookup.path;
      ret.parentObject = lookup.node;
      ret.name = PATH.basename(path);
      lookup = FS.lookupPath(path, {
        follow: !dontResolveLastLink
      });
      ret.exists = true;
      ret.path = lookup.path;
      ret.object = lookup.node;
      ret.name = lookup.node.name;
      ret.isRoot = lookup.path === "/";
    } catch (e) {
      ret.error = e.errno;
    }
    return ret;
  },
  createPath(parent, path, canRead, canWrite) {
    parent = typeof parent == "string" ? parent : FS.getPath(parent);
    var parts = path.split("/").reverse();
    while (parts.length) {
      var part = parts.pop();
      if (!part) continue;
      var current = PATH.join2(parent, part);
      try {
        FS.mkdir(current);
      } catch (e) {
        if (e.errno != 20) throw e;
      }
      parent = current;
    }
    return current;
  },
  createFile(parent, name, properties, canRead, canWrite) {
    var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
    var mode = FS_getMode(canRead, canWrite);
    return FS.create(path, mode);
  },
  createDataFile(parent, name, data, canRead, canWrite, canOwn) {
    var path = name;
    if (parent) {
      parent = typeof parent == "string" ? parent : FS.getPath(parent);
      path = name ? PATH.join2(parent, name) : parent;
    }
    var mode = FS_getMode(canRead, canWrite);
    var node = FS.create(path, mode);
    if (data) {
      if (typeof data == "string") {
        var arr = new Array(data.length);
        for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
        data = arr;
      }
      // make sure we can write to the file
      FS.chmod(node, mode | 146);
      var stream = FS.open(node, 577);
      FS.write(stream, data, 0, data.length, 0, canOwn);
      FS.close(stream);
      FS.chmod(node, mode);
    }
  },
  createDevice(parent, name, input, output) {
    var path = PATH.join2(typeof parent == "string" ? parent : FS.getPath(parent), name);
    var mode = FS_getMode(!!input, !!output);
    FS.createDevice.major ??= 64;
    var dev = FS.makedev(FS.createDevice.major++, 0);
    // Create a fake device that a set of stream ops to emulate
    // the old behavior.
    FS.registerDevice(dev, {
      open(stream) {
        stream.seekable = false;
      },
      close(stream) {
        // flush any pending line data
        if (output?.buffer?.length) {
          output(10);
        }
      },
      read(stream, buffer, offset, length, pos) {
        var bytesRead = 0;
        for (var i = 0; i < length; i++) {
          var result;
          try {
            result = input();
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
          if (result === undefined && bytesRead === 0) {
            throw new FS.ErrnoError(6);
          }
          if (result === null || result === undefined) break;
          bytesRead++;
          buffer[offset + i] = result;
        }
        if (bytesRead) {
          stream.node.atime = Date.now();
        }
        return bytesRead;
      },
      write(stream, buffer, offset, length, pos) {
        for (var i = 0; i < length; i++) {
          try {
            output(buffer[offset + i]);
          } catch (e) {
            throw new FS.ErrnoError(29);
          }
        }
        if (length) {
          stream.node.mtime = stream.node.ctime = Date.now();
        }
        return i;
      }
    });
    return FS.mkdev(path, mode, dev);
  },
  forceLoadFile(obj) {
    if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
    if (globalThis.XMLHttpRequest) {
      abort("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
    } else {
      // Command-line.
      try {
        obj.contents = readBinary(obj.url);
      } catch (e) {
        throw new FS.ErrnoError(29);
      }
    }
  },
  createLazyFile(parent, name, url, canRead, canWrite) {
    // Lazy chunked Uint8Array (implements get and length from Uint8Array).
    // Actual getting is abstracted away for eventual reuse.
    class LazyUint8Array {
      lengthKnown=false;
      chunks=[];
      // Loaded chunks. Index is the chunk number
      get(idx) {
        if (idx > this.length - 1 || idx < 0) {
          return undefined;
        }
        var chunkOffset = idx % this.chunkSize;
        var chunkNum = (idx / this.chunkSize) | 0;
        return this.getter(chunkNum)[chunkOffset];
      }
      setDataGetter(getter) {
        this.getter = getter;
      }
      cacheLength() {
        // Find length
        var xhr = new XMLHttpRequest;
        xhr.open("HEAD", url, false);
        xhr.send(null);
        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
        var datalength = Number(xhr.getResponseHeader("Content-length"));
        var header;
        var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
        var usesGzip = (header = xhr.getResponseHeader("Content-Encoding")) && header === "gzip";
        var chunkSize = 1024 * 1024;
        // Chunk size in bytes
        if (!hasByteServing) chunkSize = datalength;
        // Function to get a range from the remote URL.
        var doXHR = (from, to) => {
          if (from > to) abort("invalid range (" + from + ", " + to + ") or no bytes requested!");
          if (to > datalength - 1) abort("only " + datalength + " bytes available! programmer error!");
          // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
          var xhr = new XMLHttpRequest;
          xhr.open("GET", url, false);
          if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);
          // Some hints to the browser that we want binary data.
          xhr.responseType = "arraybuffer";
          if (xhr.overrideMimeType) {
            xhr.overrideMimeType("text/plain; charset=x-user-defined");
          }
          xhr.send(null);
          if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) abort("Couldn't load " + url + ". Status: " + xhr.status);
          if (xhr.response !== undefined) {
            return new Uint8Array(/** @type{Array<number>} */ (xhr.response || []));
          }
          return intArrayFromString(xhr.responseText || "", true);
        };
        var lazyArray = this;
        lazyArray.setDataGetter(chunkNum => {
          var start = chunkNum * chunkSize;
          var end = (chunkNum + 1) * chunkSize - 1;
          // including this byte
          end = Math.min(end, datalength - 1);
          // if datalength-1 is selected, this is the last block
          if (typeof lazyArray.chunks[chunkNum] == "undefined") {
            lazyArray.chunks[chunkNum] = doXHR(start, end);
          }
          if (typeof lazyArray.chunks[chunkNum] == "undefined") abort("doXHR failed!");
          return lazyArray.chunks[chunkNum];
        });
        if (usesGzip || !datalength) {
          // if the server uses gzip or doesn't supply the length, we have to download the whole file to get the (uncompressed) length
          chunkSize = datalength = 1;
          // this will force getter(0)/doXHR do download the whole file
          datalength = this.getter(0).length;
          chunkSize = datalength;
          out("LazyFiles on gzip forces download of the whole file when length is accessed");
        }
        this._length = datalength;
        this._chunkSize = chunkSize;
        this.lengthKnown = true;
      }
      get length() {
        if (!this.lengthKnown) {
          this.cacheLength();
        }
        return this._length;
      }
      get chunkSize() {
        if (!this.lengthKnown) {
          this.cacheLength();
        }
        return this._chunkSize;
      }
    }
    if (globalThis.XMLHttpRequest) {
      if (!ENVIRONMENT_IS_WORKER) abort("Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc");
      var lazyArray = new LazyUint8Array;
      var properties = {
        isDevice: false,
        contents: lazyArray
      };
    } else {
      var properties = {
        isDevice: false,
        url
      };
    }
    var node = FS.createFile(parent, name, properties, canRead, canWrite);
    // This is a total hack, but I want to get this lazy file code out of the
    // core of MEMFS. If we want to keep this lazy file concept I feel it should
    // be its own thin LAZYFS proxying calls to MEMFS.
    if (properties.contents) {
      node.contents = properties.contents;
    } else if (properties.url) {
      node.contents = null;
      node.url = properties.url;
    }
    // Add a function that defers querying the file size until it is asked the first time.
    Object.defineProperties(node, {
      usedBytes: {
        get: function() {
          return this.contents.length;
        }
      }
    });
    // override each stream op with one that tries to force load the lazy file first
    var stream_ops = {};
    for (const [key, fn] of Object.entries(node.stream_ops)) {
      stream_ops[key] = (...args) => {
        FS.forceLoadFile(node);
        return fn(...args);
      };
    }
    function writeChunks(stream, buffer, offset, length, position) {
      var contents = stream.node.contents;
      if (position >= contents.length) return 0;
      var size = Math.min(contents.length - position, length);
      assert(size >= 0);
      if (contents.slice) {
        // normal array
        for (var i = 0; i < size; i++) {
          buffer[offset + i] = contents[position + i];
        }
      } else {
        for (var i = 0; i < size; i++) {
          // LazyUint8Array from sync binary XHR
          buffer[offset + i] = contents.get(position + i);
        }
      }
      return size;
    }
    // use a custom read function
    stream_ops.read = (stream, buffer, offset, length, position) => {
      FS.forceLoadFile(node);
      return writeChunks(stream, buffer, offset, length, position);
    };
    // use a custom mmap function
    stream_ops.mmap = (stream, length, position, prot, flags) => {
      FS.forceLoadFile(node);
      var ptr = mmapAlloc(length);
      if (!ptr) {
        throw new FS.ErrnoError(48);
      }
      writeChunks(stream, HEAP8, ptr, length, position);
      return {
        ptr,
        allocated: true
      };
    };
    node.stream_ops = stream_ops;
    return node;
  },
  absolutePath() {
    abort("FS.absolutePath has been removed; use PATH_FS.resolve instead");
  },
  createFolder() {
    abort("FS.createFolder has been removed; use FS.mkdir instead");
  },
  createLink() {
    abort("FS.createLink has been removed; use FS.symlink instead");
  },
  joinPath() {
    abort("FS.joinPath has been removed; use PATH.join instead");
  },
  mmapAlloc() {
    abort("FS.mmapAlloc has been replaced by the top level function mmapAlloc");
  },
  standardizePath() {
    abort("FS.standardizePath has been removed; use PATH.normalize instead");
  }
};

var SYSCALLS = {
  calculateAt(dirfd, path, allowEmpty) {
    if (PATH.isAbs(path)) {
      return path;
    }
    // relative path
    var dir;
    if (dirfd === -100) {
      dir = FS.cwd();
    } else {
      var dirstream = SYSCALLS.getStreamFromFD(dirfd);
      dir = dirstream.path;
    }
    if (path.length == 0) {
      if (!allowEmpty) {
        throw new FS.ErrnoError(44);
      }
      return dir;
    }
    return dir + "/" + path;
  },
  writeStat(buf, stat) {
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((buf) >> 2), "storing")] = stat.dev;
    checkInt32(stat.dev);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (4)) >> 2), "storing")] = stat.mode;
    checkInt32(stat.mode);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (8)) >> 2), "storing")] = stat.nlink;
    checkInt32(stat.nlink);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (12)) >> 2), "storing")] = stat.uid;
    checkInt32(stat.uid);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (16)) >> 2), "storing")] = stat.gid;
    checkInt32(stat.gid);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (20)) >> 2), "storing")] = stat.rdev;
    checkInt32(stat.rdev);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (24)) >> 3), "storing")] = BigInt(stat.size);
    checkInt64(stat.size);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((buf) + (32)) >> 2), "storing")] = 4096;
    checkInt32(4096);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((buf) + (36)) >> 2), "storing")] = stat.blocks;
    checkInt32(stat.blocks);
    var atime = stat.atime.getTime();
    var mtime = stat.mtime.getTime();
    var ctime = stat.ctime.getTime();
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (40)) >> 3), "storing")] = BigInt(Math.floor(atime / 1e3));
    checkInt64(Math.floor(atime / 1e3));
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (48)) >> 2), "storing")] = (atime % 1e3) * 1e3 * 1e3;
    checkInt32((atime % 1e3) * 1e3 * 1e3);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (56)) >> 3), "storing")] = BigInt(Math.floor(mtime / 1e3));
    checkInt64(Math.floor(mtime / 1e3));
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (64)) >> 2), "storing")] = (mtime % 1e3) * 1e3 * 1e3;
    checkInt32((mtime % 1e3) * 1e3 * 1e3);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (72)) >> 3), "storing")] = BigInt(Math.floor(ctime / 1e3));
    checkInt64(Math.floor(ctime / 1e3));
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (80)) >> 2), "storing")] = (ctime % 1e3) * 1e3 * 1e3;
    checkInt32((ctime % 1e3) * 1e3 * 1e3);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (88)) >> 3), "storing")] = BigInt(stat.ino);
    checkInt64(stat.ino);
    return 0;
  },
  writeStatFs(buf, stats) {
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (4)) >> 2), "storing")] = stats.bsize;
    checkInt32(stats.bsize);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (60)) >> 2), "storing")] = stats.bsize;
    checkInt32(stats.bsize);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (8)) >> 3), "storing")] = BigInt(stats.blocks);
    checkInt64(stats.blocks);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (16)) >> 3), "storing")] = BigInt(stats.bfree);
    checkInt64(stats.bfree);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (24)) >> 3), "storing")] = BigInt(stats.bavail);
    checkInt64(stats.bavail);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (32)) >> 3), "storing")] = BigInt(stats.files);
    checkInt64(stats.files);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, (((buf) + (40)) >> 3), "storing")] = BigInt(stats.ffree);
    checkInt64(stats.ffree);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (48)) >> 2), "storing")] = stats.fsid;
    checkInt32(stats.fsid);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (64)) >> 2), "storing")] = stats.flags;
    checkInt32(stats.flags);
    // ST_NOSUID
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((buf) + (56)) >> 2), "storing")] = stats.namelen;
    checkInt32(stats.namelen);
  },
  doMsync(addr, stream, len, flags, offset) {
    if (!FS.isFile(stream.node.mode)) {
      throw new FS.ErrnoError(43);
    }
    if (flags & 2) {
      // MAP_PRIVATE calls need not to be synced back to underlying fs
      return 0;
    }
    var buffer = HEAPU8.slice(addr, addr + len);
    FS.msync(stream, buffer, offset, len, flags);
  },
  getStreamFromFD(fd) {
    var stream = FS.getStreamChecked(fd);
    return stream;
  },
  varargs: undefined,
  getStr(ptr) {
    var ret = UTF8ToString(ptr);
    return ret;
  }
};

function ___syscall_fcntl64(fd, cmd, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    switch (cmd) {
     case 0:
      {
        var arg = syscallGetVarargI();
        if (arg < 0) {
          return -28;
        }
        while (FS.streams[arg]) {
          arg++;
        }
        var newStream;
        newStream = FS.dupStream(stream, arg);
        return newStream.fd;
      }

     case 1:
     case 2:
      return 0;

     // FD_CLOEXEC makes no sense for a single process.
      case 3:
      return stream.flags;

     case 4:
      {
        var arg = syscallGetVarargI();
        stream.flags |= arg;
        return 0;
      }

     case 12:
      {
        var arg = syscallGetVarargP();
        var offset = 0;
        // We're always unlocked.
        HEAP16[SAFE_HEAP_INDEX(HEAP16, (((arg) + (offset)) >> 1), "storing")] = 2;
        checkInt16(2);
        return 0;
      }

     case 13:
     case 14:
      // Pretend that the locking is successful. These are process-level locks,
      // and Emscripten programs are a single process. If we supported linking a
      // filesystem between programs, we'd need to do more here.
      // See https://github.com/emscripten-core/emscripten/issues/23697
      return 0;
    }
    return -28;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_fstat64(fd, buf) {
  try {
    return SYSCALLS.writeStat(buf, FS.fstat(fd));
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

var INT53_MAX = 9007199254740992;

var INT53_MIN = -9007199254740992;

var bigintToI53Checked = num => (num < INT53_MIN || num > INT53_MAX) ? NaN : Number(num);

function ___syscall_ftruncate64(fd, length) {
  length = bigintToI53Checked(length);
  try {
    if (isNaN(length)) return -61;
    FS.ftruncate(fd, length);
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => {
  assert(typeof maxBytesToWrite == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
  return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
};

function ___syscall_getdents64(fd, dirp, count) {
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    stream.getdents ||= FS.readdir(stream.path);
    var struct_size = 280;
    var pos = 0;
    var off = FS.llseek(stream, 0, 1);
    var startIdx = Math.floor(off / struct_size);
    var endIdx = Math.min(stream.getdents.length, startIdx + Math.floor(count / struct_size));
    for (var idx = startIdx; idx < endIdx; idx++) {
      var id;
      var type;
      var name = stream.getdents[idx];
      if (name === ".") {
        id = stream.node.id;
        type = 4;
      } else if (name === "..") {
        var lookup = FS.lookupPath(stream.path, {
          parent: true
        });
        id = lookup.node.id;
        type = 4;
      } else {
        var child;
        try {
          child = FS.lookupNode(stream.node, name);
        } catch (e) {
          // If the entry is not a directory, file, or symlink, nodefs
          // lookupNode will raise EINVAL. Skip these and continue.
          if (e?.errno === 28) {
            continue;
          }
          throw e;
        }
        id = child.id;
        type = FS.isChrdev(child.mode) ? 2 : // character device.
        FS.isDir(child.mode) ? 4 : // directory
        FS.isLink(child.mode) ? 10 : // symbolic link.
        8;
      }
      assert(id);
      HEAP64[SAFE_HEAP_INDEX(HEAP64, ((dirp + pos) >> 3), "storing")] = BigInt(id);
      checkInt64(id);
      HEAP64[SAFE_HEAP_INDEX(HEAP64, (((dirp + pos) + (8)) >> 3), "storing")] = BigInt((idx + 1) * struct_size);
      checkInt64((idx + 1) * struct_size);
      HEAP16[SAFE_HEAP_INDEX(HEAP16, (((dirp + pos) + (16)) >> 1), "storing")] = 280;
      checkInt16(280);
      HEAP8[SAFE_HEAP_INDEX(HEAP8, (dirp + pos) + (18), "storing")] = type;
      checkInt8(type);
      stringToUTF8(name, dirp + pos + 19, 256);
      pos += struct_size;
    }
    FS.llseek(stream, idx * struct_size, 0);
    return pos;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_ioctl(fd, op, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    switch (op) {
     case 21509:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     case 21505:
      {
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tcgets) {
          var termios = stream.tty.ops.ioctl_tcgets(stream);
          var argp = syscallGetVarargP();
          HEAP32[SAFE_HEAP_INDEX(HEAP32, ((argp) >> 2), "storing")] = termios.c_iflag || 0;
          checkInt32(termios.c_iflag || 0);
          HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (4)) >> 2), "storing")] = termios.c_oflag || 0;
          checkInt32(termios.c_oflag || 0);
          HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (8)) >> 2), "storing")] = termios.c_cflag || 0;
          checkInt32(termios.c_cflag || 0);
          HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (12)) >> 2), "storing")] = termios.c_lflag || 0;
          checkInt32(termios.c_lflag || 0);
          for (var i = 0; i < 32; i++) {
            HEAP8[SAFE_HEAP_INDEX(HEAP8, (argp + i) + (17), "storing")] = termios.c_cc[i] || 0;
            checkInt8(termios.c_cc[i] || 0);
          }
          return 0;
        }
        return 0;
      }

     case 21510:
     case 21511:
     case 21512:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     case 21506:
     case 21507:
     case 21508:
      {
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tcsets) {
          var argp = syscallGetVarargP();
          var c_iflag = HEAP32[SAFE_HEAP_INDEX(HEAP32, ((argp) >> 2), "loading")];
          var c_oflag = HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (4)) >> 2), "loading")];
          var c_cflag = HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (8)) >> 2), "loading")];
          var c_lflag = HEAP32[SAFE_HEAP_INDEX(HEAP32, (((argp) + (12)) >> 2), "loading")];
          var c_cc = [];
          for (var i = 0; i < 32; i++) {
            c_cc.push(HEAP8[SAFE_HEAP_INDEX(HEAP8, (argp + i) + (17), "loading")]);
          }
          return stream.tty.ops.ioctl_tcsets(stream.tty, op, {
            c_iflag,
            c_oflag,
            c_cflag,
            c_lflag,
            c_cc
          });
        }
        return 0;
      }

     case 21519:
      {
        if (!stream.tty) return -59;
        var argp = syscallGetVarargP();
        HEAP32[SAFE_HEAP_INDEX(HEAP32, ((argp) >> 2), "storing")] = 0;
        checkInt32(0);
        return 0;
      }

     case 21520:
      {
        if (!stream.tty) return -59;
        return -28;
      }

     case 21537:
     case 21531:
      {
        var argp = syscallGetVarargP();
        return FS.ioctl(stream, op, argp);
      }

     case 21523:
      {
        // TODO: in theory we should write to the winsize struct that gets
        // passed in, but for now musl doesn't read anything on it
        if (!stream.tty) return -59;
        if (stream.tty.ops.ioctl_tiocgwinsz) {
          var winsize = stream.tty.ops.ioctl_tiocgwinsz(stream.tty);
          var argp = syscallGetVarargP();
          HEAP16[SAFE_HEAP_INDEX(HEAP16, ((argp) >> 1), "storing")] = winsize[0];
          checkInt16(winsize[0]);
          HEAP16[SAFE_HEAP_INDEX(HEAP16, (((argp) + (2)) >> 1), "storing")] = winsize[1];
          checkInt16(winsize[1]);
        }
        return 0;
      }

     case 21524:
      {
        // TODO: technically, this ioctl call should change the window size.
        // but, since emscripten doesn't have any concept of a terminal window
        // yet, we'll just silently throw it away as we do TIOCGWINSZ
        if (!stream.tty) return -59;
        return 0;
      }

     case 21515:
      {
        if (!stream.tty) return -59;
        return 0;
      }

     default:
      return -28;
    }
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_lstat64(path, buf) {
  try {
    path = SYSCALLS.getStr(path);
    return SYSCALLS.writeStat(buf, FS.lstat(path));
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_mkdirat(dirfd, path, mode) {
  try {
    path = SYSCALLS.getStr(path);
    path = SYSCALLS.calculateAt(dirfd, path);
    FS.mkdir(path, mode, 0);
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_newfstatat(dirfd, path, buf, flags) {
  try {
    path = SYSCALLS.getStr(path);
    var nofollow = flags & 256;
    var allowEmpty = flags & 4096;
    flags = flags & (~6400);
    assert(!flags, `unknown flags in __syscall_newfstatat: ${flags}`);
    path = SYSCALLS.calculateAt(dirfd, path, allowEmpty);
    return SYSCALLS.writeStat(buf, nofollow ? FS.lstat(path) : FS.stat(path));
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_openat(dirfd, path, flags, varargs) {
  SYSCALLS.varargs = varargs;
  try {
    path = SYSCALLS.getStr(path);
    path = SYSCALLS.calculateAt(dirfd, path);
    var mode = varargs ? syscallGetVarargI() : 0;
    return FS.open(path, flags, mode).fd;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

function ___syscall_stat64(path, buf) {
  try {
    path = SYSCALLS.getStr(path);
    return SYSCALLS.writeStat(buf, FS.stat(path));
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return -e.errno;
  }
}

var __abort_js = () => abort("native code called abort()");

var AsciiToString = ptr => {
  var str = "";
  while (1) {
    var ch = HEAPU8[SAFE_HEAP_INDEX(HEAPU8, ptr++, "loading")];
    if (!ch) return str;
    str += String.fromCharCode(ch);
  }
};

var awaitingDependencies = {};

var registeredTypes = {};

var typeDependencies = {};

var BindingError = class BindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "BindingError";
  }
};

var throwBindingError = message => {
  throw new BindingError(message);
};

/** @param {Object=} options */ function sharedRegisterType(rawType, registeredInstance, options = {}) {
  var name = registeredInstance.name;
  if (!rawType) {
    throwBindingError(`type "${name}" must have a positive integer typeid pointer`);
  }
  if (registeredTypes.hasOwnProperty(rawType)) {
    if (options.ignoreDuplicateRegistrations) {
      return;
    } else {
      throwBindingError(`Cannot register type '${name}' twice`);
    }
  }
  registeredTypes[rawType] = registeredInstance;
  delete typeDependencies[rawType];
  if (awaitingDependencies.hasOwnProperty(rawType)) {
    var callbacks = awaitingDependencies[rawType];
    delete awaitingDependencies[rawType];
    callbacks.forEach(cb => cb());
  }
}

/** @param {Object=} options */ function registerType(rawType, registeredInstance, options = {}) {
  return sharedRegisterType(rawType, registeredInstance, options);
}

var integerReadValueFromPointer = (name, width, signed) => {
  // integers are quite common, so generate very specialized functions
  switch (width) {
   case 1:
    return signed ? pointer => HEAP8[SAFE_HEAP_INDEX(HEAP8, pointer, "loading")] : pointer => HEAPU8[SAFE_HEAP_INDEX(HEAPU8, pointer, "loading")];

   case 2:
    return signed ? pointer => HEAP16[SAFE_HEAP_INDEX(HEAP16, ((pointer) >> 1), "loading")] : pointer => HEAPU16[SAFE_HEAP_INDEX(HEAPU16, ((pointer) >> 1), "loading")];

   case 4:
    return signed ? pointer => HEAP32[SAFE_HEAP_INDEX(HEAP32, ((pointer) >> 2), "loading")] : pointer => HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((pointer) >> 2), "loading")];

   case 8:
    return signed ? pointer => HEAP64[SAFE_HEAP_INDEX(HEAP64, ((pointer) >> 3), "loading")] : pointer => HEAPU64[SAFE_HEAP_INDEX(HEAPU64, ((pointer) >> 3), "loading")];

   default:
    throw new TypeError(`invalid integer width (${width}): ${name}`);
  }
};

var embindRepr = v => {
  if (v === null) {
    return "null";
  }
  var t = typeof v;
  if (t === "object" || t === "array" || t === "function") {
    return v.toString();
  } else {
    return "" + v;
  }
};

var assertIntegerRange = (typeName, value, minRange, maxRange) => {
  if (value < minRange || value > maxRange) {
    throw new TypeError(`Passing a number "${embindRepr(value)}" from JS side to C/C++ side to an argument of type "${typeName}", which is outside the valid range [${minRange}, ${maxRange}]!`);
  }
};

/** @suppress {globalThis} */ var __embind_register_bigint = (primitiveType, name, size, minRange, maxRange) => {
  name = AsciiToString(name);
  const isUnsignedType = minRange === 0n;
  let fromWireType = value => value;
  if (isUnsignedType) {
    // uint64 get converted to int64 in ABI, fix them up like we do for 32-bit integers.
    const bitSize = size * 8;
    fromWireType = value => BigInt.asUintN(bitSize, value);
    maxRange = fromWireType(maxRange);
  }
  registerType(primitiveType, {
    name,
    fromWireType,
    toWireType: (destructors, value) => {
      if (typeof value == "number") {
        value = BigInt(value);
      } else if (typeof value != "bigint") {
        throw new TypeError(`Cannot convert "${embindRepr(value)}" to ${this.name}`);
      }
      assertIntegerRange(name, value, minRange, maxRange);
      return value;
    },
    readValueFromPointer: integerReadValueFromPointer(name, size, !isUnsignedType),
    destructorFunction: null
  });
};

/** @suppress {globalThis} */ var __embind_register_bool = (rawType, name, trueValue, falseValue) => {
  name = AsciiToString(name);
  registerType(rawType, {
    name,
    fromWireType: function(wt) {
      // ambiguous emscripten ABI: sometimes return values are
      // true or false, and sometimes integers (0 or 1)
      return !!wt;
    },
    toWireType: function(destructors, o) {
      return o ? trueValue : falseValue;
    },
    readValueFromPointer: function(pointer) {
      return this.fromWireType(HEAPU8[SAFE_HEAP_INDEX(HEAPU8, pointer, "loading")]);
    },
    destructorFunction: null
  });
};

var emval_freelist = [];

var emval_handles = [ 0, 1, , 1, null, 1, true, 1, false, 1 ];

var __emval_decref = handle => {
  if (handle > 9 && 0 === --emval_handles[handle + 1]) {
    assert(emval_handles[handle] !== undefined, `Decref for unallocated handle.`);
    emval_handles[handle] = undefined;
    emval_freelist.push(handle);
  }
};

var Emval = {
  toValue: handle => {
    if (!handle) {
      throwBindingError(`Cannot use deleted val. handle = ${handle}`);
    }
    // handle 2 is supposed to be `undefined`.
    assert(handle === 2 || emval_handles[handle] !== undefined && handle % 2 === 0, `invalid handle: ${handle}`);
    return emval_handles[handle];
  },
  toHandle: value => {
    switch (value) {
     case undefined:
      return 2;

     case null:
      return 4;

     case true:
      return 6;

     case false:
      return 8;

     default:
      {
        const handle = emval_freelist.pop() || emval_handles.length;
        emval_handles[handle] = value;
        emval_handles[handle + 1] = 1;
        return handle;
      }
    }
  }
};

/** @suppress {globalThis} */ function readPointer(pointer) {
  return this.fromWireType(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((pointer) >> 2), "loading")]);
}

var EmValType = {
  name: "emscripten::val",
  fromWireType: handle => {
    var rv = Emval.toValue(handle);
    __emval_decref(handle);
    return rv;
  },
  toWireType: (destructors, value) => Emval.toHandle(value),
  readValueFromPointer: readPointer,
  destructorFunction: null
};

var __embind_register_emval = rawType => registerType(rawType, EmValType);

var floatReadValueFromPointer = (name, width) => {
  switch (width) {
   case 4:
    return function(pointer) {
      return this.fromWireType(HEAPF32[SAFE_HEAP_INDEX(HEAPF32, ((pointer) >> 2), "loading")]);
    };

   case 8:
    return function(pointer) {
      return this.fromWireType(HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((pointer) >> 3), "loading")]);
    };

   default:
    throw new TypeError(`invalid float width (${width}): ${name}`);
  }
};

var __embind_register_float = (rawType, name, size) => {
  name = AsciiToString(name);
  registerType(rawType, {
    name,
    fromWireType: value => value,
    toWireType: (destructors, value) => {
      if (typeof value != "number" && typeof value != "boolean") {
        throw new TypeError(`Cannot convert ${embindRepr(value)} to ${this.name}`);
      }
      // The VM will perform JS to Wasm value conversion, according to the spec:
      // https://www.w3.org/TR/wasm-js-api-1/#towebassemblyvalue
      return value;
    },
    readValueFromPointer: floatReadValueFromPointer(name, size),
    destructorFunction: null
  });
};

/** @suppress {globalThis} */ var __embind_register_integer = (primitiveType, name, size, minRange, maxRange) => {
  name = AsciiToString(name);
  const isUnsignedType = minRange === 0;
  let fromWireType = value => value;
  if (isUnsignedType) {
    var bitshift = 32 - 8 * size;
    fromWireType = value => (value << bitshift) >>> bitshift;
    maxRange = fromWireType(maxRange);
  }
  registerType(primitiveType, {
    name,
    fromWireType,
    toWireType: (destructors, value) => {
      if (typeof value != "number" && typeof value != "boolean") {
        throw new TypeError(`Cannot convert "${embindRepr(value)}" to ${name}`);
      }
      assertIntegerRange(name, value, minRange, maxRange);
      // The VM will perform JS to Wasm value conversion, according to the spec:
      // https://www.w3.org/TR/wasm-js-api-1/#towebassemblyvalue
      return value;
    },
    readValueFromPointer: integerReadValueFromPointer(name, size, minRange !== 0),
    destructorFunction: null
  });
};

var __embind_register_memory_view = (rawType, dataTypeIndex, name) => {
  var typeMapping = [ Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array ];
  var TA = typeMapping[dataTypeIndex];
  function decodeMemoryView(handle) {
    var size = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((handle) >> 2), "loading")];
    var data = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((handle) + (4)) >> 2), "loading")];
    return new TA(HEAP8.buffer, data, size);
  }
  name = AsciiToString(name);
  registerType(rawType, {
    name,
    fromWireType: decodeMemoryView,
    readValueFromPointer: decodeMemoryView
  }, {
    ignoreDuplicateRegistrations: true
  });
};

var __embind_register_std_string = (rawType, name) => {
  name = AsciiToString(name);
  var stdStringIsUTF8 = true;
  registerType(rawType, {
    name,
    // For some method names we use string keys here since they are part of
    // the public/external API and/or used by the runtime-generated code.
    fromWireType(value) {
      var length = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((value) >> 2), "loading")];
      var payload = value + 4;
      var str;
      if (stdStringIsUTF8) {
        str = UTF8ToString(payload, length, true);
      } else {
        str = "";
        for (var i = 0; i < length; ++i) {
          str += String.fromCharCode(HEAPU8[SAFE_HEAP_INDEX(HEAPU8, payload + i, "loading")]);
        }
      }
      _free(value);
      return str;
    },
    toWireType(destructors, value) {
      if (value instanceof ArrayBuffer) {
        value = new Uint8Array(value);
      }
      var length;
      var valueIsOfTypeString = (typeof value == "string");
      // We accept `string` or array views with single byte elements
      if (!(valueIsOfTypeString || (ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT == 1))) {
        throwBindingError("Cannot pass non-string to std::string");
      }
      if (stdStringIsUTF8 && valueIsOfTypeString) {
        length = lengthBytesUTF8(value);
      } else {
        length = value.length;
      }
      // assumes POINTER_SIZE alignment
      var base = _malloc(4 + length + 1);
      var ptr = base + 4;
      HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((base) >> 2), "storing")] = length;
      checkInt32(length);
      if (valueIsOfTypeString) {
        if (stdStringIsUTF8) {
          stringToUTF8(value, ptr, length + 1);
        } else {
          for (var i = 0; i < length; ++i) {
            var charCode = value.charCodeAt(i);
            if (charCode > 255) {
              _free(base);
              throwBindingError("String has UTF-16 code units that do not fit in 8 bits");
            }
            HEAPU8[SAFE_HEAP_INDEX(HEAPU8, ptr + i, "storing")] = charCode;
          }
        }
      } else {
        HEAPU8.set(value, ptr);
      }
      if (destructors !== null) {
        destructors.push(_free, base);
      }
      return base;
    },
    readValueFromPointer: readPointer,
    destructorFunction(ptr) {
      _free(ptr);
    }
  });
};

var UTF16Decoder = globalThis.TextDecoder ? new TextDecoder("utf-16le") : undefined;

var UTF16ToString = (ptr, maxBytesToRead, ignoreNul) => {
  assert(ptr % 2 == 0, "Pointer passed to UTF16ToString must be aligned to two bytes!");
  var idx = ((ptr) >> 1);
  var endIdx = findStringEnd(HEAPU16, idx, maxBytesToRead / 2, ignoreNul);
  // When using conditional TextDecoder, skip it for short strings as the overhead of the native call is not worth it.
  if (endIdx - idx > 16 && UTF16Decoder) return UTF16Decoder.decode(HEAPU16.subarray(idx, endIdx));
  // Fallback: decode without UTF16Decoder
  var str = "";
  // If maxBytesToRead is not passed explicitly, it will be undefined, and the
  // for-loop's condition will always evaluate to true. The loop is then
  // terminated on the first null char.
  for (var i = idx; i < endIdx; ++i) {
    var codeUnit = HEAPU16[SAFE_HEAP_INDEX(HEAPU16, i, "loading")];
    // fromCharCode constructs a character from a UTF-16 code unit, so we can
    // pass the UTF16 string right through.
    str += String.fromCharCode(codeUnit);
  }
  return str;
};

var stringToUTF16 = (str, outPtr, maxBytesToWrite) => {
  assert(outPtr % 2 == 0, "Pointer passed to stringToUTF16 must be aligned to two bytes!");
  assert(typeof maxBytesToWrite == "number", "stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  maxBytesToWrite ??= 2147483647;
  if (maxBytesToWrite < 2) return 0;
  maxBytesToWrite -= 2;
  // Null terminator.
  var startPtr = outPtr;
  var numCharsToWrite = (maxBytesToWrite < str.length * 2) ? (maxBytesToWrite / 2) : str.length;
  for (var i = 0; i < numCharsToWrite; ++i) {
    // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
    var codeUnit = str.charCodeAt(i);
    // possibly a lead surrogate
    HEAP16[SAFE_HEAP_INDEX(HEAP16, ((outPtr) >> 1), "storing")] = codeUnit;
    checkInt16(codeUnit);
    outPtr += 2;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP16[SAFE_HEAP_INDEX(HEAP16, ((outPtr) >> 1), "storing")] = 0;
  checkInt16(0);
  return outPtr - startPtr;
};

var lengthBytesUTF16 = str => str.length * 2;

var UTF32ToString = (ptr, maxBytesToRead, ignoreNul) => {
  assert(ptr % 4 == 0, "Pointer passed to UTF32ToString must be aligned to four bytes!");
  var str = "";
  var startIdx = ((ptr) >> 2);
  // If maxBytesToRead is not passed explicitly, it will be undefined, and this
  // will always evaluate to true. This saves on code size.
  for (var i = 0; !(i >= maxBytesToRead / 4); i++) {
    var utf32 = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, startIdx + i, "loading")];
    if (!utf32 && !ignoreNul) break;
    str += String.fromCodePoint(utf32);
  }
  return str;
};

var stringToUTF32 = (str, outPtr, maxBytesToWrite) => {
  assert(outPtr % 4 == 0, "Pointer passed to stringToUTF32 must be aligned to four bytes!");
  assert(typeof maxBytesToWrite == "number", "stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
  // Backwards compatibility: if max bytes is not specified, assume unsafe unbounded write is allowed.
  maxBytesToWrite ??= 2147483647;
  if (maxBytesToWrite < 4) return 0;
  var startPtr = outPtr;
  var endPtr = startPtr + maxBytesToWrite - 4;
  for (var i = 0; i < str.length; ++i) {
    var codePoint = str.codePointAt(i);
    // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
    // We need to manually skip over the second code unit for correct iteration.
    if (codePoint > 65535) {
      i++;
    }
    HEAP32[SAFE_HEAP_INDEX(HEAP32, ((outPtr) >> 2), "storing")] = codePoint;
    checkInt32(codePoint);
    outPtr += 4;
    if (outPtr + 4 > endPtr) break;
  }
  // Null-terminate the pointer to the HEAP.
  HEAP32[SAFE_HEAP_INDEX(HEAP32, ((outPtr) >> 2), "storing")] = 0;
  checkInt32(0);
  return outPtr - startPtr;
};

var lengthBytesUTF32 = str => {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    var codePoint = str.codePointAt(i);
    // Gotcha: if codePoint is over 0xFFFF, it is represented as a surrogate pair in UTF-16.
    // We need to manually skip over the second code unit for correct iteration.
    if (codePoint > 65535) {
      i++;
    }
    len += 4;
  }
  return len;
};

var __embind_register_std_wstring = (rawType, charSize, name) => {
  name = AsciiToString(name);
  var decodeString, encodeString, lengthBytesUTF;
  if (charSize === 2) {
    decodeString = UTF16ToString;
    encodeString = stringToUTF16;
    lengthBytesUTF = lengthBytesUTF16;
  } else {
    assert(charSize === 4, "only 2-byte and 4-byte strings are currently supported");
    decodeString = UTF32ToString;
    encodeString = stringToUTF32;
    lengthBytesUTF = lengthBytesUTF32;
  }
  registerType(rawType, {
    name,
    fromWireType: value => {
      // Code mostly taken from _embind_register_std_string fromWireType
      var length = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((value) >> 2), "loading")];
      var str = decodeString(value + 4, length * charSize, true);
      _free(value);
      return str;
    },
    toWireType: (destructors, value) => {
      if (!(typeof value == "string")) {
        throwBindingError(`Cannot pass non-string to C++ string type ${name}`);
      }
      // assumes POINTER_SIZE alignment
      var length = lengthBytesUTF(value);
      var ptr = _malloc(4 + length + charSize);
      HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "storing")] = length / charSize;
      checkInt32(length / charSize);
      encodeString(value, ptr + 4, length + charSize);
      if (destructors !== null) {
        destructors.push(_free, ptr);
      }
      return ptr;
    },
    readValueFromPointer: readPointer,
    destructorFunction(ptr) {
      _free(ptr);
    }
  });
};

var __embind_register_void = (rawType, name) => {
  name = AsciiToString(name);
  registerType(rawType, {
    isVoid: true,
    // void return values can be optimized out sometimes
    name,
    fromWireType: () => undefined,
    // TODO: assert if anything else is given?
    toWireType: (destructors, o) => undefined
  });
};

function __gmtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  var date = new Date(time * 1e3);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, ((tmPtr) >> 2), "storing")] = date.getUTCSeconds();
  checkInt32(date.getUTCSeconds());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (4)) >> 2), "storing")] = date.getUTCMinutes();
  checkInt32(date.getUTCMinutes());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (8)) >> 2), "storing")] = date.getUTCHours();
  checkInt32(date.getUTCHours());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (12)) >> 2), "storing")] = date.getUTCDate();
  checkInt32(date.getUTCDate());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (16)) >> 2), "storing")] = date.getUTCMonth();
  checkInt32(date.getUTCMonth());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (20)) >> 2), "storing")] = date.getUTCFullYear() - 1900;
  checkInt32(date.getUTCFullYear() - 1900);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (24)) >> 2), "storing")] = date.getUTCDay();
  checkInt32(date.getUTCDay());
  var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (28)) >> 2), "storing")] = yday;
  checkInt32(yday);
}

var isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

var MONTH_DAYS_LEAP_CUMULATIVE = [ 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335 ];

var MONTH_DAYS_REGULAR_CUMULATIVE = [ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 ];

var ydayFromDate = date => {
  var leap = isLeapYear(date.getFullYear());
  var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
  var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
  // -1 since it's days since Jan 1
  return yday;
};

function __localtime_js(time, tmPtr) {
  time = bigintToI53Checked(time);
  var date = new Date(time * 1e3);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, ((tmPtr) >> 2), "storing")] = date.getSeconds();
  checkInt32(date.getSeconds());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (4)) >> 2), "storing")] = date.getMinutes();
  checkInt32(date.getMinutes());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (8)) >> 2), "storing")] = date.getHours();
  checkInt32(date.getHours());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (12)) >> 2), "storing")] = date.getDate();
  checkInt32(date.getDate());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (16)) >> 2), "storing")] = date.getMonth();
  checkInt32(date.getMonth());
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (20)) >> 2), "storing")] = date.getFullYear() - 1900;
  checkInt32(date.getFullYear() - 1900);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (24)) >> 2), "storing")] = date.getDay();
  checkInt32(date.getDay());
  var yday = ydayFromDate(date) | 0;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (28)) >> 2), "storing")] = yday;
  checkInt32(yday);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (36)) >> 2), "storing")] = -(date.getTimezoneOffset() * 60);
  checkInt32(-(date.getTimezoneOffset() * 60));
  // Attention: DST is in December in South, and some regions don't have DST at all.
  var start = new Date(date.getFullYear(), 0, 1);
  var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  var winterOffset = start.getTimezoneOffset();
  var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (32)) >> 2), "storing")] = dst;
  checkInt32(dst);
}

var __mktime_js = function(tmPtr) {
  var ret = (() => {
    var date = new Date(HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (20)) >> 2), "loading")] + 1900, HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (16)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (12)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (8)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (4)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, ((tmPtr) >> 2), "loading")], 0);
    // There's an ambiguous hour when the time goes back; the tm_isdst field is
    // used to disambiguate it.  Date() basically guesses, so we fix it up if it
    // guessed wrong, or fill in tm_isdst with the guess if it's -1.
    var dst = HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (32)) >> 2), "loading")];
    var guessedOffset = date.getTimezoneOffset();
    var start = new Date(date.getFullYear(), 0, 1);
    var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
    var winterOffset = start.getTimezoneOffset();
    var dstOffset = Math.min(winterOffset, summerOffset);
    // DST is in December in South
    if (dst < 0) {
      // Attention: some regions don't have DST at all.
      HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (32)) >> 2), "storing")] = Number(summerOffset != winterOffset && dstOffset == guessedOffset);
      checkInt32(Number(summerOffset != winterOffset && dstOffset == guessedOffset));
    } else if ((dst > 0) != (dstOffset == guessedOffset)) {
      var nonDstOffset = Math.max(winterOffset, summerOffset);
      var trueOffset = dst > 0 ? dstOffset : nonDstOffset;
      // Don't try setMinutes(date.getMinutes() + ...) -- it's messed up.
      date.setTime(date.getTime() + (trueOffset - guessedOffset) * 6e4);
    }
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (24)) >> 2), "storing")] = date.getDay();
    checkInt32(date.getDay());
    var yday = ydayFromDate(date) | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (28)) >> 2), "storing")] = yday;
    checkInt32(yday);
    // To match expected behavior, update fields from date
    HEAP32[SAFE_HEAP_INDEX(HEAP32, ((tmPtr) >> 2), "storing")] = date.getSeconds();
    checkInt32(date.getSeconds());
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (4)) >> 2), "storing")] = date.getMinutes();
    checkInt32(date.getMinutes());
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (8)) >> 2), "storing")] = date.getHours();
    checkInt32(date.getHours());
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (12)) >> 2), "storing")] = date.getDate();
    checkInt32(date.getDate());
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (16)) >> 2), "storing")] = date.getMonth();
    checkInt32(date.getMonth());
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (20)) >> 2), "storing")] = date.getYear();
    checkInt32(date.getYear());
    var timeMs = date.getTime();
    if (isNaN(timeMs)) {
      return -1;
    }
    // Return time in microseconds
    return timeMs / 1e3;
  })();
  return BigInt(ret);
};

var __timegm_js = function(tmPtr) {
  var ret = (() => {
    var time = Date.UTC(HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (20)) >> 2), "loading")] + 1900, HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (16)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (12)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (8)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (4)) >> 2), "loading")], HEAP32[SAFE_HEAP_INDEX(HEAP32, ((tmPtr) >> 2), "loading")], 0);
    var date = new Date(time);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (24)) >> 2), "storing")] = date.getUTCDay();
    checkInt32(date.getUTCDay());
    var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
    var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((tmPtr) + (28)) >> 2), "storing")] = yday;
    checkInt32(yday);
    return date.getTime() / 1e3;
  })();
  return BigInt(ret);
};

var __tzset_js = (timezone, daylight, std_name, dst_name) => {
  // TODO: Use (malleable) environment variables instead of system settings.
  var currentYear = (new Date).getFullYear();
  var winter = new Date(currentYear, 0, 1);
  var summer = new Date(currentYear, 6, 1);
  var winterOffset = winter.getTimezoneOffset();
  var summerOffset = summer.getTimezoneOffset();
  // Local standard timezone offset. Local standard time is not adjusted for
  // daylight savings.  This code uses the fact that getTimezoneOffset returns
  // a greater value during Standard Time versus Daylight Saving Time (DST).
  // Thus it determines the expected output during Standard Time, and it
  // compares whether the output of the given date the same (Standard) or less
  // (DST).
  var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
  // timezone is specified as seconds west of UTC ("The external variable
  // `timezone` shall be set to the difference, in seconds, between
  // Coordinated Universal Time (UTC) and local standard time."), the same
  // as returned by stdTimezoneOffset.
  // See http://pubs.opengroup.org/onlinepubs/009695399/functions/tzset.html
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((timezone) >> 2), "storing")] = stdTimezoneOffset * 60;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, ((daylight) >> 2), "storing")] = Number(winterOffset != summerOffset);
  checkInt32(Number(winterOffset != summerOffset));
  var extractZone = timezoneOffset => {
    // Why inverse sign?
    // Read here https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getTimezoneOffset
    var sign = timezoneOffset >= 0 ? "-" : "+";
    var absOffset = Math.abs(timezoneOffset);
    var hours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    var minutes = String(absOffset % 60).padStart(2, "0");
    return `UTC${sign}${hours}${minutes}`;
  };
  var winterName = extractZone(winterOffset);
  var summerName = extractZone(summerOffset);
  assert(winterName);
  assert(summerName);
  assert(lengthBytesUTF8(winterName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${winterName})`);
  assert(lengthBytesUTF8(summerName) <= 16, `timezone name truncated to fit in TZNAME_MAX (${summerName})`);
  if (summerOffset < winterOffset) {
    // Northern hemisphere
    stringToUTF8(winterName, std_name, 17);
    stringToUTF8(summerName, dst_name, 17);
  } else {
    stringToUTF8(winterName, dst_name, 17);
    stringToUTF8(summerName, std_name, 17);
  }
};

var readEmAsmArgsArray = [];

var readEmAsmArgs = (sigPtr, buf) => {
  // Nobody should have mutated _readEmAsmArgsArray underneath us to be something else than an array.
  assert(Array.isArray(readEmAsmArgsArray));
  // The input buffer is allocated on the stack, so it must be stack-aligned.
  assert(buf % 16 == 0);
  readEmAsmArgsArray.length = 0;
  var ch;
  // Most arguments are i32s, so shift the buffer pointer so it is a plain
  // index into HEAP32.
  while (ch = HEAPU8[SAFE_HEAP_INDEX(HEAPU8, sigPtr++, "loading")]) {
    var chr = String.fromCharCode(ch);
    var validChars = [ "d", "f", "i", "p" ];
    // In WASM_BIGINT mode we support passing i64 values as bigint.
    validChars.push("j");
    assert(validChars.includes(chr), `Invalid character ${ch}("${chr}") in readEmAsmArgs! Use only [${validChars}], and do not specify "v" for void return argument.`);
    // Floats are always passed as doubles, so all types except for 'i'
    // are 8 bytes and require alignment.
    var wide = (ch != 105);
    wide &= (ch != 112);
    buf += wide && (buf % 8) ? 4 : 0;
    readEmAsmArgsArray.push(// Special case for pointers under wasm64 or CAN_ADDRESS_2GB mode.
    ch == 112 ? HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((buf) >> 2), "loading")] : ch == 106 ? HEAP64[SAFE_HEAP_INDEX(HEAP64, ((buf) >> 3), "loading")] : ch == 105 ? HEAP32[SAFE_HEAP_INDEX(HEAP32, ((buf) >> 2), "loading")] : HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((buf) >> 3), "loading")]);
    buf += wide ? 8 : 4;
  }
  return readEmAsmArgsArray;
};

var runEmAsmFunction = (code, sigPtr, argbuf) => {
  var args = readEmAsmArgs(sigPtr, argbuf);
  assert(ASM_CONSTS.hasOwnProperty(code), `No EM_ASM constant found at address ${code}.  The loaded WebAssembly file is likely out of sync with the generated JavaScript.`);
  return ASM_CONSTS[code](...args);
};

var _emscripten_asm_const_int = (code, sigPtr, argbuf) => runEmAsmFunction(code, sigPtr, argbuf);

var _emscripten_set_main_loop_timing = (mode, value) => {
  MainLoop.timingMode = mode;
  MainLoop.timingValue = value;
  if (!MainLoop.func) {
    err("emscripten_set_main_loop_timing: Cannot set timing mode for main loop since a main loop does not exist! Call emscripten_set_main_loop first to set one up.");
    return 1;
  }
  if (!MainLoop.running) {
    MainLoop.running = true;
  }
  if (mode == 0) {
    MainLoop.scheduler = function MainLoop_scheduler_setTimeout() {
      var timeUntilNextTick = Math.max(0, MainLoop.tickStartTime + value - _emscripten_get_now()) | 0;
      setTimeout(MainLoop.runner, timeUntilNextTick);
    };
  } else if (mode == 1) {
    MainLoop.scheduler = function MainLoop_scheduler_rAF() {
      MainLoop.requestAnimationFrame(MainLoop.runner);
    };
  } else {
    assert(mode == 2);
    if (!MainLoop.setImmediate) {
      if (globalThis.setImmediate) {
        MainLoop.setImmediate = setImmediate;
      } else {
        // Emulate setImmediate. (note: not a complete polyfill, we don't emulate clearImmediate() to keep code size to minimum, since not needed)
        var setImmediates = [];
        var emscriptenMainLoopMessageId = "setimmediate";
        /** @param {Event} event */ var MainLoop_setImmediate_messageHandler = event => {
          // When called in current thread or Worker, the main loop ID is structured slightly different to accommodate for --proxy-to-worker runtime listening to Worker events,
          // so check for both cases.
          if (event.data === emscriptenMainLoopMessageId || event.data.target === emscriptenMainLoopMessageId) {
            event.stopPropagation();
            setImmediates.shift()();
          }
        };
        addEventListener("message", MainLoop_setImmediate_messageHandler, true);
        MainLoop.setImmediate = /** @type{function(function(): ?, ...?): number} */ (func => {
          setImmediates.push(func);
          if (ENVIRONMENT_IS_WORKER) {
            Module["setImmediates"] ??= [];
            Module["setImmediates"].push(func);
            postMessage({
              target: emscriptenMainLoopMessageId
            });
          } else postMessage(emscriptenMainLoopMessageId, "*");
        });
      }
    }
    MainLoop.scheduler = function MainLoop_scheduler_setImmediate() {
      MainLoop.setImmediate(MainLoop.runner);
    };
  }
  return 0;
};

var _emscripten_get_now = () => performance.now();

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var _proc_exit = code => {
  EXITSTATUS = code;
  if (!keepRuntimeAlive()) {
    Module["onExit"]?.(code);
    ABORT = true;
  }
  quit_(code, new ExitStatus(code));
};

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
  EXITSTATUS = status;
  checkUnflushedContent();
  // if exit() was called explicitly, warn the user if the runtime isn't actually being shut down
  if (keepRuntimeAlive() && !implicit) {
    var msg = `program exited (with status: ${status}), but keepRuntimeAlive() is set (counter=${runtimeKeepaliveCounter}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
    err(msg);
  }
  _proc_exit(status);
};

var _exit = exitJS;

var handleException = e => {
  // Certain exception types we do not treat as errors since they are used for
  // internal control flow.
  // 1. ExitStatus, which is thrown by exit()
  // 2. "unwind", which is thrown by emscripten_unwind_to_js_event_loop() and others
  //    that wish to return to JS event loop.
  if (e instanceof ExitStatus || e == "unwind") {
    return EXITSTATUS;
  }
  checkStackCookie();
  if (e instanceof WebAssembly.RuntimeError) {
    if (_emscripten_stack_get_current() <= 0) {
      err("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 524288)");
    }
  }
  quit_(1, e);
};

var maybeExit = () => {
  if (!keepRuntimeAlive()) {
    try {
      _exit(EXITSTATUS);
    } catch (e) {
      handleException(e);
    }
  }
};

/**
   * @param {number=} arg
   * @param {boolean=} noSetTiming
   */ var setMainLoop = (iterFunc, fps, simulateInfiniteLoop, arg, noSetTiming) => {
  assert(!MainLoop.func, "emscripten_set_main_loop: there can only be one main loop function at once: call emscripten_cancel_main_loop to cancel the previous one before setting a new one with different parameters.");
  MainLoop.func = iterFunc;
  MainLoop.arg = arg;
  var thisMainLoopId = MainLoop.currentlyRunningMainloop;
  function checkIsRunning() {
    if (thisMainLoopId < MainLoop.currentlyRunningMainloop) {
      maybeExit();
      return false;
    }
    return true;
  }
  // We create the loop runner here but it is not actually running until
  // _emscripten_set_main_loop_timing is called (which might happen at a
  // later time).  This member signifies that the current runner has not
  // yet been started so that we can call runtimeKeepalivePush when it
  // gets its timing set for the first time.
  MainLoop.running = false;
  MainLoop.runner = function MainLoop_runner() {
    if (ABORT) return;
    if (MainLoop.queue.length > 0) {
      var start = Date.now();
      var blocker = MainLoop.queue.shift();
      blocker.func(blocker.arg);
      if (MainLoop.remainingBlockers) {
        var remaining = MainLoop.remainingBlockers;
        var next = remaining % 1 == 0 ? remaining - 1 : Math.floor(remaining);
        if (blocker.counted) {
          MainLoop.remainingBlockers = next;
        } else {
          // not counted, but move the progress along a tiny bit
          next = next + .5;
          // do not steal all the next one's progress
          MainLoop.remainingBlockers = (8 * remaining + next) / 9;
        }
      }
      MainLoop.updateStatus();
      // catches pause/resume main loop from blocker execution
      if (!checkIsRunning()) return;
      setTimeout(MainLoop.runner, 0);
      return;
    }
    // catch pauses from non-main loop sources
    if (!checkIsRunning()) return;
    // Implement very basic swap interval control
    MainLoop.currentFrameNumber = MainLoop.currentFrameNumber + 1 | 0;
    if (MainLoop.timingMode == 1 && MainLoop.timingValue > 1 && MainLoop.currentFrameNumber % MainLoop.timingValue != 0) {
      // Not the scheduled time to render this frame - skip.
      MainLoop.scheduler();
      return;
    } else if (MainLoop.timingMode == 0) {
      MainLoop.tickStartTime = _emscripten_get_now();
      if (Module["ctx"]) {
        warnOnce("Looks like you are rendering without using requestAnimationFrame for the main loop. You should use 0 for the frame rate in emscripten_set_main_loop in order to use requestAnimationFrame, as that can greatly improve your frame rates!");
      }
    }
    MainLoop.runIter(iterFunc);
    // catch pauses from the main loop itself
    if (!checkIsRunning()) return;
    MainLoop.scheduler();
  };
  if (!noSetTiming) {
    if (fps > 0) {
      _emscripten_set_main_loop_timing(0, 1e3 / fps);
    } else {
      // Do rAF by rendering each frame (no decimating)
      _emscripten_set_main_loop_timing(1, 1);
    }
    MainLoop.scheduler();
  }
  if (simulateInfiniteLoop) {
    throw "unwind";
  }
};

var callUserCallback = func => {
  if (ABORT) {
    err("user callback triggered after runtime exited or application aborted.  Ignoring.");
    return;
  }
  try {
    return func();
  } catch (e) {
    handleException(e);
  } finally {
    maybeExit();
  }
};

var MainLoop = {
  running: false,
  scheduler: null,
  currentlyRunningMainloop: 0,
  func: null,
  arg: 0,
  timingMode: 0,
  timingValue: 0,
  currentFrameNumber: 0,
  queue: [],
  preMainLoop: [],
  postMainLoop: [],
  pause() {
    MainLoop.scheduler = null;
    // Incrementing this signals the previous main loop that it's now become old, and it must return.
    MainLoop.currentlyRunningMainloop++;
  },
  resume() {
    MainLoop.currentlyRunningMainloop++;
    var timingMode = MainLoop.timingMode;
    var timingValue = MainLoop.timingValue;
    var func = MainLoop.func;
    MainLoop.func = null;
    // do not set timing and call scheduler, we will do it on the next lines
    setMainLoop(func, 0, false, MainLoop.arg, true);
    _emscripten_set_main_loop_timing(timingMode, timingValue);
    MainLoop.scheduler();
  },
  updateStatus() {
    if (Module["setStatus"]) {
      var message = Module["statusMessage"] || "Please wait...";
      var remaining = MainLoop.remainingBlockers ?? 0;
      var expected = MainLoop.expectedBlockers ?? 0;
      if (remaining) {
        if (remaining < expected) {
          Module["setStatus"](`{message} ({expected - remaining}/{expected})`);
        } else {
          Module["setStatus"](message);
        }
      } else {
        Module["setStatus"]("");
      }
    }
  },
  init() {
    Module["preMainLoop"] && MainLoop.preMainLoop.push(Module["preMainLoop"]);
    Module["postMainLoop"] && MainLoop.postMainLoop.push(Module["postMainLoop"]);
  },
  runIter(func) {
    if (ABORT) return;
    for (var pre of MainLoop.preMainLoop) {
      if (pre() === false) {
        return;
      }
    }
    callUserCallback(func);
    for (var post of MainLoop.postMainLoop) {
      post();
    }
    checkStackCookie();
  },
  nextRAF: 0,
  fakeRequestAnimationFrame(func) {
    // try to keep 60fps between calls to here
    var now = Date.now();
    if (MainLoop.nextRAF === 0) {
      MainLoop.nextRAF = now + 1e3 / 60;
    } else {
      while (now + 2 >= MainLoop.nextRAF) {
        // fudge a little, to avoid timer jitter causing us to do lots of delay:0
        MainLoop.nextRAF += 1e3 / 60;
      }
    }
    var delay = Math.max(MainLoop.nextRAF - now, 0);
    setTimeout(func, delay);
  },
  requestAnimationFrame(func) {
    if (globalThis.requestAnimationFrame) {
      requestAnimationFrame(func);
    } else {
      MainLoop.fakeRequestAnimationFrame(func);
    }
  }
};

var _emscripten_cancel_main_loop = () => {
  MainLoop.pause();
  MainLoop.func = null;
};

var _emscripten_console_log = str => {
  assert(typeof str == "number");
  console.log(UTF8ToString(str));
};

var _emscripten_date_now = () => Date.now();

var _emscripten_err = str => err(UTF8ToString(str));

var _emscripten_get_device_pixel_ratio = () => globalThis.devicePixelRatio ?? 1;

var maybeCStringToJsString = cString => cString > 2 ? UTF8ToString(cString) : cString;

/** @type {Object} */ var specialHTMLTargets = [ 0, globalThis.document ?? 0, globalThis.window ?? 0 ];

var findEventTarget = target => {
  target = maybeCStringToJsString(target);
  var domElement = specialHTMLTargets[target] || globalThis.document?.querySelector(target);
  return domElement;
};

var getBoundingClientRect = e => specialHTMLTargets.indexOf(e) < 0 ? e.getBoundingClientRect() : {
  "left": 0,
  "top": 0
};

var _emscripten_get_element_css_size = (target, width, height) => {
  target = findEventTarget(target);
  if (!target) return -4;
  var rect = getBoundingClientRect(target);
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((width) >> 3), "storing")] = rect.width;
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((height) >> 3), "storing")] = rect.height;
  return 0;
};

var _emscripten_has_asyncify = () => 0;

var _emscripten_performance_now = () => performance.now();

/** @suppress{checkTypes} */ var getWasmTableEntry = funcPtr => wasmTable.get(funcPtr);

var _emscripten_request_animation_frame_loop = (cb, userData) => {
  function tick(timeStamp) {
    if (getWasmTableEntry(cb)(timeStamp, userData)) {
      requestAnimationFrame(tick);
    }
  }
  return requestAnimationFrame(tick);
};

var getHeapMax = () => // Stay one Wasm page short of 4GB: while e.g. Chrome is able to allocate
// full 4GB Wasm memories, the size will wrap back to 0 bytes in Wasm side
// for any code that deals with heap sizes, which would require special
// casing all heap size related code to treat 0 specially.
2147483648;

var alignMemory = (size, alignment) => {
  assert(alignment, "alignment argument is required");
  return Math.ceil(size / alignment) * alignment;
};

var growMemory = size => {
  var oldHeapSize = wasmMemory.buffer.byteLength;
  var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
  try {
    // round size grow request up to wasm page size (fixed 64KB per spec)
    wasmMemory.grow(pages);
    // .grow() takes a delta compared to the previous size
    updateMemoryViews();
    return 1;
  } catch (e) {
    err(`growMemory: Attempted to grow heap from ${oldHeapSize} bytes to ${size} bytes, but got error: ${e}`);
  }
};

var _emscripten_resize_heap = requestedSize => {
  var oldSize = HEAPU8.length;
  // With CAN_ADDRESS_2GB or MEMORY64, pointers are already unsigned.
  requestedSize >>>= 0;
  // With multithreaded builds, races can happen (another thread might increase the size
  // in between), so return a failure, and let the caller retry.
  assert(requestedSize > oldSize);
  // Memory resize rules:
  // 1.  Always increase heap size to at least the requested size, rounded up
  //     to next page multiple.
  // 2a. If MEMORY_GROWTH_LINEAR_STEP == -1, excessively resize the heap
  //     geometrically: increase the heap size according to
  //     MEMORY_GROWTH_GEOMETRIC_STEP factor (default +20%), At most
  //     overreserve by MEMORY_GROWTH_GEOMETRIC_CAP bytes (default 96MB).
  // 2b. If MEMORY_GROWTH_LINEAR_STEP != -1, excessively resize the heap
  //     linearly: increase the heap size by at least
  //     MEMORY_GROWTH_LINEAR_STEP bytes.
  // 3.  Max size for the heap is capped at 2048MB-WASM_PAGE_SIZE, or by
  //     MAXIMUM_MEMORY, or by ASAN limit, depending on which is smallest
  // 4.  If we were unable to allocate as much memory, it may be due to
  //     over-eager decision to excessively reserve due to (3) above.
  //     Hence if an allocation fails, cut down on the amount of excess
  //     growth, in an attempt to succeed to perform a smaller allocation.
  // A limit is set for how much we can grow. We should not exceed that
  // (the wasm binary specifies it, so if we tried, we'd fail anyhow).
  var maxHeapSize = getHeapMax();
  if (requestedSize > maxHeapSize) {
    err(`Cannot enlarge memory, requested ${requestedSize} bytes, but the limit is ${maxHeapSize} bytes!`);
    return false;
  }
  // Loop through potential heap size increases. If we attempt a too eager
  // reservation that fails, cut down on the attempted size and reserve a
  // smaller bump instead. (max 3 times, chosen somewhat arbitrarily)
  for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
    var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
    // ensure geometric growth
    // but limit overreserving (default to capping at +96MB overgrowth at most)
    overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
    var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
    var t0 = _emscripten_get_now();
    var replacement = growMemory(newSize);
    var t1 = _emscripten_get_now();
    dbg(`Heap resize call from ${oldSize} to ${newSize} took ${(t1 - t0)} msecs. Success: ${!!replacement}`);
    if (replacement) {
      return true;
    }
  }
  err(`Failed to grow the heap from ${oldSize} bytes to ${newSize} bytes, not enough memory!`);
  return false;
};

var onExits = [];

var JSEvents = {
  removeAllEventListeners() {
    while (JSEvents.eventHandlers.length) {
      JSEvents._removeHandler(JSEvents.eventHandlers.length - 1);
    }
    JSEvents.deferredCalls = [];
  },
  inEventHandler: 0,
  deferredCalls: [],
  deferCall(targetFunction, precedence, argsList) {
    function arraysHaveEqualContent(arrA, arrB) {
      if (arrA.length != arrB.length) return false;
      for (var i in arrA) {
        if (arrA[i] != arrB[i]) return false;
      }
      return true;
    }
    // Test if the given call was already queued, and if so, don't add it again.
    for (var call of JSEvents.deferredCalls) {
      if (call.targetFunction == targetFunction && arraysHaveEqualContent(call.argsList, argsList)) {
        return;
      }
    }
    JSEvents.deferredCalls.push({
      targetFunction,
      precedence,
      argsList
    });
    JSEvents.deferredCalls.sort((x, y) => x.precedence < y.precedence);
  },
  removeDeferredCalls(targetFunction) {
    JSEvents.deferredCalls = JSEvents.deferredCalls.filter(call => call.targetFunction != targetFunction);
  },
  canPerformEventHandlerRequests() {
    if (navigator.userActivation) {
      // Verify against transient activation status from UserActivation API
      // whether it is possible to perform a request here without needing to defer. See
      // https://developer.mozilla.org/en-US/docs/Web/Security/User_activation#transient_activation
      // and https://caniuse.com/mdn-api_useractivation
      // At the time of writing, Firefox does not support this API: https://bugzil.la/1791079
      return navigator.userActivation.isActive;
    }
    return JSEvents.inEventHandler && JSEvents.currentEventHandler.allowsDeferredCalls;
  },
  runDeferredCalls() {
    if (!JSEvents.canPerformEventHandlerRequests()) {
      return;
    }
    var deferredCalls = JSEvents.deferredCalls;
    JSEvents.deferredCalls = [];
    for (var call of deferredCalls) {
      call.targetFunction(...call.argsList);
    }
  },
  eventHandlers: [],
  removeAllHandlersOnTarget: (target, eventTypeString) => {
    for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
      if (JSEvents.eventHandlers[i].target == target && (!eventTypeString || eventTypeString == JSEvents.eventHandlers[i].eventTypeString)) {
        JSEvents._removeHandler(i--);
      }
    }
  },
  _removeHandler(i) {
    var h = JSEvents.eventHandlers[i];
    h.target.removeEventListener(h.eventTypeString, h.eventListenerFunc, h.useCapture);
    JSEvents.eventHandlers.splice(i, 1);
  },
  registerOrRemoveHandler(eventHandler) {
    if (!eventHandler.target) {
      err("registerOrRemoveHandler: the target element for event handler registration does not exist, when processing the following event handler registration:");
      console.dir(eventHandler);
      return -4;
    }
    if (eventHandler.callbackfunc) {
      eventHandler.eventListenerFunc = function(event) {
        // Increment nesting count for the event handler.
        ++JSEvents.inEventHandler;
        JSEvents.currentEventHandler = eventHandler;
        // Process any old deferred calls the user has placed.
        JSEvents.runDeferredCalls();
        // Process the actual event, calls back to user C code handler.
        eventHandler.handlerFunc(event);
        // Process any new deferred calls that were placed right now from this event handler.
        JSEvents.runDeferredCalls();
        // Out of event handler - restore nesting count.
        --JSEvents.inEventHandler;
      };
      eventHandler.target.addEventListener(eventHandler.eventTypeString, eventHandler.eventListenerFunc, eventHandler.useCapture);
      JSEvents.eventHandlers.push(eventHandler);
    } else {
      for (var i = 0; i < JSEvents.eventHandlers.length; ++i) {
        if (JSEvents.eventHandlers[i].target == eventHandler.target && JSEvents.eventHandlers[i].eventTypeString == eventHandler.eventTypeString) {
          JSEvents._removeHandler(i--);
        }
      }
    }
    return 0;
  },
  removeSingleHandler(eventHandler) {
    let success = false;
    for (let i = 0; i < JSEvents.eventHandlers.length; ++i) {
      const handler = JSEvents.eventHandlers[i];
      if (handler.target === eventHandler.target && handler.eventTypeId === eventHandler.eventTypeId && handler.callbackfunc === eventHandler.callbackfunc && handler.userData === eventHandler.userData) {
        // in some very rare cases (ex: Safari / fullscreen events), there is more than 1 handler (eventTypeString is different)
        JSEvents._removeHandler(i--);
        success = true;
      }
    }
    return success ? 0 : -5;
  },
  getNodeNameForTarget(target) {
    if (!target) return "";
    if (target == window) return "#window";
    if (target == screen) return "#screen";
    return target?.nodeName || "";
  },
  fullscreenEnabled() {
    return document.fullscreenEnabled || document.webkitFullscreenEnabled;
  }
};

var registerFocusEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 256;
  JSEvents.focusEvent ||= _malloc(eventSize);
  var focusEventHandlerFunc = e => {
    var nodeName = JSEvents.getNodeNameForTarget(e.target);
    var id = e.target.id ? e.target.id : "";
    var focusEvent = JSEvents.focusEvent;
    stringToUTF8(nodeName, focusEvent + 0, 128);
    stringToUTF8(id, focusEvent + 128, 128);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, focusEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target: findEventTarget(target),
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: focusEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_blur_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerFocusEventCallback(target, userData, useCapture, callbackfunc, 12, "blur", targetThread);

var findCanvasEventTarget = findEventTarget;

var _emscripten_set_canvas_element_size = (target, width, height) => {
  var canvas = findCanvasEventTarget(target);
  if (!canvas) return -4;
  canvas.width = width;
  canvas.height = height;
  return 0;
};

var fillDeviceOrientationEventData = (eventStruct, e, target) => {
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((eventStruct) >> 3), "storing")] = e.alpha;
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((eventStruct) + (8)) >> 3), "storing")] = e.beta;
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((eventStruct) + (16)) >> 3), "storing")] = e.gamma;
  HEAP8[SAFE_HEAP_INDEX(HEAP8, (eventStruct) + (24), "storing")] = e.absolute;
  checkInt8(e.absolute);
};

var registerDeviceOrientationEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 32;
  JSEvents.deviceOrientationEvent ||= _malloc(eventSize);
  var deviceOrientationEventHandlerFunc = e => {
    fillDeviceOrientationEventData(JSEvents.deviceOrientationEvent, e, target);
    // TODO: Thread-safety with respect to emscripten_get_deviceorientation_status()
    if (getWasmTableEntry(callbackfunc)(eventTypeId, JSEvents.deviceOrientationEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target: findEventTarget(target),
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: deviceOrientationEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_deviceorientation_callback_on_thread = (userData, useCapture, callbackfunc, targetThread) => registerDeviceOrientationEventCallback(2, userData, useCapture, callbackfunc, 16, "deviceorientation", targetThread);

var _emscripten_set_focus_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerFocusEventCallback(target, userData, useCapture, callbackfunc, 13, "focus", targetThread);

function getFullscreenElement() {
  return document.fullscreenElement || document.mozFullScreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || document.msFullscreenElement;
}

var fillFullscreenChangeEventData = eventStruct => {
  var fullscreenElement = getFullscreenElement();
  var isFullscreen = !!fullscreenElement;
  // Assigning a boolean to HEAP32 with expected type coercion.
  /** @suppress{checkTypes} */ HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct, "storing")] = isFullscreen;
  checkInt8(isFullscreen);
  HEAP8[SAFE_HEAP_INDEX(HEAP8, (eventStruct) + (1), "storing")] = JSEvents.fullscreenEnabled();
  checkInt8(JSEvents.fullscreenEnabled());
  // If transitioning to fullscreen, report info about the element that is now fullscreen.
  // If transitioning to windowed mode, report info about the element that just was fullscreen.
  var reportedElement = isFullscreen ? fullscreenElement : JSEvents.previousFullscreenElement;
  var nodeName = JSEvents.getNodeNameForTarget(reportedElement);
  var id = reportedElement?.id || "";
  stringToUTF8(nodeName, eventStruct + 2, 128);
  stringToUTF8(id, eventStruct + 130, 128);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((eventStruct) + (260)) >> 2), "storing")] = reportedElement ? reportedElement.clientWidth : 0;
  checkInt32(reportedElement ? reportedElement.clientWidth : 0);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((eventStruct) + (264)) >> 2), "storing")] = reportedElement ? reportedElement.clientHeight : 0;
  checkInt32(reportedElement ? reportedElement.clientHeight : 0);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((eventStruct) + (268)) >> 2), "storing")] = screen.width;
  checkInt32(screen.width);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, (((eventStruct) + (272)) >> 2), "storing")] = screen.height;
  checkInt32(screen.height);
  if (isFullscreen) {
    JSEvents.previousFullscreenElement = fullscreenElement;
  }
};

var registerFullscreenChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 276;
  JSEvents.fullscreenChangeEvent ||= _malloc(eventSize);
  var fullscreenChangeEventHandlerFunc = e => {
    var fullscreenChangeEvent = JSEvents.fullscreenChangeEvent;
    fillFullscreenChangeEventData(fullscreenChangeEvent);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, fullscreenChangeEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: fullscreenChangeEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_fullscreenchange_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => {
  if (!JSEvents.fullscreenEnabled()) return -1;
  target = findEventTarget(target);
  if (!target) return -4;
  // As of Safari 13.0.3 on macOS Catalina 10.15.1 still ships with prefixed webkitfullscreenchange. TODO: revisit this check once Safari ships unprefixed version.
  // TODO: When this block is removed, also change test/test_html5_remove_event_listener.c test expectation on emscripten_set_fullscreenchange_callback().
  registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "webkitfullscreenchange", targetThread);
  return registerFullscreenChangeEventCallback(target, userData, useCapture, callbackfunc, 19, "fullscreenchange", targetThread);
};

var registerKeyEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 160;
  JSEvents.keyEvent ||= _malloc(eventSize);
  var keyEventHandlerFunc = e => {
    assert(e);
    var keyEventData = JSEvents.keyEvent;
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((keyEventData) >> 3), "storing")] = e.timeStamp;
    var idx = ((keyEventData) >> 2);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 2, "storing")] = e.location;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, keyEventData + 12, "storing")] = e.ctrlKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, keyEventData + 13, "storing")] = e.shiftKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, keyEventData + 14, "storing")] = e.altKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, keyEventData + 15, "storing")] = e.metaKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, keyEventData + 16, "storing")] = e.repeat;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 5, "storing")] = e.charCode;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 6, "storing")] = e.keyCode;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 7, "storing")] = e.which;
    stringToUTF8(e.key || "", keyEventData + 32, 32);
    stringToUTF8(e.code || "", keyEventData + 64, 32);
    stringToUTF8(e.char || "", keyEventData + 96, 32);
    stringToUTF8(e.locale || "", keyEventData + 128, 32);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, keyEventData, userData)) e.preventDefault();
  };
  var eventHandler = {
    target: findEventTarget(target),
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: keyEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_keydown_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerKeyEventCallback(target, userData, useCapture, callbackfunc, 2, "keydown", targetThread);

var _emscripten_set_keypress_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerKeyEventCallback(target, userData, useCapture, callbackfunc, 1, "keypress", targetThread);

var _emscripten_set_keyup_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerKeyEventCallback(target, userData, useCapture, callbackfunc, 3, "keyup", targetThread);

var _emscripten_set_main_loop = (func, fps, simulateInfiniteLoop) => {
  var iterFunc = getWasmTableEntry(func);
  setMainLoop(iterFunc, fps, simulateInfiniteLoop);
};

var fillMouseEventData = (eventStruct, e, target) => {
  assert(eventStruct % 4 == 0);
  HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((eventStruct) >> 3), "storing")] = e.timeStamp;
  var idx = ((eventStruct) >> 2);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 2, "storing")] = e.screenX;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 3, "storing")] = e.screenY;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 4, "storing")] = e.clientX;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 5, "storing")] = e.clientY;
  HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct + 24, "storing")] = e.ctrlKey;
  HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct + 25, "storing")] = e.shiftKey;
  HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct + 26, "storing")] = e.altKey;
  HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct + 27, "storing")] = e.metaKey;
  HEAP16[SAFE_HEAP_INDEX(HEAP16, idx * 2 + 14, "storing")] = e.button;
  HEAP16[SAFE_HEAP_INDEX(HEAP16, idx * 2 + 15, "storing")] = e.buttons;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 8, "storing")] = e["movementX"];
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 9, "storing")] = e["movementY"];
  // Note: rect contains doubles (truncated to placate SAFE_HEAP, which is the same behaviour when writing to HEAP32 anyway)
  var rect = getBoundingClientRect(target);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 10, "storing")] = e.clientX - (rect.left | 0);
  HEAP32[SAFE_HEAP_INDEX(HEAP32, idx + 11, "storing")] = e.clientY - (rect.top | 0);
};

var registerMouseEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 64;
  JSEvents.mouseEvent ||= _malloc(eventSize);
  target = findEventTarget(target);
  var mouseEventHandlerFunc = e => {
    // TODO: Make this access thread safe, or this could update live while app is reading it.
    fillMouseEventData(JSEvents.mouseEvent, e, target);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, JSEvents.mouseEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    allowsDeferredCalls: eventTypeString != "mousemove" && eventTypeString != "mouseenter" && eventTypeString != "mouseleave",
    // Mouse move events do not allow fullscreen/pointer lock requests to be handled in them!
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: mouseEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_mousedown_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerMouseEventCallback(target, userData, useCapture, callbackfunc, 5, "mousedown", targetThread);

var _emscripten_set_mouseenter_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerMouseEventCallback(target, userData, useCapture, callbackfunc, 33, "mouseenter", targetThread);

var _emscripten_set_mouseleave_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerMouseEventCallback(target, userData, useCapture, callbackfunc, 34, "mouseleave", targetThread);

var _emscripten_set_mousemove_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerMouseEventCallback(target, userData, useCapture, callbackfunc, 8, "mousemove", targetThread);

var _emscripten_set_mouseup_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerMouseEventCallback(target, userData, useCapture, callbackfunc, 6, "mouseup", targetThread);

var fillPointerlockChangeEventData = eventStruct => {
  var pointerLockElement = document.pointerLockElement;
  var isPointerlocked = !!pointerLockElement;
  // Assigning a boolean to HEAP32 with expected type coercion.
  /** @suppress{checkTypes} */ HEAP8[SAFE_HEAP_INDEX(HEAP8, eventStruct, "storing")] = isPointerlocked;
  checkInt8(isPointerlocked);
  var nodeName = JSEvents.getNodeNameForTarget(pointerLockElement);
  var id = pointerLockElement?.id || "";
  stringToUTF8(nodeName, eventStruct + 1, 128);
  stringToUTF8(id, eventStruct + 129, 128);
};

var registerPointerlockChangeEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 257;
  JSEvents.pointerlockChangeEvent ||= _malloc(eventSize);
  var pointerlockChangeEventHandlerFunc = e => {
    var pointerlockChangeEvent = JSEvents.pointerlockChangeEvent;
    fillPointerlockChangeEventData(pointerlockChangeEvent);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, pointerlockChangeEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: pointerlockChangeEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_pointerlockchange_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => {
  if (!document.body?.requestPointerLock) {
    return -1;
  }
  target = findEventTarget(target);
  if (!target) return -4;
  return registerPointerlockChangeEventCallback(target, userData, useCapture, callbackfunc, 20, "pointerlockchange", targetThread);
};

var registerPointerlockErrorEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var pointerlockErrorEventHandlerFunc = e => {
    if (getWasmTableEntry(callbackfunc)(eventTypeId, 0, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: pointerlockErrorEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_pointerlockerror_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => {
  if (!document.body?.requestPointerLock) {
    return -1;
  }
  target = findEventTarget(target);
  if (!target) return -4;
  return registerPointerlockErrorEventCallback(target, userData, useCapture, callbackfunc, 38, "pointerlockerror", targetThread);
};

var registerUiEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 36;
  JSEvents.uiEvent ||= _malloc(eventSize);
  target = findEventTarget(target);
  var uiEventHandlerFunc = e => {
    if (e.target != target) {
      // Never take ui events such as scroll via a 'bubbled' route, but always from the direct element that
      // was targeted. Otherwise e.g. if app logs a message in response to a page scroll, the Emscripten log
      // message box could cause to scroll, generating a new (bubbled) scroll message, causing a new log print,
      // causing a new scroll, etc..
      return;
    }
    var b = document.body;
    // Take document.body to a variable, Closure compiler does not outline access to it on its own.
    if (!b) {
      // During a page unload 'body' can be null, with "Cannot read property 'clientWidth' of null" being thrown
      return;
    }
    var uiEvent = JSEvents.uiEvent;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, ((uiEvent) >> 2), "storing")] = 0;
    checkInt32(0);
    // always zero for resize and scroll
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (4)) >> 2), "storing")] = b.clientWidth;
    checkInt32(b.clientWidth);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (8)) >> 2), "storing")] = b.clientHeight;
    checkInt32(b.clientHeight);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (12)) >> 2), "storing")] = innerWidth;
    checkInt32(innerWidth);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (16)) >> 2), "storing")] = innerHeight;
    checkInt32(innerHeight);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (20)) >> 2), "storing")] = outerWidth;
    checkInt32(outerWidth);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (24)) >> 2), "storing")] = outerHeight;
    checkInt32(outerHeight);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (28)) >> 2), "storing")] = pageXOffset | 0;
    checkInt32(pageXOffset | 0);
    // scroll offsets are float
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((uiEvent) + (32)) >> 2), "storing")] = pageYOffset | 0;
    checkInt32(pageYOffset | 0);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, uiEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: uiEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_resize_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerUiEventCallback(target, userData, useCapture, callbackfunc, 10, "resize", targetThread);

var registerTouchEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 1552;
  JSEvents.touchEvent ||= _malloc(eventSize);
  target = findEventTarget(target);
  var touchEventHandlerFunc = e => {
    assert(e);
    var t, touches = {}, et = e.touches;
    // To ease marshalling different kinds of touches that browser reports (all touches are listed in e.touches,
    // only changed touches in e.changedTouches, and touches on target at a.targetTouches), mark a boolean in
    // each Touch object so that we can later loop only once over all touches we see to marshall over to Wasm.
    for (let t of et) {
      // Browser might recycle the generated Touch objects between each frame (Firefox on Android), so reset any
      // changed/target states we may have set from previous frame.
      t.isChanged = t.onTarget = 0;
      touches[t.identifier] = t;
    }
    // Mark which touches are part of the changedTouches list.
    for (let t of e.changedTouches) {
      t.isChanged = 1;
      touches[t.identifier] = t;
    }
    // Mark which touches are part of the targetTouches list.
    for (let t of e.targetTouches) {
      touches[t.identifier].onTarget = 1;
    }
    var touchEvent = JSEvents.touchEvent;
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((touchEvent) >> 3), "storing")] = e.timeStamp;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, touchEvent + 12, "storing")] = e.ctrlKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, touchEvent + 13, "storing")] = e.shiftKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, touchEvent + 14, "storing")] = e.altKey;
    HEAP8[SAFE_HEAP_INDEX(HEAP8, touchEvent + 15, "storing")] = e.metaKey;
    var idx = touchEvent + 16;
    var targetRect = getBoundingClientRect(target);
    var numTouches = 0;
    for (let t of Object.values(touches)) {
      var idx32 = ((idx) >> 2);
      // Pre-shift the ptr to index to HEAP32 to save code size
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 0, "storing")] = t.identifier;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 1, "storing")] = t.screenX;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 2, "storing")] = t.screenY;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 3, "storing")] = t.clientX;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 4, "storing")] = t.clientY;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 5, "storing")] = t.pageX;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 6, "storing")] = t.pageY;
      HEAP8[SAFE_HEAP_INDEX(HEAP8, idx + 28, "storing")] = t.isChanged;
      HEAP8[SAFE_HEAP_INDEX(HEAP8, idx + 29, "storing")] = t.onTarget;
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 8, "storing")] = t.clientX - (targetRect.left | 0);
      HEAP32[SAFE_HEAP_INDEX(HEAP32, idx32 + 9, "storing")] = t.clientY - (targetRect.top | 0);
      idx += 48;
      if (++numTouches > 31) {
        break;
      }
    }
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((touchEvent) + (8)) >> 2), "storing")] = numTouches;
    checkInt32(numTouches);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, touchEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    allowsDeferredCalls: eventTypeString == "touchstart" || eventTypeString == "touchend",
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: touchEventHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_touchcancel_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerTouchEventCallback(target, userData, useCapture, callbackfunc, 25, "touchcancel", targetThread);

var _emscripten_set_touchend_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerTouchEventCallback(target, userData, useCapture, callbackfunc, 23, "touchend", targetThread);

var _emscripten_set_touchmove_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerTouchEventCallback(target, userData, useCapture, callbackfunc, 24, "touchmove", targetThread);

var _emscripten_set_touchstart_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => registerTouchEventCallback(target, userData, useCapture, callbackfunc, 22, "touchstart", targetThread);

var registerWheelEventCallback = (target, userData, useCapture, callbackfunc, eventTypeId, eventTypeString, targetThread) => {
  var eventSize = 96;
  JSEvents.wheelEvent ||= _malloc(eventSize);
  // The DOM Level 3 events spec event 'wheel'
  var wheelHandlerFunc = e => {
    var wheelEvent = JSEvents.wheelEvent;
    fillMouseEventData(wheelEvent, e, target);
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((wheelEvent) + (64)) >> 3), "storing")] = e["deltaX"];
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((wheelEvent) + (72)) >> 3), "storing")] = e["deltaY"];
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((wheelEvent) + (80)) >> 3), "storing")] = e["deltaZ"];
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((wheelEvent) + (88)) >> 2), "storing")] = e["deltaMode"];
    checkInt32(e["deltaMode"]);
    if (getWasmTableEntry(callbackfunc)(eventTypeId, wheelEvent, userData)) e.preventDefault();
  };
  var eventHandler = {
    target,
    allowsDeferredCalls: true,
    eventTypeString,
    eventTypeId,
    userData,
    callbackfunc,
    handlerFunc: wheelHandlerFunc,
    useCapture
  };
  return JSEvents.registerOrRemoveHandler(eventHandler);
};

var _emscripten_set_wheel_callback_on_thread = (target, userData, useCapture, callbackfunc, targetThread) => {
  target = findEventTarget(target);
  if (!target) return -4;
  if (typeof target.onwheel != "undefined") {
    return registerWheelEventCallback(target, userData, useCapture, callbackfunc, 9, "wheel", targetThread);
  } else {
    return -1;
  }
};

var stackAlloc = sz => __emscripten_stack_alloc(sz);

var stringToUTF8OnStack = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = stackAlloc(size);
  stringToUTF8(str, ret, size);
  return ret;
};

var stringToNewUTF8 = str => {
  var size = lengthBytesUTF8(str) + 1;
  var ret = _malloc(size);
  if (ret) stringToUTF8(str, ret, size);
  return ret;
};

var WebGPU = {
  Internals: {
    jsObjects: [],
    jsObjectInsert: (ptr, jsObject) => {
      ptr >>>= 0;
      WebGPU.Internals.jsObjects[ptr] = jsObject;
    },
    bufferOnUnmaps: [],
    futures: [],
    futureInsert: (futureId, promise) => {}
  },
  getJsObject: ptr => {
    if (!ptr) return undefined;
    ptr >>>= 0;
    assert(ptr in WebGPU.Internals.jsObjects);
    return WebGPU.Internals.jsObjects[ptr];
  },
  importJsAdapter: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateAdapter(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsBindGroup: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateBindGroup(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsBindGroupLayout: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateBindGroupLayout(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsBuffer: (buffer, parentPtr = 0) => {
    // At the moment, we do not allow importing pending buffers.
    assert(buffer.mapState != "pending");
    var mapState = buffer.mapState == "mapped" ? 3 : 1;
    var bufferPtr = _emwgpuCreateBuffer(parentPtr, mapState);
    WebGPU.Internals.jsObjectInsert(bufferPtr, buffer);
    if (buffer.mapState == "mapped") {
      WebGPU.Internals.bufferOnUnmaps[bufferPtr] = [];
    }
    return bufferPtr;
  },
  importJsCommandBuffer: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateCommandBuffer(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsCommandEncoder: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateCommandEncoder(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsComputePassEncoder: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateComputePassEncoder(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsComputePipeline: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateComputePipeline(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsDevice: (device, parentPtr = 0) => {
    var queuePtr = _emwgpuCreateQueue(parentPtr);
    var devicePtr = _emwgpuCreateDevice(parentPtr, queuePtr);
    WebGPU.Internals.jsObjectInsert(queuePtr, device.queue);
    WebGPU.Internals.jsObjectInsert(devicePtr, device);
    return devicePtr;
  },
  importJsPipelineLayout: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreatePipelineLayout(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsQuerySet: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateQuerySet(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsQueue: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateQueue(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsRenderBundle: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateRenderBundle(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsRenderBundleEncoder: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateRenderBundleEncoder(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsRenderPassEncoder: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateRenderPassEncoder(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsRenderPipeline: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateRenderPipeline(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsSampler: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateSampler(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsShaderModule: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateShaderModule(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsSurface: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateSurface(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsTexture: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateTexture(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  importJsTextureView: (obj, parentPtr = 0) => {
    var ptr = _emwgpuCreateTextureView(parentPtr);
    WebGPU.Internals.jsObjects[ptr] = obj;
    return ptr;
  },
  errorCallback: (callback, type, message, userdata) => {
    var sp = stackSave();
    var messagePtr = stringToUTF8OnStack(message);
    getWasmTableEntry(callback)(type, messagePtr, userdata);
    stackRestore(sp);
  },
  setStringView: (ptr, data, length) => {
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "storing")] = data;
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "storing")] = length;
  },
  makeStringFromStringView: stringViewPtr => {
    var ptr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((stringViewPtr) >> 2), "loading")];
    var length = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((stringViewPtr) + (4)) >> 2), "loading")];
    // UTF8ToString stops at the first null terminator character in the
    // string regardless of the length.
    return UTF8ToString(ptr, length);
  },
  makeStringFromOptionalStringView: stringViewPtr => {
    var ptr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((stringViewPtr) >> 2), "loading")];
    var length = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((stringViewPtr) + (4)) >> 2), "loading")];
    // If we don't have a valid string pointer, just return undefined when
    // optional.
    if (!ptr) {
      if (length === 0) {
        return "";
      }
      return undefined;
    }
    // UTF8ToString stops at the first null terminator character in the
    // string regardless of the length.
    return UTF8ToString(ptr, length);
  },
  makeColor: ptr => ({
    "r": HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ((ptr) >> 3), "loading")],
    "g": HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((ptr) + (8)) >> 3), "loading")],
    "b": HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((ptr) + (16)) >> 3), "loading")],
    "a": HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((ptr) + (24)) >> 3), "loading")]
  }),
  makeExtent3D: ptr => ({
    "width": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")],
    "height": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")],
    "depthOrArrayLayers": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (8)) >> 2), "loading")]
  }),
  makeOrigin3D: ptr => ({
    "x": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")],
    "y": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")],
    "z": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (8)) >> 2), "loading")]
  }),
  makeTexelCopyTextureInfo: ptr => {
    assert(ptr);
    return {
      "texture": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")]),
      "mipLevel": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")],
      "origin": WebGPU.makeOrigin3D(ptr + 8),
      "aspect": WebGPU.TextureAspect[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (20)) >> 2), "loading")]]
    };
  },
  makeTexelCopyBufferLayout: ptr => {
    var bytesPerRow = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (8)) >> 2), "loading")];
    var rowsPerImage = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (12)) >> 2), "loading")];
    return {
      "offset": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr + 4)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")]),
      "bytesPerRow": bytesPerRow === 4294967295 ? undefined : bytesPerRow,
      "rowsPerImage": rowsPerImage === 4294967295 ? undefined : rowsPerImage
    };
  },
  makeTexelCopyBufferInfo: ptr => {
    assert(ptr);
    var layoutPtr = ptr + 0;
    var bufferCopyView = WebGPU.makeTexelCopyBufferLayout(layoutPtr);
    bufferCopyView["buffer"] = WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (16)) >> 2), "loading")]);
    return bufferCopyView;
  },
  makePassTimestampWrites: ptr => {
    if (ptr === 0) return undefined;
    return {
      "querySet": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")]),
      "beginningOfPassWriteIndex": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (8)) >> 2), "loading")],
      "endOfPassWriteIndex": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (12)) >> 2), "loading")]
    };
  },
  makePipelineConstants: (constantCount, constantsPtr) => {
    if (!constantCount) return;
    var constants = {};
    for (var i = 0; i < constantCount; ++i) {
      var entryPtr = constantsPtr + 24 * i;
      var key = WebGPU.makeStringFromStringView(entryPtr + 4);
      constants[key] = HEAPF64[SAFE_HEAP_INDEX(HEAPF64, (((entryPtr) + (16)) >> 3), "loading")];
    }
    return constants;
  },
  makePipelineLayout: layoutPtr => {
    if (!layoutPtr) return "auto";
    return WebGPU.getJsObject(layoutPtr);
  },
  makeComputeState: ptr => {
    if (!ptr) return undefined;
    assert(ptr);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")] === 0);
    var desc = {
      "module": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")]),
      "constants": WebGPU.makePipelineConstants(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (16)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (20)) >> 2), "loading")]),
      "entryPoint": WebGPU.makeStringFromOptionalStringView(ptr + 8)
    };
    return desc;
  },
  makeComputePipelineDesc: descriptor => {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    var desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "layout": WebGPU.makePipelineLayout(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")]),
      "compute": WebGPU.makeComputeState(descriptor + 16)
    };
    return desc;
  },
  makeRenderPipelineDesc: descriptor => {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    function makePrimitiveState(psPtr) {
      if (!psPtr) return undefined;
      assert(psPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((psPtr) >> 2), "loading")] === 0);
      return {
        "topology": WebGPU.PrimitiveTopology[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((psPtr) + (4)) >> 2), "loading")]],
        "stripIndexFormat": WebGPU.IndexFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((psPtr) + (8)) >> 2), "loading")]],
        "frontFace": WebGPU.FrontFace[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((psPtr) + (12)) >> 2), "loading")]],
        "cullMode": WebGPU.CullMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((psPtr) + (16)) >> 2), "loading")]],
        "unclippedDepth": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((psPtr) + (20)) >> 2), "loading")])
      };
    }
    function makeBlendComponent(bdPtr) {
      if (!bdPtr) return undefined;
      return {
        "operation": WebGPU.BlendOperation[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((bdPtr) >> 2), "loading")]],
        "srcFactor": WebGPU.BlendFactor[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((bdPtr) + (4)) >> 2), "loading")]],
        "dstFactor": WebGPU.BlendFactor[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((bdPtr) + (8)) >> 2), "loading")]]
      };
    }
    function makeBlendState(bsPtr) {
      if (!bsPtr) return undefined;
      return {
        "alpha": makeBlendComponent(bsPtr + 12),
        "color": makeBlendComponent(bsPtr + 0)
      };
    }
    function makeColorState(csPtr) {
      assert(csPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((csPtr) >> 2), "loading")] === 0);
      var formatInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((csPtr) + (4)) >> 2), "loading")];
      return formatInt === 0 ? undefined : {
        "format": WebGPU.TextureFormat[formatInt],
        "blend": makeBlendState(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((csPtr) + (8)) >> 2), "loading")]),
        "writeMask": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((csPtr) + (16)) >> 2), "loading")]
      };
    }
    function makeColorStates(count, csArrayPtr) {
      var states = [];
      for (var i = 0; i < count; ++i) {
        states.push(makeColorState(csArrayPtr + 24 * i));
      }
      return states;
    }
    function makeStencilStateFace(ssfPtr) {
      assert(ssfPtr);
      return {
        "compare": WebGPU.CompareFunction[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ssfPtr) >> 2), "loading")]],
        "failOp": WebGPU.StencilOperation[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ssfPtr) + (4)) >> 2), "loading")]],
        "depthFailOp": WebGPU.StencilOperation[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ssfPtr) + (8)) >> 2), "loading")]],
        "passOp": WebGPU.StencilOperation[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ssfPtr) + (12)) >> 2), "loading")]]
      };
    }
    function makeDepthStencilState(dssPtr) {
      if (!dssPtr) return undefined;
      assert(dssPtr);
      return {
        "format": WebGPU.TextureFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dssPtr) + (4)) >> 2), "loading")]],
        "depthWriteEnabled": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dssPtr) + (8)) >> 2), "loading")]),
        "depthCompare": WebGPU.CompareFunction[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dssPtr) + (12)) >> 2), "loading")]],
        "stencilFront": makeStencilStateFace(dssPtr + 16),
        "stencilBack": makeStencilStateFace(dssPtr + 32),
        "stencilReadMask": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dssPtr) + (48)) >> 2), "loading")],
        "stencilWriteMask": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dssPtr) + (52)) >> 2), "loading")],
        "depthBias": HEAP32[SAFE_HEAP_INDEX(HEAP32, (((dssPtr) + (56)) >> 2), "loading")],
        "depthBiasSlopeScale": HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (((dssPtr) + (60)) >> 2), "loading")],
        "depthBiasClamp": HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (((dssPtr) + (64)) >> 2), "loading")]
      };
    }
    function makeVertexAttribute(vaPtr) {
      assert(vaPtr);
      return {
        "format": WebGPU.VertexFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vaPtr) + (4)) >> 2), "loading")]],
        "offset": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((vaPtr + 4)) + (8)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vaPtr) + (8)) >> 2), "loading")]),
        "shaderLocation": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vaPtr) + (16)) >> 2), "loading")]
      };
    }
    function makeVertexAttributes(count, vaArrayPtr) {
      var vas = [];
      for (var i = 0; i < count; ++i) {
        vas.push(makeVertexAttribute(vaArrayPtr + i * 24));
      }
      return vas;
    }
    function makeVertexBuffer(vbPtr) {
      if (!vbPtr) return undefined;
      var stepModeInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vbPtr) + (4)) >> 2), "loading")];
      var attributeCountInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vbPtr) + (16)) >> 2), "loading")];
      if (stepModeInt === 0 && attributeCountInt === 0) {
        return null;
      }
      return {
        "arrayStride": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((vbPtr + 4)) + (8)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vbPtr) + (8)) >> 2), "loading")]),
        "stepMode": WebGPU.VertexStepMode[stepModeInt],
        "attributes": makeVertexAttributes(attributeCountInt, HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((vbPtr) + (20)) >> 2), "loading")])
      };
    }
    function makeVertexBuffers(count, vbArrayPtr) {
      if (!count) return undefined;
      var vbs = [];
      for (var i = 0; i < count; ++i) {
        vbs.push(makeVertexBuffer(vbArrayPtr + i * 24));
      }
      return vbs;
    }
    function makeVertexState(viPtr) {
      if (!viPtr) return undefined;
      assert(viPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((viPtr) >> 2), "loading")] === 0);
      var desc = {
        "module": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((viPtr) + (4)) >> 2), "loading")]),
        "constants": WebGPU.makePipelineConstants(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((viPtr) + (16)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((viPtr) + (20)) >> 2), "loading")]),
        "buffers": makeVertexBuffers(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((viPtr) + (24)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((viPtr) + (28)) >> 2), "loading")]),
        "entryPoint": WebGPU.makeStringFromOptionalStringView(viPtr + 8)
      };
      return desc;
    }
    function makeMultisampleState(msPtr) {
      if (!msPtr) return undefined;
      assert(msPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((msPtr) >> 2), "loading")] === 0);
      return {
        "count": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((msPtr) + (4)) >> 2), "loading")],
        "mask": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((msPtr) + (8)) >> 2), "loading")],
        "alphaToCoverageEnabled": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((msPtr) + (12)) >> 2), "loading")])
      };
    }
    function makeFragmentState(fsPtr) {
      if (!fsPtr) return undefined;
      assert(fsPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((fsPtr) >> 2), "loading")] === 0);
      var desc = {
        "module": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((fsPtr) + (4)) >> 2), "loading")]),
        "constants": WebGPU.makePipelineConstants(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((fsPtr) + (16)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((fsPtr) + (20)) >> 2), "loading")]),
        "targets": makeColorStates(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((fsPtr) + (24)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((fsPtr) + (28)) >> 2), "loading")]),
        "entryPoint": WebGPU.makeStringFromOptionalStringView(fsPtr + 8)
      };
      return desc;
    }
    var desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "layout": WebGPU.makePipelineLayout(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")]),
      "vertex": makeVertexState(descriptor + 16),
      "primitive": makePrimitiveState(descriptor + 48),
      "depthStencil": makeDepthStencilState(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (72)) >> 2), "loading")]),
      "multisample": makeMultisampleState(descriptor + 76),
      "fragment": makeFragmentState(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (92)) >> 2), "loading")])
    };
    return desc;
  },
  fillLimitStruct: (limits, limitsOutPtr) => {
    assert(limitsOutPtr);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((limitsOutPtr) >> 2), "loading")] === 0);
    function setLimitValueU32(name, limitOffset) {
      var limitValue = limits[name];
      HEAP32[SAFE_HEAP_INDEX(HEAP32, (((limitsOutPtr) + (limitOffset)) >> 2), "storing")] = limitValue;
      checkInt32(limitValue);
    }
    function setLimitValueU64(name, limitOffset) {
      var limitValue = limits[name];
      HEAP64[SAFE_HEAP_INDEX(HEAP64, (((limitsOutPtr) + (limitOffset)) >> 3), "storing")] = BigInt(limitValue);
      checkInt64(limitValue);
    }
    setLimitValueU32("maxTextureDimension1D", 4);
    setLimitValueU32("maxTextureDimension2D", 8);
    setLimitValueU32("maxTextureDimension3D", 12);
    setLimitValueU32("maxTextureArrayLayers", 16);
    setLimitValueU32("maxBindGroups", 20);
    setLimitValueU32("maxBindGroupsPlusVertexBuffers", 24);
    setLimitValueU32("maxBindingsPerBindGroup", 28);
    setLimitValueU32("maxDynamicUniformBuffersPerPipelineLayout", 32);
    setLimitValueU32("maxDynamicStorageBuffersPerPipelineLayout", 36);
    setLimitValueU32("maxSampledTexturesPerShaderStage", 40);
    setLimitValueU32("maxSamplersPerShaderStage", 44);
    setLimitValueU32("maxStorageBuffersPerShaderStage", 48);
    setLimitValueU32("maxStorageTexturesPerShaderStage", 52);
    setLimitValueU32("maxUniformBuffersPerShaderStage", 56);
    setLimitValueU32("minUniformBufferOffsetAlignment", 80);
    setLimitValueU32("minStorageBufferOffsetAlignment", 84);
    setLimitValueU64("maxUniformBufferBindingSize", 64);
    setLimitValueU64("maxStorageBufferBindingSize", 72);
    setLimitValueU32("maxVertexBuffers", 88);
    setLimitValueU64("maxBufferSize", 96);
    setLimitValueU32("maxVertexAttributes", 104);
    setLimitValueU32("maxVertexBufferArrayStride", 108);
    setLimitValueU32("maxInterStageShaderVariables", 112);
    setLimitValueU32("maxColorAttachments", 116);
    setLimitValueU32("maxColorAttachmentBytesPerSample", 120);
    setLimitValueU32("maxComputeWorkgroupStorageSize", 124);
    setLimitValueU32("maxComputeInvocationsPerWorkgroup", 128);
    setLimitValueU32("maxComputeWorkgroupSizeX", 132);
    setLimitValueU32("maxComputeWorkgroupSizeY", 136);
    setLimitValueU32("maxComputeWorkgroupSizeZ", 140);
    setLimitValueU32("maxComputeWorkgroupsPerDimension", 144);
    // Non-standard. If this is undefined, it will correctly just cast to 0.
    if (limits.maxImmediateSize !== undefined) {
      setLimitValueU32("maxImmediateSize", 148);
    }
  },
  fillAdapterInfoStruct: (info, infoStruct) => {
    assert(infoStruct);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((infoStruct) >> 2), "loading")] === 0);
    // Populate subgroup limits.
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (52)) >> 2), "storing")] = info.subgroupMinSize;
    checkInt32(info.subgroupMinSize);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (56)) >> 2), "storing")] = info.subgroupMaxSize;
    checkInt32(info.subgroupMaxSize);
    // Append all the strings together to condense into a single malloc.
    var strs = info.vendor + info.architecture + info.device + info.description;
    var strPtr = stringToNewUTF8(strs);
    var vendorLen = lengthBytesUTF8(info.vendor);
    WebGPU.setStringView(infoStruct + 4, strPtr, vendorLen);
    strPtr += vendorLen;
    var architectureLen = lengthBytesUTF8(info.architecture);
    WebGPU.setStringView(infoStruct + 12, strPtr, architectureLen);
    strPtr += architectureLen;
    var deviceLen = lengthBytesUTF8(info.device);
    WebGPU.setStringView(infoStruct + 20, strPtr, deviceLen);
    strPtr += deviceLen;
    var descriptionLen = lengthBytesUTF8(info.description);
    WebGPU.setStringView(infoStruct + 28, strPtr, descriptionLen);
    strPtr += descriptionLen;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (36)) >> 2), "storing")] = 2;
    checkInt32(2);
    var adapterType = info.isFallbackAdapter ? 3 : 4;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (40)) >> 2), "storing")] = adapterType;
    checkInt32(adapterType);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (44)) >> 2), "storing")] = 0;
    checkInt32(0);
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((infoStruct) + (48)) >> 2), "storing")] = 0;
    checkInt32(0);
  },
  AddressMode: [ , "clamp-to-edge", "repeat", "mirror-repeat" ],
  BlendFactor: [ , "zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst", "one-minus-dst", "dst-alpha", "one-minus-dst-alpha", "src-alpha-saturated", "constant", "one-minus-constant", "src1", "one-minus-src1", "src1alpha", "one-minus-src1alpha" ],
  BlendOperation: [ , "add", "subtract", "reverse-subtract", "min", "max" ],
  BufferBindingType: [ "binding-not-used", , "uniform", "storage", "read-only-storage" ],
  BufferMapState: [ , "unmapped", "pending", "mapped" ],
  CompareFunction: [ , "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always" ],
  CompilationInfoRequestStatus: [ , "success", "callback-cancelled" ],
  CompositeAlphaMode: [ , "opaque", "premultiplied", "unpremultiplied", "inherit" ],
  CullMode: [ , "none", "front", "back" ],
  ErrorFilter: [ , "validation", "out-of-memory", "internal" ],
  FeatureLevel: [ , "compatibility", "core" ],
  FeatureName: {
    1: "core-features-and-limits",
    2: "depth-clip-control",
    3: "depth32float-stencil8",
    4: "texture-compression-bc",
    5: "texture-compression-bc-sliced-3d",
    6: "texture-compression-etc2",
    7: "texture-compression-astc",
    8: "texture-compression-astc-sliced-3d",
    9: "timestamp-query",
    10: "indirect-first-instance",
    11: "shader-f16",
    12: "rg11b10ufloat-renderable",
    13: "bgra8unorm-storage",
    14: "float32-filterable",
    15: "float32-blendable",
    16: "clip-distances",
    17: "dual-source-blending",
    18: "subgroups",
    19: "texture-formats-tier1",
    20: "texture-formats-tier2",
    21: "primitive-index",
    327692: "chromium-experimental-unorm16-texture-formats",
    327693: "chromium-experimental-snorm16-texture-formats",
    327732: "chromium-experimental-multi-draw-indirect"
  },
  FilterMode: [ , "nearest", "linear" ],
  FrontFace: [ , "ccw", "cw" ],
  IndexFormat: [ , "uint16", "uint32" ],
  InstanceFeatureName: [ , "timed-wait-any", "shader-source-spirv", "multiple-devices-per-adapter" ],
  LoadOp: [ , "load", "clear" ],
  MipmapFilterMode: [ , "nearest", "linear" ],
  OptionalBool: [ "false", "true" ],
  PowerPreference: [ , "low-power", "high-performance" ],
  PredefinedColorSpace: [ , "srgb", "display-p3" ],
  PrimitiveTopology: [ , "point-list", "line-list", "line-strip", "triangle-list", "triangle-strip" ],
  QueryType: [ , "occlusion", "timestamp" ],
  SamplerBindingType: [ "binding-not-used", , "filtering", "non-filtering", "comparison" ],
  Status: [ , "success", "error" ],
  StencilOperation: [ , "keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap" ],
  StorageTextureAccess: [ "binding-not-used", , "write-only", "read-only", "read-write" ],
  StoreOp: [ , "store", "discard" ],
  SurfaceGetCurrentTextureStatus: [ , "success-optimal", "success-suboptimal", "timeout", "outdated", "lost", "error" ],
  TextureAspect: [ , "all", "stencil-only", "depth-only" ],
  TextureDimension: [ , "1d", "2d", "3d" ],
  TextureFormat: [ , "r8unorm", "r8snorm", "r8uint", "r8sint", "r16unorm", "r16snorm", "r16uint", "r16sint", "r16float", "rg8unorm", "rg8snorm", "rg8uint", "rg8sint", "r32float", "r32uint", "r32sint", "rg16unorm", "rg16snorm", "rg16uint", "rg16sint", "rg16float", "rgba8unorm", "rgba8unorm-srgb", "rgba8snorm", "rgba8uint", "rgba8sint", "bgra8unorm", "bgra8unorm-srgb", "rgb10a2uint", "rgb10a2unorm", "rg11b10ufloat", "rgb9e5ufloat", "rg32float", "rg32uint", "rg32sint", "rgba16unorm", "rgba16snorm", "rgba16uint", "rgba16sint", "rgba16float", "rgba32float", "rgba32uint", "rgba32sint", "stencil8", "depth16unorm", "depth24plus", "depth24plus-stencil8", "depth32float", "depth32float-stencil8", "bc1-rgba-unorm", "bc1-rgba-unorm-srgb", "bc2-rgba-unorm", "bc2-rgba-unorm-srgb", "bc3-rgba-unorm", "bc3-rgba-unorm-srgb", "bc4-r-unorm", "bc4-r-snorm", "bc5-rg-unorm", "bc5-rg-snorm", "bc6h-rgb-ufloat", "bc6h-rgb-float", "bc7-rgba-unorm", "bc7-rgba-unorm-srgb", "etc2-rgb8unorm", "etc2-rgb8unorm-srgb", "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb", "etc2-rgba8unorm", "etc2-rgba8unorm-srgb", "eac-r11unorm", "eac-r11snorm", "eac-rg11unorm", "eac-rg11snorm", "astc-4x4-unorm", "astc-4x4-unorm-srgb", "astc-5x4-unorm", "astc-5x4-unorm-srgb", "astc-5x5-unorm", "astc-5x5-unorm-srgb", "astc-6x5-unorm", "astc-6x5-unorm-srgb", "astc-6x6-unorm", "astc-6x6-unorm-srgb", "astc-8x5-unorm", "astc-8x5-unorm-srgb", "astc-8x6-unorm", "astc-8x6-unorm-srgb", "astc-8x8-unorm", "astc-8x8-unorm-srgb", "astc-10x5-unorm", "astc-10x5-unorm-srgb", "astc-10x6-unorm", "astc-10x6-unorm-srgb", "astc-10x8-unorm", "astc-10x8-unorm-srgb", "astc-10x10-unorm", "astc-10x10-unorm-srgb", "astc-12x10-unorm", "astc-12x10-unorm-srgb", "astc-12x12-unorm", "astc-12x12-unorm-srgb" ],
  TextureSampleType: [ "binding-not-used", , "float", "unfilterable-float", "depth", "sint", "uint" ],
  TextureViewDimension: [ , "1d", "2d", "2d-array", "cube", "cube-array", "3d" ],
  ToneMappingMode: [ , "standard", "extended" ],
  VertexFormat: [ , "uint8", "uint8x2", "uint8x4", "sint8", "sint8x2", "sint8x4", "unorm8", "unorm8x2", "unorm8x4", "snorm8", "snorm8x2", "snorm8x4", "uint16", "uint16x2", "uint16x4", "sint16", "sint16x2", "sint16x4", "unorm16", "unorm16x2", "unorm16x4", "snorm16", "snorm16x2", "snorm16x4", "float16", "float16x2", "float16x4", "float32", "float32x2", "float32x3", "float32x4", "uint32", "uint32x2", "uint32x3", "uint32x4", "sint32", "sint32x2", "sint32x3", "sint32x4", "unorm10-10-10-2", "unorm8x4-bgra" ],
  VertexStepMode: [ , "vertex", "instance" ],
  WGSLLanguageFeatureName: [ , "readonly_and_readwrite_storage_textures", "packed_4x8_integer_dot_product", "unrestricted_pointer_parameters", "pointer_composite_access" ]
};

var emwgpuStringToInt_DeviceLostReason = {
  "undefined": 1,
  // For older browsers
  "unknown": 1,
  "destroyed": 2
};

function _emwgpuAdapterRequestDevice(adapterPtr, futureId, deviceLostFutureId, devicePtr, queuePtr, descriptor) {
  futureId = bigintToI53Checked(futureId);
  deviceLostFutureId = bigintToI53Checked(deviceLostFutureId);
  var adapter = WebGPU.getJsObject(adapterPtr);
  var desc = {};
  if (descriptor) {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    var requiredFeatureCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")];
    if (requiredFeatureCount) {
      var requiredFeaturesPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")];
      // requiredFeaturesPtr is a pointer to an array of FeatureName which is an enum of size uint32_t
      desc["requiredFeatures"] = Array.from(HEAPU32.subarray((((requiredFeaturesPtr) >> 2)), ((requiredFeaturesPtr + requiredFeatureCount * 4) >> 2)), feature => WebGPU.FeatureName[feature]);
    }
    var limitsPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (20)) >> 2), "loading")];
    if (limitsPtr) {
      assert(limitsPtr);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((limitsPtr) >> 2), "loading")] === 0);
      var requiredLimits = {};
      function setLimitU32IfDefined(name, limitOffset, ignoreIfZero = false) {
        var ptr = limitsPtr + limitOffset;
        var value = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")];
        if (value != 4294967295 && (!ignoreIfZero || value != 0)) {
          requiredLimits[name] = value;
        }
      }
      function setLimitU64IfDefined(name, limitOffset) {
        var ptr = limitsPtr + limitOffset;
        // Handle WGPU_LIMIT_U64_UNDEFINED.
        var limitPart1 = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")];
        var limitPart2 = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr) + (4)) >> 2), "loading")];
        if (limitPart1 != 4294967295 || limitPart2 != 4294967295) {
          requiredLimits[name] = (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((ptr + 4)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")]);
        }
      }
      setLimitU32IfDefined("maxTextureDimension1D", 4);
      setLimitU32IfDefined("maxTextureDimension2D", 8);
      setLimitU32IfDefined("maxTextureDimension3D", 12);
      setLimitU32IfDefined("maxTextureArrayLayers", 16);
      setLimitU32IfDefined("maxBindGroups", 20);
      setLimitU32IfDefined("maxBindGroupsPlusVertexBuffers", 24);
      setLimitU32IfDefined("maxDynamicUniformBuffersPerPipelineLayout", 32);
      setLimitU32IfDefined("maxDynamicStorageBuffersPerPipelineLayout", 36);
      setLimitU32IfDefined("maxSampledTexturesPerShaderStage", 40);
      setLimitU32IfDefined("maxSamplersPerShaderStage", 44);
      setLimitU32IfDefined("maxStorageBuffersPerShaderStage", 48);
      setLimitU32IfDefined("maxStorageTexturesPerShaderStage", 52);
      setLimitU32IfDefined("maxUniformBuffersPerShaderStage", 56);
      setLimitU32IfDefined("minUniformBufferOffsetAlignment", 80);
      setLimitU32IfDefined("minStorageBufferOffsetAlignment", 84);
      setLimitU64IfDefined("maxUniformBufferBindingSize", 64);
      setLimitU64IfDefined("maxStorageBufferBindingSize", 72);
      setLimitU32IfDefined("maxVertexBuffers", 88);
      setLimitU64IfDefined("maxBufferSize", 96);
      setLimitU32IfDefined("maxVertexAttributes", 104);
      setLimitU32IfDefined("maxVertexBufferArrayStride", 108);
      setLimitU32IfDefined("maxInterStageShaderVariables", 112);
      setLimitU32IfDefined("maxColorAttachments", 116);
      setLimitU32IfDefined("maxColorAttachmentBytesPerSample", 120);
      setLimitU32IfDefined("maxComputeWorkgroupStorageSize", 124);
      setLimitU32IfDefined("maxComputeInvocationsPerWorkgroup", 128);
      setLimitU32IfDefined("maxComputeWorkgroupSizeX", 132);
      setLimitU32IfDefined("maxComputeWorkgroupSizeY", 136);
      setLimitU32IfDefined("maxComputeWorkgroupSizeZ", 140);
      setLimitU32IfDefined("maxComputeWorkgroupsPerDimension", 144);
      // Non-standard. If this is 0, avoid passing it through so it won't cause an error.
      setLimitU32IfDefined("maxImmediateSize", 148, true);
      desc["requiredLimits"] = requiredLimits;
    }
    var defaultQueuePtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")];
    if (defaultQueuePtr) {
      var defaultQueueDesc = {
        "label": WebGPU.makeStringFromOptionalStringView(defaultQueuePtr + 4)
      };
      desc["defaultQueue"] = defaultQueueDesc;
    }
    desc["label"] = WebGPU.makeStringFromOptionalStringView(descriptor + 4);
  }
  // requestDevice
  WebGPU.Internals.futureInsert(futureId, adapter.requestDevice(desc).then(device => {
    // requestDevice fulfilled
    callUserCallback(() => {
      WebGPU.Internals.jsObjectInsert(queuePtr, device.queue);
      WebGPU.Internals.jsObjectInsert(devicePtr, device);
      // Set up device lost promise resolution.
      assert(deviceLostFutureId);
      // Don't keepalive here, because this isn't guaranteed to ever happen.
      WebGPU.Internals.futureInsert(deviceLostFutureId, device.lost.then(info => {
        // If the runtime has exited, avoid calling callUserCallback as it
        // will print an error (e.g. if the device got freed during shutdown).
        callUserCallback(() => {
          // Unset the uncaptured error handler.
          device.onuncapturederror = ev => {};
          var sp = stackSave();
          var messagePtr = stringToUTF8OnStack(info.message);
          _emwgpuOnDeviceLostCompleted(deviceLostFutureId, emwgpuStringToInt_DeviceLostReason[info.reason], messagePtr);
          stackRestore(sp);
        });
      }));
      // Set up uncaptured error handlers.
      assert(typeof GPUValidationError != "undefined");
      assert(typeof GPUOutOfMemoryError != "undefined");
      assert(typeof GPUInternalError != "undefined");
      device.onuncapturederror = ev => {
        var type = 5;
        if (ev.error instanceof GPUValidationError) type = 2; else if (ev.error instanceof GPUOutOfMemoryError) type = 3; else if (ev.error instanceof GPUInternalError) type = 4;
        var sp = stackSave();
        var messagePtr = stringToUTF8OnStack(ev.error.message);
        _emwgpuOnUncapturedError(devicePtr, type, messagePtr);
        stackRestore(sp);
      };
      _emwgpuOnRequestDeviceCompleted(futureId, 1, devicePtr, 0);
    });
  }, ex => {
    // requestDevice rejected
    callUserCallback(() => {
      var sp = stackSave();
      var messagePtr = stringToUTF8OnStack(ex.message);
      _emwgpuOnRequestDeviceCompleted(futureId, 3, devicePtr, messagePtr);
      if (deviceLostFutureId) {
        _emwgpuOnDeviceLostCompleted(deviceLostFutureId, 4, messagePtr);
      }
      stackRestore(sp);
    });
  }));
}

var _emwgpuBufferGetMappedRange = (bufferPtr, offset, size) => {
  var buffer = WebGPU.getJsObject(bufferPtr);
  if (size === 0) warnOnce("getMappedRange size=0 no longer means WGPU_WHOLE_MAP_SIZE");
  if (size == -1) size = undefined;
  var mapped;
  try {
    mapped = buffer.getMappedRange(offset, size);
  } catch (ex) {
    err(`buffer.getMappedRange(${offset}, ${size}) failed: ${ex}`);
    return 0;
  }
  var data = _memalign(16, mapped.byteLength);
  HEAPU8.fill(0, data, mapped.byteLength);
  WebGPU.Internals.bufferOnUnmaps[bufferPtr].push(() => {
    new Uint8Array(mapped).set(HEAPU8.subarray(data, data + mapped.byteLength));
    _free(data);
  });
  return data;
};

var _emwgpuBufferUnmap = bufferPtr => {
  var buffer = WebGPU.getJsObject(bufferPtr);
  var onUnmap = WebGPU.Internals.bufferOnUnmaps[bufferPtr];
  if (!onUnmap) {
    // Already unmapped
    return;
  }
  for (var i = 0; i < onUnmap.length; ++i) {
    onUnmap[i]();
  }
  delete WebGPU.Internals.bufferOnUnmaps[bufferPtr];
  buffer.unmap();
};

var _emwgpuDelete = ptr => {
  delete WebGPU.Internals.jsObjects[ptr];
};

var _emwgpuDeviceCreateBuffer = (devicePtr, descriptor, bufferPtr) => {
  assert(descriptor);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
  var mappedAtCreation = !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (32)) >> 2), "loading")]);
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "usage": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")],
    "size": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((descriptor + 4)) + (24)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")]),
    "mappedAtCreation": mappedAtCreation
  };
  var device = WebGPU.getJsObject(devicePtr);
  var buffer;
  try {
    buffer = device.createBuffer(desc);
  } catch (ex) {
    // The only exception should be RangeError if mapping at creation ran out of memory.
    assert(ex instanceof RangeError);
    assert(mappedAtCreation);
    err("createBuffer threw:", ex);
    return false;
  }
  WebGPU.Internals.jsObjectInsert(bufferPtr, buffer);
  if (mappedAtCreation) {
    WebGPU.Internals.bufferOnUnmaps[bufferPtr] = [];
  }
  return true;
};

var _emwgpuDeviceCreateShaderModule = (devicePtr, descriptor, shaderModulePtr) => {
  assert(descriptor);
  var nextInChainPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")];
  assert(nextInChainPtr !== 0);
  var sType = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((nextInChainPtr) + (4)) >> 2), "loading")];
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "code": ""
  };
  switch (sType) {
   case 2:
    {
      desc["code"] = WebGPU.makeStringFromStringView(nextInChainPtr + 8);
      break;
    }

   default:
    abort("unrecognized ShaderModule sType");
  }
  var device = WebGPU.getJsObject(devicePtr);
  WebGPU.Internals.jsObjectInsert(shaderModulePtr, device.createShaderModule(desc));
};

var _emwgpuDeviceDestroy = devicePtr => {
  const device = WebGPU.getJsObject(devicePtr);
  // Remove the onuncapturederror handler which holds a pointer to the WGPUDevice.
  device.onuncapturederror = null;
  device.destroy();
};

var emwgpuStringToInt_PreferredFormat = {
  "rgba8unorm": 22,
  "bgra8unorm": 27
};

var _emwgpuGetPreferredFormat = () => {
  var format = navigator.gpu.getPreferredCanvasFormat();
  return emwgpuStringToInt_PreferredFormat[format];
};

function _emwgpuInstanceRequestAdapter(instancePtr, futureId, options, adapterPtr) {
  futureId = bigintToI53Checked(futureId);
  var opts;
  if (options) {
    assert(options);
    var featureLevel = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((options) + (4)) >> 2), "loading")];
    opts = {
      "featureLevel": WebGPU.FeatureLevel[featureLevel],
      "powerPreference": WebGPU.PowerPreference[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((options) + (8)) >> 2), "loading")]],
      "forceFallbackAdapter": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((options) + (12)) >> 2), "loading")])
    };
    var nextInChainPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((options) >> 2), "loading")];
    if (nextInChainPtr !== 0) {
      var sType = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((nextInChainPtr) + (4)) >> 2), "loading")];
      assert(sType === 11);
      assert(0 === HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((nextInChainPtr) >> 2), "loading")]);
      var webxrOptions = nextInChainPtr;
      assert(webxrOptions);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((webxrOptions) >> 2), "loading")] === 0);
      opts.xrCompatible = !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((webxrOptions) + (8)) >> 2), "loading")]);
    }
  }
  if (!("gpu" in navigator)) {
    var sp = stackSave();
    var messagePtr = stringToUTF8OnStack("WebGPU not available on this browser (navigator.gpu is not available)");
    _emwgpuOnRequestAdapterCompleted(futureId, 3, adapterPtr, messagePtr);
    stackRestore(sp);
    return;
  }
  // requestAdapter
  WebGPU.Internals.futureInsert(futureId, navigator.gpu.requestAdapter(opts).then(adapter => {
    // requestAdapter fulfilled
    callUserCallback(() => {
      if (adapter) {
        WebGPU.Internals.jsObjectInsert(adapterPtr, adapter);
        _emwgpuOnRequestAdapterCompleted(futureId, 1, adapterPtr, 0);
      } else {
        var sp = stackSave();
        var messagePtr = stringToUTF8OnStack("WebGPU not available on this browser (requestAdapter returned null)");
        _emwgpuOnRequestAdapterCompleted(futureId, 3, adapterPtr, messagePtr);
        stackRestore(sp);
      }
    });
  }, ex => {
    // requestAdapter rejected
    callUserCallback(() => {
      var sp = stackSave();
      var messagePtr = stringToUTF8OnStack(ex.message);
      _emwgpuOnRequestAdapterCompleted(futureId, 4, adapterPtr, messagePtr);
      stackRestore(sp);
    });
  }));
}

var ENV = {};

var getExecutableName = () => thisProgram || "./this.program";

var getEnvStrings = () => {
  if (!getEnvStrings.strings) {
    // Default values.
    // Browser language detection #8751
    var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
    var env = {
      "USER": "web_user",
      "LOGNAME": "web_user",
      "PATH": "/",
      "PWD": "/",
      "HOME": "/home/web_user",
      "LANG": lang,
      "_": getExecutableName()
    };
    // Apply the user-provided values, if any.
    for (var x in ENV) {
      // x is a key in ENV; if ENV[x] is undefined, that means it was
      // explicitly set to be so. We allow user code to do that to
      // force variables with default values to remain unset.
      if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
      strings.push(`${x}=${env[x]}`);
    }
    getEnvStrings.strings = strings;
  }
  return getEnvStrings.strings;
};

var _environ_get = (__environ, environ_buf) => {
  var bufSize = 0;
  var envp = 0;
  for (var string of getEnvStrings()) {
    var ptr = environ_buf + bufSize;
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((__environ) + (envp)) >> 2), "storing")] = ptr;
    bufSize += stringToUTF8(string, ptr, Infinity) + 1;
    envp += 4;
  }
  return 0;
};

var _environ_sizes_get = (penviron_count, penviron_buf_size) => {
  var strings = getEnvStrings();
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((penviron_count) >> 2), "storing")] = strings.length;
  checkInt32(strings.length);
  var bufSize = 0;
  for (var string of strings) {
    bufSize += lengthBytesUTF8(string) + 1;
  }
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((penviron_buf_size) >> 2), "storing")] = bufSize;
  checkInt32(bufSize);
  return 0;
};

function _fd_close(fd) {
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    FS.close(stream);
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

/** @param {number=} offset */ var doReadv = (stream, iov, iovcnt, offset) => {
  var ret = 0;
  for (var i = 0; i < iovcnt; i++) {
    var ptr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((iov) >> 2), "loading")];
    var len = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((iov) + (4)) >> 2), "loading")];
    iov += 8;
    var curr = FS.read(stream, HEAP8, ptr, len, offset);
    if (curr < 0) return -1;
    ret += curr;
    if (curr < len) break;
    // nothing more to read
    if (typeof offset != "undefined") {
      offset += curr;
    }
  }
  return ret;
};

function _fd_read(fd, iov, iovcnt, pnum) {
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    var num = doReadv(stream, iov, iovcnt);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((pnum) >> 2), "storing")] = num;
    checkInt32(num);
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

function _fd_seek(fd, offset, whence, newOffset) {
  offset = bigintToI53Checked(offset);
  try {
    if (isNaN(offset)) return 61;
    var stream = SYSCALLS.getStreamFromFD(fd);
    FS.llseek(stream, offset, whence);
    HEAP64[SAFE_HEAP_INDEX(HEAP64, ((newOffset) >> 3), "storing")] = BigInt(stream.position);
    checkInt64(stream.position);
    if (stream.getdents && offset === 0 && whence === 0) stream.getdents = null;
    // reset readdir state
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

/** @param {number=} offset */ var doWritev = (stream, iov, iovcnt, offset) => {
  var ret = 0;
  for (var i = 0; i < iovcnt; i++) {
    var ptr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((iov) >> 2), "loading")];
    var len = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((iov) + (4)) >> 2), "loading")];
    iov += 8;
    var curr = FS.write(stream, HEAP8, ptr, len, offset);
    if (curr < 0) return -1;
    ret += curr;
    if (curr < len) {
      // No more space to write.
      break;
    }
    if (typeof offset != "undefined") {
      offset += curr;
    }
  }
  return ret;
};

function _fd_write(fd, iov, iovcnt, pnum) {
  try {
    var stream = SYSCALLS.getStreamFromFD(fd);
    var num = doWritev(stream, iov, iovcnt);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((pnum) >> 2), "storing")] = num;
    checkInt32(num);
    return 0;
  } catch (e) {
    if (typeof FS == "undefined" || !(e.name === "ErrnoError")) throw e;
    return e.errno;
  }
}

var _wgpuAdapterGetLimits = (adapterPtr, limitsOutPtr) => {
  var adapter = WebGPU.getJsObject(adapterPtr);
  WebGPU.fillLimitStruct(adapter.limits, limitsOutPtr);
  return 1;
};

var _wgpuAdapterHasFeature = (adapterPtr, featureEnumValue) => {
  var adapter = WebGPU.getJsObject(adapterPtr);
  return adapter.features.has(WebGPU.FeatureName[featureEnumValue]);
};

var _wgpuCommandEncoderBeginComputePass = (encoderPtr, descriptor) => {
  var desc;
  if (descriptor) {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "timestampWrites": WebGPU.makePassTimestampWrites(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")])
    };
  }
  var commandEncoder = WebGPU.getJsObject(encoderPtr);
  var ptr = _emwgpuCreateComputePassEncoder(0);
  WebGPU.Internals.jsObjectInsert(ptr, commandEncoder.beginComputePass(desc));
  return ptr;
};

var _wgpuCommandEncoderBeginRenderPass = (encoderPtr, descriptor) => {
  assert(descriptor);
  function makeColorAttachment(caPtr) {
    var viewPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((caPtr) + (4)) >> 2), "loading")];
    if (viewPtr === 0) {
      // view could be undefined.
      return undefined;
    }
    var depthSlice = HEAP32[SAFE_HEAP_INDEX(HEAP32, (((caPtr) + (8)) >> 2), "loading")];
    if (depthSlice == -1) depthSlice = undefined;
    var loadOpInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((caPtr) + (16)) >> 2), "loading")];
    assert(loadOpInt !== 0);
    var storeOpInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((caPtr) + (20)) >> 2), "loading")];
    assert(storeOpInt !== 0);
    var clearValue = WebGPU.makeColor(caPtr + 24);
    return {
      "view": WebGPU.getJsObject(viewPtr),
      "depthSlice": depthSlice,
      "resolveTarget": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((caPtr) + (12)) >> 2), "loading")]),
      "clearValue": clearValue,
      "loadOp": WebGPU.LoadOp[loadOpInt],
      "storeOp": WebGPU.StoreOp[storeOpInt]
    };
  }
  function makeColorAttachments(count, caPtr) {
    var attachments = [];
    for (var i = 0; i < count; ++i) {
      attachments.push(makeColorAttachment(caPtr + 56 * i));
    }
    return attachments;
  }
  function makeDepthStencilAttachment(dsaPtr) {
    if (dsaPtr === 0) return undefined;
    return {
      "view": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (4)) >> 2), "loading")]),
      "depthClearValue": HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (((dsaPtr) + (16)) >> 2), "loading")],
      "depthLoadOp": WebGPU.LoadOp[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (8)) >> 2), "loading")]],
      "depthStoreOp": WebGPU.StoreOp[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (12)) >> 2), "loading")]],
      "depthReadOnly": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (20)) >> 2), "loading")]),
      "stencilClearValue": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (32)) >> 2), "loading")],
      "stencilLoadOp": WebGPU.LoadOp[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (24)) >> 2), "loading")]],
      "stencilStoreOp": WebGPU.StoreOp[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (28)) >> 2), "loading")]],
      "stencilReadOnly": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((dsaPtr) + (36)) >> 2), "loading")])
    };
  }
  function makeRenderPassDescriptor(descriptor) {
    assert(descriptor);
    var nextInChainPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")];
    var maxDrawCount = undefined;
    if (nextInChainPtr !== 0) {
      var sType = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((nextInChainPtr) + (4)) >> 2), "loading")];
      assert(sType === 3);
      assert(0 === HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((nextInChainPtr) >> 2), "loading")]);
      var renderPassMaxDrawCount = nextInChainPtr;
      assert(renderPassMaxDrawCount);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((renderPassMaxDrawCount) >> 2), "loading")] === 0);
      maxDrawCount = (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((renderPassMaxDrawCount + 4)) + (8)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((renderPassMaxDrawCount) + (8)) >> 2), "loading")]);
    }
    var desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "colorAttachments": makeColorAttachments(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")]),
      "depthStencilAttachment": makeDepthStencilAttachment(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (20)) >> 2), "loading")]),
      "occlusionQuerySet": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")]),
      "timestampWrites": WebGPU.makePassTimestampWrites(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (28)) >> 2), "loading")]),
      "maxDrawCount": maxDrawCount
    };
    return desc;
  }
  var desc = makeRenderPassDescriptor(descriptor);
  var commandEncoder = WebGPU.getJsObject(encoderPtr);
  var ptr = _emwgpuCreateRenderPassEncoder(0);
  WebGPU.Internals.jsObjectInsert(ptr, commandEncoder.beginRenderPass(desc));
  return ptr;
};

var _wgpuCommandEncoderFinish = (encoderPtr, descriptor) => {
  // TODO: Use the descriptor.
  var commandEncoder = WebGPU.getJsObject(encoderPtr);
  var ptr = _emwgpuCreateCommandBuffer(0);
  WebGPU.Internals.jsObjectInsert(ptr, commandEncoder.finish());
  return ptr;
};

var _wgpuComputePassEncoderEnd = passPtr => {
  var pass = WebGPU.getJsObject(passPtr);
  pass.end();
};

var _wgpuComputePassEncoderSetBindGroup = (passPtr, groupIndex, groupPtr, dynamicOffsetCount, dynamicOffsetsPtr) => {
  assert(groupIndex >= 0);
  var pass = WebGPU.getJsObject(passPtr);
  var group = WebGPU.getJsObject(groupPtr);
  if (dynamicOffsetCount == 0) {
    pass.setBindGroup(groupIndex, group);
  } else {
    pass.setBindGroup(groupIndex, group, HEAPU32, ((dynamicOffsetsPtr) >> 2), dynamicOffsetCount);
  }
};

var _wgpuComputePassEncoderSetPipeline = (passPtr, pipelinePtr) => {
  var pass = WebGPU.getJsObject(passPtr);
  var pipeline = WebGPU.getJsObject(pipelinePtr);
  pass.setPipeline(pipeline);
};

var readI53FromI64 = ptr => HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((ptr) >> 2), "loading")] + HEAP32[SAFE_HEAP_INDEX(HEAP32, (((ptr) + (4)) >> 2), "loading")] * 4294967296;

var _wgpuDeviceCreateBindGroup = (devicePtr, descriptor) => {
  assert(descriptor);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
  function makeEntry(entryPtr) {
    assert(entryPtr);
    var bufferPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (8)) >> 2), "loading")];
    var samplerPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (32)) >> 2), "loading")];
    var textureViewPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (36)) >> 2), "loading")];
    assert((bufferPtr !== 0) + (samplerPtr !== 0) + (textureViewPtr !== 0) === 1);
    var binding = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")];
    if (bufferPtr) {
      var size = readI53FromI64((entryPtr) + (24));
      if (size == -1) size = undefined;
      return {
        "binding": binding,
        "resource": {
          "buffer": WebGPU.getJsObject(bufferPtr),
          "offset": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((entryPtr + 4)) + (16)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (16)) >> 2), "loading")]),
          "size": size
        }
      };
    } else if (samplerPtr) {
      return {
        "binding": binding,
        "resource": WebGPU.getJsObject(samplerPtr)
      };
    } else {
      return {
        "binding": binding,
        "resource": WebGPU.getJsObject(textureViewPtr)
      };
    }
  }
  function makeEntries(count, entriesPtrs) {
    var entries = [];
    for (var i = 0; i < count; ++i) {
      entries.push(makeEntry(entriesPtrs + 40 * i));
    }
    return entries;
  }
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "layout": WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")]),
    "entries": makeEntries(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (20)) >> 2), "loading")])
  };
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateBindGroup(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createBindGroup(desc));
  return ptr;
};

var _wgpuDeviceCreateBindGroupLayout = (devicePtr, descriptor) => {
  assert(descriptor);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
  function makeBufferEntry(entryPtr) {
    assert(entryPtr);
    var typeInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")];
    if (!typeInt) return undefined;
    return {
      "type": WebGPU.BufferBindingType[typeInt],
      "hasDynamicOffset": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (8)) >> 2), "loading")]),
      "minBindingSize": (HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((((entryPtr + 4)) + (16)) >> 2), "loading")] * 4294967296 + HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (16)) >> 2), "loading")])
    };
  }
  function makeSamplerEntry(entryPtr) {
    assert(entryPtr);
    var typeInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")];
    if (!typeInt) return undefined;
    return {
      "type": WebGPU.SamplerBindingType[typeInt]
    };
  }
  function makeTextureEntry(entryPtr) {
    assert(entryPtr);
    var sampleTypeInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")];
    if (!sampleTypeInt) return undefined;
    return {
      "sampleType": WebGPU.TextureSampleType[sampleTypeInt],
      "viewDimension": WebGPU.TextureViewDimension[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (8)) >> 2), "loading")]],
      "multisampled": !!(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (12)) >> 2), "loading")])
    };
  }
  function makeStorageTextureEntry(entryPtr) {
    assert(entryPtr);
    var accessInt = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")];
    if (!accessInt) return undefined;
    return {
      "access": WebGPU.StorageTextureAccess[accessInt],
      "format": WebGPU.TextureFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (8)) >> 2), "loading")]],
      "viewDimension": WebGPU.TextureViewDimension[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (12)) >> 2), "loading")]]
    };
  }
  function makeEntry(entryPtr) {
    assert(entryPtr);
    // bindingArraySize is not specced and thus not implemented yet. We don't pass it through
    // because if we did, then existing apps using this version of the bindings could break when
    // browsers start accepting bindingArraySize.
    var bindingArraySize = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (16)) >> 2), "loading")];
    assert(bindingArraySize == 0 || bindingArraySize == 1);
    return {
      "binding": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (4)) >> 2), "loading")],
      "visibility": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((entryPtr) + (8)) >> 2), "loading")],
      "buffer": makeBufferEntry(entryPtr + 24),
      "sampler": makeSamplerEntry(entryPtr + 48),
      "texture": makeTextureEntry(entryPtr + 56),
      "storageTexture": makeStorageTextureEntry(entryPtr + 72)
    };
  }
  function makeEntries(count, entriesPtrs) {
    var entries = [];
    for (var i = 0; i < count; ++i) {
      entries.push(makeEntry(entriesPtrs + 88 * i));
    }
    return entries;
  }
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "entries": makeEntries(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")])
  };
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateBindGroupLayout(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createBindGroupLayout(desc));
  return ptr;
};

var _wgpuDeviceCreateCommandEncoder = (devicePtr, descriptor) => {
  var desc;
  if (descriptor) {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4)
    };
  }
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateCommandEncoder(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createCommandEncoder(desc));
  return ptr;
};

var _wgpuDeviceCreateComputePipeline = (devicePtr, descriptor) => {
  var desc = WebGPU.makeComputePipelineDesc(descriptor);
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateComputePipeline(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createComputePipeline(desc));
  return ptr;
};

var _wgpuDeviceCreatePipelineLayout = (devicePtr, descriptor) => {
  assert(descriptor);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
  var bglCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")];
  var bglPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")];
  var bgls = [];
  for (var i = 0; i < bglCount; ++i) {
    bgls.push(WebGPU.getJsObject(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((bglPtr) + (4 * i)) >> 2), "loading")]));
  }
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "bindGroupLayouts": bgls
  };
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreatePipelineLayout(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createPipelineLayout(desc));
  return ptr;
};

var _wgpuDeviceCreateRenderPipeline = (devicePtr, descriptor) => {
  var desc = WebGPU.makeRenderPipelineDesc(descriptor);
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateRenderPipeline(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createRenderPipeline(desc));
  return ptr;
};

var _wgpuDeviceCreateSampler = (devicePtr, descriptor) => {
  var desc;
  if (descriptor) {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "addressModeU": WebGPU.AddressMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")]],
      "addressModeV": WebGPU.AddressMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")]],
      "addressModeW": WebGPU.AddressMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (20)) >> 2), "loading")]],
      "magFilter": WebGPU.FilterMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")]],
      "minFilter": WebGPU.FilterMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (28)) >> 2), "loading")]],
      "mipmapFilter": WebGPU.MipmapFilterMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (32)) >> 2), "loading")]],
      "lodMinClamp": HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (((descriptor) + (36)) >> 2), "loading")],
      "lodMaxClamp": HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (((descriptor) + (40)) >> 2), "loading")],
      "compare": WebGPU.CompareFunction[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (44)) >> 2), "loading")]],
      "maxAnisotropy": HEAPU16[SAFE_HEAP_INDEX(HEAPU16, (((descriptor) + (48)) >> 1), "loading")]
    };
  }
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateSampler(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createSampler(desc));
  return ptr;
};

var _wgpuDeviceCreateTexture = (devicePtr, descriptor) => {
  assert(descriptor);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
  var desc = {
    "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
    "size": WebGPU.makeExtent3D(descriptor + 28),
    "mipLevelCount": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (44)) >> 2), "loading")],
    "sampleCount": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (48)) >> 2), "loading")],
    "dimension": WebGPU.TextureDimension[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")]],
    "format": WebGPU.TextureFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (40)) >> 2), "loading")]],
    "usage": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")]
  };
  var viewFormatCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (52)) >> 2), "loading")];
  if (viewFormatCount) {
    var viewFormatsPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (56)) >> 2), "loading")];
    // viewFormatsPtr pointer to an array of TextureFormat which is an enum of size uint32_t
    desc["viewFormats"] = Array.from(HEAP32.subarray((((viewFormatsPtr) >> 2)), ((viewFormatsPtr + viewFormatCount * 4) >> 2)), format => WebGPU.TextureFormat[format]);
  }
  var device = WebGPU.getJsObject(devicePtr);
  var ptr = _emwgpuCreateTexture(0);
  WebGPU.Internals.jsObjectInsert(ptr, device.createTexture(desc));
  return ptr;
};

var _wgpuDeviceGetLimits = (devicePtr, limitsOutPtr) => {
  var device = WebGPU.getJsObject(devicePtr);
  WebGPU.fillLimitStruct(device.limits, limitsOutPtr);
  return 1;
};

var _wgpuDeviceHasFeature = (devicePtr, featureEnumValue) => {
  var device = WebGPU.getJsObject(devicePtr);
  return device.features.has(WebGPU.FeatureName[featureEnumValue]);
};

var _wgpuInstanceCreateSurface = (instancePtr, descriptor) => {
  assert(descriptor);
  var nextInChainPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")];
  assert(nextInChainPtr !== 0);
  assert(262144 === HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((nextInChainPtr) + (4)) >> 2), "loading")]);
  var sourceCanvasHTMLSelector = nextInChainPtr;
  assert(sourceCanvasHTMLSelector);
  assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((sourceCanvasHTMLSelector) >> 2), "loading")] === 0);
  var selectorPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((sourceCanvasHTMLSelector) + (8)) >> 2), "loading")];
  assert(selectorPtr);
  var canvas = findCanvasEventTarget(selectorPtr);
  var context = canvas.getContext("webgpu");
  assert(context);
  if (!context) return 0;
  context.surfaceLabelWebGPU = WebGPU.makeStringFromOptionalStringView(descriptor + 4);
  var ptr = _emwgpuCreateSurface(0);
  WebGPU.Internals.jsObjectInsert(ptr, context);
  return ptr;
};

var _wgpuQueueSubmit = (queuePtr, commandCount, commands) => {
  assert(commands % 4 === 0);
  var queue = WebGPU.getJsObject(queuePtr);
  var cmds = Array.from(HEAP32.subarray((((commands) >> 2)), ((commands + commandCount * 4) >> 2)), id => WebGPU.getJsObject(id));
  queue.submit(cmds);
};

function _wgpuQueueWriteBuffer(queuePtr, bufferPtr, bufferOffset, data, size) {
  bufferOffset = bigintToI53Checked(bufferOffset);
  var queue = WebGPU.getJsObject(queuePtr);
  var buffer = WebGPU.getJsObject(bufferPtr);
  // There is a size limitation for ArrayBufferView. Work around by passing in a subarray
  // instead of the whole heap. crbug.com/1201109
  var subarray = HEAPU8.subarray(data, data + size);
  queue.writeBuffer(buffer, bufferOffset, subarray, 0, size);
}

var _wgpuQueueWriteTexture = (queuePtr, destinationPtr, data, dataSize, dataLayoutPtr, writeSizePtr) => {
  var queue = WebGPU.getJsObject(queuePtr);
  var destination = WebGPU.makeTexelCopyTextureInfo(destinationPtr);
  var dataLayout = WebGPU.makeTexelCopyBufferLayout(dataLayoutPtr);
  var writeSize = WebGPU.makeExtent3D(writeSizePtr);
  // This subarray isn't strictly necessary, but helps work around an issue
  // where Chromium makes a copy of the entire heap. crbug.com/1134457
  var subarray = HEAPU8.subarray(data, data + dataSize);
  queue.writeTexture(destination, subarray, dataLayout, writeSize);
};

var _wgpuRenderPassEncoderDraw = (passPtr, vertexCount, instanceCount, firstVertex, firstInstance) => {
  assert(vertexCount >= 0);
  assert(instanceCount >= 0);
  firstVertex >>>= 0;
  firstInstance >>>= 0;
  var pass = WebGPU.getJsObject(passPtr);
  pass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
};

var _wgpuRenderPassEncoderDrawIndexed = (passPtr, indexCount, instanceCount, firstIndex, baseVertex, firstInstance) => {
  assert(indexCount >= 0);
  assert(instanceCount >= 0);
  firstIndex >>>= 0;
  firstInstance >>>= 0;
  var pass = WebGPU.getJsObject(passPtr);
  pass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
};

var _wgpuRenderPassEncoderEnd = encoderPtr => {
  var encoder = WebGPU.getJsObject(encoderPtr);
  encoder.end();
};

var _wgpuRenderPassEncoderSetBindGroup = (passPtr, groupIndex, groupPtr, dynamicOffsetCount, dynamicOffsetsPtr) => {
  assert(groupIndex >= 0);
  var pass = WebGPU.getJsObject(passPtr);
  var group = WebGPU.getJsObject(groupPtr);
  if (dynamicOffsetCount == 0) {
    pass.setBindGroup(groupIndex, group);
  } else {
    pass.setBindGroup(groupIndex, group, HEAPU32, ((dynamicOffsetsPtr) >> 2), dynamicOffsetCount);
  }
};

var _wgpuRenderPassEncoderSetBlendConstant = (passPtr, colorPtr) => {
  var pass = WebGPU.getJsObject(passPtr);
  var color = WebGPU.makeColor(colorPtr);
  pass.setBlendConstant(color);
};

function _wgpuRenderPassEncoderSetIndexBuffer(passPtr, bufferPtr, format, offset, size) {
  offset = bigintToI53Checked(offset);
  size = bigintToI53Checked(size);
  var pass = WebGPU.getJsObject(passPtr);
  var buffer = WebGPU.getJsObject(bufferPtr);
  if (size == -1) size = undefined;
  pass.setIndexBuffer(buffer, WebGPU.IndexFormat[format], offset, size);
}

var _wgpuRenderPassEncoderSetPipeline = (passPtr, pipelinePtr) => {
  var pass = WebGPU.getJsObject(passPtr);
  var pipeline = WebGPU.getJsObject(pipelinePtr);
  pass.setPipeline(pipeline);
};

var _wgpuRenderPassEncoderSetScissorRect = (passPtr, x, y, w, h) => {
  assert(x >= 0);
  assert(y >= 0);
  assert(w >= 0);
  assert(h >= 0);
  var pass = WebGPU.getJsObject(passPtr);
  pass.setScissorRect(x, y, w, h);
};

var _wgpuRenderPassEncoderSetStencilReference = (passPtr, reference) => {
  reference >>>= 0;
  var pass = WebGPU.getJsObject(passPtr);
  pass.setStencilReference(reference);
};

function _wgpuRenderPassEncoderSetVertexBuffer(passPtr, slot, bufferPtr, offset, size) {
  offset = bigintToI53Checked(offset);
  size = bigintToI53Checked(size);
  assert(slot >= 0);
  var pass = WebGPU.getJsObject(passPtr);
  var buffer = WebGPU.getJsObject(bufferPtr);
  if (size == -1) size = undefined;
  pass.setVertexBuffer(slot, buffer, offset, size);
}

var _wgpuRenderPassEncoderSetViewport = (passPtr, x, y, w, h, minDepth, maxDepth) => {
  var pass = WebGPU.getJsObject(passPtr);
  pass.setViewport(x, y, w, h, minDepth, maxDepth);
};

var _wgpuSurfaceConfigure = (surfacePtr, config) => {
  assert(config);
  var devicePtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (4)) >> 2), "loading")];
  var context = WebGPU.getJsObject(surfacePtr);
  var presentMode = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (44)) >> 2), "loading")];
  assert(presentMode === 1 || presentMode === 0);
  var canvasSize = [ HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (24)) >> 2), "loading")], HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (28)) >> 2), "loading")] ];
  if (canvasSize[0] !== 0) {
    context["canvas"]["width"] = canvasSize[0];
  }
  if (canvasSize[1] !== 0) {
    context["canvas"]["height"] = canvasSize[1];
  }
  var configuration = {
    "device": WebGPU.getJsObject(devicePtr),
    "format": WebGPU.TextureFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (8)) >> 2), "loading")]],
    "usage": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (16)) >> 2), "loading")],
    "alphaMode": WebGPU.CompositeAlphaMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (40)) >> 2), "loading")]]
  };
  var viewFormatCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (32)) >> 2), "loading")];
  if (viewFormatCount) {
    var viewFormatsPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((config) + (36)) >> 2), "loading")];
    // viewFormatsPtr pointer to an array of TextureFormat which is an enum of size uint32_t
    configuration["viewFormats"] = Array.from(HEAP32.subarray((((viewFormatsPtr) >> 2)), ((viewFormatsPtr + viewFormatCount * 4) >> 2)), format => WebGPU.TextureFormat[format]);
  }
  {
    var nextInChainPtr = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((config) >> 2), "loading")];
    if (nextInChainPtr !== 0) {
      var sType = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((nextInChainPtr) + (4)) >> 2), "loading")];
      assert(sType === 10);
      assert(0 === HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((nextInChainPtr) >> 2), "loading")]);
      var surfaceColorManagement = nextInChainPtr;
      assert(surfaceColorManagement);
      assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((surfaceColorManagement) >> 2), "loading")] === 0);
      configuration.colorSpace = WebGPU.PredefinedColorSpace[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((surfaceColorManagement) + (8)) >> 2), "loading")]];
      configuration.toneMapping = {
        mode: WebGPU.ToneMappingMode[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((surfaceColorManagement) + (12)) >> 2), "loading")]]
      };
    }
  }
  context.configure(configuration);
};

var _wgpuSurfaceGetCurrentTexture = (surfacePtr, surfaceTexturePtr) => {
  assert(surfaceTexturePtr);
  var context = WebGPU.getJsObject(surfacePtr);
  try {
    var texturePtr = _emwgpuCreateTexture(0);
    WebGPU.Internals.jsObjectInsert(texturePtr, context.getCurrentTexture());
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((surfaceTexturePtr) + (4)) >> 2), "storing")] = texturePtr;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((surfaceTexturePtr) + (8)) >> 2), "storing")] = 1;
    checkInt32(1);
  } catch (ex) {
    err(`wgpuSurfaceGetCurrentTexture() failed: ${ex}`);
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((surfaceTexturePtr) + (4)) >> 2), "storing")] = 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, (((surfaceTexturePtr) + (8)) >> 2), "storing")] = 6;
    checkInt32(6);
  }
};

var _wgpuTextureCreateView = (texturePtr, descriptor) => {
  var desc;
  if (descriptor) {
    assert(descriptor);
    assert(HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((descriptor) >> 2), "loading")] === 0);
    var mipLevelCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (24)) >> 2), "loading")];
    var arrayLayerCount = HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (32)) >> 2), "loading")];
    desc = {
      "label": WebGPU.makeStringFromOptionalStringView(descriptor + 4),
      "format": WebGPU.TextureFormat[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (12)) >> 2), "loading")]],
      "dimension": WebGPU.TextureViewDimension[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (16)) >> 2), "loading")]],
      "baseMipLevel": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (20)) >> 2), "loading")],
      "mipLevelCount": mipLevelCount === 4294967295 ? undefined : mipLevelCount,
      "baseArrayLayer": HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (28)) >> 2), "loading")],
      "arrayLayerCount": arrayLayerCount === 4294967295 ? undefined : arrayLayerCount,
      "aspect": WebGPU.TextureAspect[HEAPU32[SAFE_HEAP_INDEX(HEAPU32, (((descriptor) + (36)) >> 2), "loading")]]
    };
  }
  var texture = WebGPU.getJsObject(texturePtr);
  var ptr = _emwgpuCreateTextureView(0);
  WebGPU.Internals.jsObjectInsert(ptr, texture.createView(desc));
  return ptr;
};

var withStackSave = f => {
  var stack = stackSave();
  var ret = f();
  stackRestore(stack);
  return ret;
};

var FS_createPath = (...args) => FS.createPath(...args);

var FS_unlink = (...args) => FS.unlink(...args);

var FS_createLazyFile = (...args) => FS.createLazyFile(...args);

var FS_createDevice = (...args) => FS.createDevice(...args);

FS.createPreloadedFile = FS_createPreloadedFile;

FS.preloadFile = FS_preloadFile;

FS.staticInit();

assert(emval_handles.length === 5 * 2);

Module["requestAnimationFrame"] = MainLoop.requestAnimationFrame;

Module["pauseMainLoop"] = MainLoop.pause;

Module["resumeMainLoop"] = MainLoop.resume;

MainLoop.init();

// End JS library code
// include: postlibrary.js
// This file is included after the automatically-generated JS library code
// but before the wasm module is created.
{
  // Begin ATMODULES hooks
  if (Module["noExitRuntime"]) noExitRuntime = Module["noExitRuntime"];
  if (Module["preloadPlugins"]) preloadPlugins = Module["preloadPlugins"];
  if (Module["print"]) out = Module["print"];
  if (Module["printErr"]) err = Module["printErr"];
  if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];
  // End ATMODULES hooks
  checkIncomingModuleAPI();
  if (Module["arguments"]) arguments_ = Module["arguments"];
  if (Module["thisProgram"]) thisProgram = Module["thisProgram"];
  // Assertions on removed incoming Module JS APIs.
  assert(typeof Module["memoryInitializerPrefixURL"] == "undefined", "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["pthreadMainPrefixURL"] == "undefined", "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["cdInitializerPrefixURL"] == "undefined", "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["filePackagePrefixURL"] == "undefined", "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
  assert(typeof Module["read"] == "undefined", "Module.read option was removed");
  assert(typeof Module["readAsync"] == "undefined", "Module.readAsync option was removed (modify readAsync in JS)");
  assert(typeof Module["readBinary"] == "undefined", "Module.readBinary option was removed (modify readBinary in JS)");
  assert(typeof Module["setWindowTitle"] == "undefined", "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
  assert(typeof Module["TOTAL_MEMORY"] == "undefined", "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
  assert(typeof Module["ENVIRONMENT"] == "undefined", "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
  assert(typeof Module["STACK_SIZE"] == "undefined", "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
  // If memory is defined in wasm, the user can't provide it, or set INITIAL_MEMORY
  assert(typeof Module["wasmMemory"] == "undefined", "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
  assert(typeof Module["INITIAL_MEMORY"] == "undefined", "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
  if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
    while (Module["preInit"].length > 0) {
      Module["preInit"].shift()();
    }
  }
  consumedModuleProp("preInit");
}

// Begin runtime exports
Module["addRunDependency"] = addRunDependency;

Module["removeRunDependency"] = removeRunDependency;

Module["FS_preloadFile"] = FS_preloadFile;

Module["FS_unlink"] = FS_unlink;

Module["FS_createPath"] = FS_createPath;

Module["FS_createDevice"] = FS_createDevice;

Module["FS_createDataFile"] = FS_createDataFile;

Module["FS_createLazyFile"] = FS_createLazyFile;

var missingLibrarySymbols = [ "writeI53ToI64", "writeI53ToI64Clamped", "writeI53ToI64Signaling", "writeI53ToU64Clamped", "writeI53ToU64Signaling", "readI53FromU64", "convertI32PairToI53", "convertI32PairToI53Checked", "convertU32PairToI53", "getTempRet0", "setTempRet0", "createNamedFunction", "zeroMemory", "inetPton4", "inetNtop4", "inetPton6", "inetNtop6", "readSockaddr", "writeSockaddr", "runMainThreadEmAsm", "jstoi_q", "autoResumeAudioContext", "getDynCaller", "dynCall", "setWasmTableEntry", "runtimeKeepalivePush", "runtimeKeepalivePop", "asmjsMangle", "HandleAllocator", "addOnInit", "addOnPostCtor", "addOnPreMain", "STACK_SIZE", "STACK_ALIGN", "POINTER_SIZE", "ASSERTIONS", "ccall", "cwrap", "convertJsFunctionToWasm", "getEmptyTableSlot", "updateTableMap", "getFunctionAddress", "addFunction", "removeFunction", "intArrayToString", "stringToAscii", "writeArrayToMemory", "fillDeviceMotionEventData", "registerDeviceMotionEventCallback", "screenOrientation", "fillOrientationChangeEventData", "registerOrientationChangeEventCallback", "JSEvents_requestFullscreen", "JSEvents_resizeCanvasForFullscreen", "registerRestoreOldStyle", "hideEverythingExceptGivenElement", "restoreHiddenElements", "setLetterbox", "softFullscreenResizeWebGLRenderTarget", "doRequestFullscreen", "requestPointerLock", "fillVisibilityChangeEventData", "registerVisibilityChangeEventCallback", "fillGamepadEventData", "registerGamepadEventCallback", "registerBeforeUnloadEventCallback", "fillBatteryEventData", "registerBatteryEventCallback", "setCanvasElementSize", "getCanvasElementSize", "jsStackTrace", "getCallstack", "convertPCtoSourceLocation", "checkWasiClock", "wasiRightsToMuslOFlags", "wasiOFlagsToMuslOFlags", "safeSetTimeout", "setImmediateWrapped", "safeRequestAnimationFrame", "clearImmediateWrapped", "registerPostMainLoop", "registerPreMainLoop", "getPromise", "makePromise", "idsToPromises", "makePromiseCallback", "ExceptionInfo", "findMatchingCatch", "Browser_asyncPrepareDataCounter", "arraySum", "addDays", "getSocketFromFD", "getSocketAddress", "FS_mkdirTree", "_setNetworkCallback", "heapObjectForWebGLType", "toTypedArrayIndex", "webgl_enable_ANGLE_instanced_arrays", "webgl_enable_OES_vertex_array_object", "webgl_enable_WEBGL_draw_buffers", "webgl_enable_WEBGL_multi_draw", "webgl_enable_EXT_polygon_offset_clamp", "webgl_enable_EXT_clip_control", "webgl_enable_WEBGL_polygon_mode", "emscriptenWebGLGet", "computeUnpackAlignedImageSize", "colorChannelsInGlTextureFormat", "emscriptenWebGLGetTexPixelData", "emscriptenWebGLGetUniform", "webglGetUniformLocation", "webglPrepareUniformLocationsBeforeFirstUse", "webglGetLeftBracePos", "emscriptenWebGLGetVertexAttrib", "__glGetActiveAttribOrUniform", "writeGLArray", "registerWebGlEventCallback", "runAndAbortIfError", "ALLOC_NORMAL", "ALLOC_STACK", "allocate", "writeStringToMemory", "writeAsciiToMemory", "allocateUTF8", "allocateUTF8OnStack", "demangle", "stackTrace", "getNativeTypeSize", "throwInternalError", "whenDependentTypesAreResolved", "getTypeName", "getFunctionName", "getFunctionArgsName", "heap32VectorToArray", "requireRegisteredType", "usesDestructorStack", "createJsInvokerSignature", "checkArgCount", "getEnumValueType", "getRequiredArgCount", "createJsInvoker", "UnboundTypeError", "PureVirtualError", "throwUnboundTypeError", "ensureOverloadTable", "exposePublicSymbol", "replacePublicSymbol", "getBasestPointer", "registerInheritedInstance", "unregisterInheritedInstance", "getInheritedInstance", "getInheritedInstanceCount", "getLiveInheritedInstances", "enumReadValueFromPointer", "installIndexedIterator", "runDestructors", "craftInvokerFunction", "embind__requireFunction", "genericPointerToWireType", "constNoSmartPtrRawPointerToWireType", "nonConstNoSmartPtrRawPointerToWireType", "init_RegisteredPointer", "RegisteredPointer", "RegisteredPointer_fromWireType", "runDestructor", "releaseClassHandle", "detachFinalizer", "attachFinalizer", "makeClassHandle", "init_ClassHandle", "ClassHandle", "throwInstanceAlreadyDeleted", "flushPendingDeletes", "setDelayFunction", "RegisteredClass", "shallowCopyInternalPointer", "downcastPointer", "upcastPointer", "validateThis", "char_0", "char_9", "makeLegalFunctionName", "count_emval_handles", "getStringOrSymbol", "emval_returnValue", "emval_lookupTypes", "emval_addMethodCaller" ];

missingLibrarySymbols.forEach(missingLibrarySymbol);

var unexportedSymbols = [ "run", "out", "err", "callMain", "abort", "wasmExports", "HEAPF32", "HEAPF64", "HEAP8", "HEAPU8", "HEAP16", "HEAPU16", "HEAP32", "HEAPU32", "HEAP64", "HEAPU64", "writeStackCookie", "checkStackCookie", "readI53FromI64", "INT53_MAX", "INT53_MIN", "bigintToI53Checked", "stackSave", "stackRestore", "stackAlloc", "ptrToString", "exitJS", "getHeapMax", "growMemory", "ENV", "setStackLimits", "withStackSave", "ERRNO_CODES", "strError", "DNS", "Protocols", "Sockets", "timers", "warnOnce", "readEmAsmArgsArray", "readEmAsmArgs", "runEmAsmFunction", "getExecutableName", "getWasmTableEntry", "handleException", "keepRuntimeAlive", "callUserCallback", "maybeExit", "asyncLoad", "alignMemory", "mmapAlloc", "wasmTable", "wasmMemory", "getUniqueRunDependency", "noExitRuntime", "addOnPreRun", "addOnExit", "addOnPostRun", "freeTableIndexes", "functionsInTableMap", "setValue", "getValue", "PATH", "PATH_FS", "UTF8Decoder", "UTF8ArrayToString", "UTF8ToString", "stringToUTF8Array", "stringToUTF8", "lengthBytesUTF8", "intArrayFromString", "AsciiToString", "UTF16Decoder", "UTF16ToString", "stringToUTF16", "lengthBytesUTF16", "UTF32ToString", "stringToUTF32", "lengthBytesUTF32", "stringToNewUTF8", "stringToUTF8OnStack", "JSEvents", "registerKeyEventCallback", "specialHTMLTargets", "maybeCStringToJsString", "findEventTarget", "findCanvasEventTarget", "getBoundingClientRect", "fillMouseEventData", "registerMouseEventCallback", "registerWheelEventCallback", "registerUiEventCallback", "registerFocusEventCallback", "fillDeviceOrientationEventData", "registerDeviceOrientationEventCallback", "fillFullscreenChangeEventData", "registerFullscreenChangeEventCallback", "currentFullscreenStrategy", "restoreOldWindowedStyle", "fillPointerlockChangeEventData", "registerPointerlockChangeEventCallback", "registerPointerlockErrorEventCallback", "registerTouchEventCallback", "UNWIND_CACHE", "ExitStatus", "getEnvStrings", "doReadv", "doWritev", "initRandomFill", "randomFill", "emSetImmediate", "emClearImmediate_deps", "emClearImmediate", "promiseMap", "uncaughtExceptionCount", "exceptionLast", "exceptionCaught", "Browser", "requestFullscreen", "requestFullScreen", "setCanvasSize", "getUserMedia", "createContext", "getPreloadedImageData__data", "wget", "MONTH_DAYS_REGULAR", "MONTH_DAYS_LEAP", "MONTH_DAYS_REGULAR_CUMULATIVE", "MONTH_DAYS_LEAP_CUMULATIVE", "isLeapYear", "ydayFromDate", "SYSCALLS", "preloadPlugins", "FS_createPreloadedFile", "FS_modeStringToFlags", "FS_getMode", "FS_stdin_getChar_buffer", "FS_stdin_getChar", "FS_readFile", "FS", "FS_root", "FS_mounts", "FS_devices", "FS_streams", "FS_nextInode", "FS_nameTable", "FS_currentPath", "FS_initialized", "FS_ignorePermissions", "FS_filesystems", "FS_syncFSRequests", "FS_lookupPath", "FS_getPath", "FS_hashName", "FS_hashAddNode", "FS_hashRemoveNode", "FS_lookupNode", "FS_createNode", "FS_destroyNode", "FS_isRoot", "FS_isMountpoint", "FS_isFile", "FS_isDir", "FS_isLink", "FS_isChrdev", "FS_isBlkdev", "FS_isFIFO", "FS_isSocket", "FS_flagsToPermissionString", "FS_nodePermissions", "FS_mayLookup", "FS_mayCreate", "FS_mayDelete", "FS_mayOpen", "FS_checkOpExists", "FS_nextfd", "FS_getStreamChecked", "FS_getStream", "FS_createStream", "FS_closeStream", "FS_dupStream", "FS_doSetAttr", "FS_chrdev_stream_ops", "FS_major", "FS_minor", "FS_makedev", "FS_registerDevice", "FS_getDevice", "FS_getMounts", "FS_syncfs", "FS_mount", "FS_unmount", "FS_lookup", "FS_mknod", "FS_statfs", "FS_statfsStream", "FS_statfsNode", "FS_create", "FS_mkdir", "FS_mkdev", "FS_symlink", "FS_rename", "FS_rmdir", "FS_readdir", "FS_readlink", "FS_stat", "FS_fstat", "FS_lstat", "FS_doChmod", "FS_chmod", "FS_lchmod", "FS_fchmod", "FS_doChown", "FS_chown", "FS_lchown", "FS_fchown", "FS_doTruncate", "FS_truncate", "FS_ftruncate", "FS_utime", "FS_open", "FS_close", "FS_isClosed", "FS_llseek", "FS_read", "FS_write", "FS_mmap", "FS_msync", "FS_ioctl", "FS_writeFile", "FS_cwd", "FS_chdir", "FS_createDefaultDirectories", "FS_createDefaultDevices", "FS_createSpecialDirectories", "FS_createStandardStreams", "FS_staticInit", "FS_init", "FS_quit", "FS_findObject", "FS_analyzePath", "FS_createFile", "FS_forceLoadFile", "FS_absolutePath", "FS_createFolder", "FS_createLink", "FS_joinPath", "FS_mmapAlloc", "FS_standardizePath", "MEMFS", "TTY", "PIPEFS", "SOCKFS", "tempFixedLengthArray", "miniTempWebGLFloatBuffers", "miniTempWebGLIntBuffers", "GL", "AL", "GLUT", "EGL", "GLEW", "IDBStore", "SDL", "SDL_gfx", "print", "printErr", "jstoi_s", "InternalError", "BindingError", "throwBindingError", "registeredTypes", "awaitingDependencies", "typeDependencies", "tupleRegistrations", "structRegistrations", "sharedRegisterType", "EmValType", "EmValOptionalType", "embindRepr", "registeredInstances", "registeredPointers", "registerType", "integerReadValueFromPointer", "floatReadValueFromPointer", "assertIntegerRange", "readPointer", "finalizationRegistry", "detachFinalizer_deps", "deletionQueue", "delayFunction", "emval_freelist", "emval_handles", "emval_symbols", "Emval", "emval_methodCallers", "IDBFS", "WebGPU", "emwgpuStringToInt_BufferMapState", "emwgpuStringToInt_CompilationMessageType", "emwgpuStringToInt_DeviceLostReason", "emwgpuStringToInt_FeatureName", "emwgpuStringToInt_PreferredFormat" ];

unexportedSymbols.forEach(unexportedRuntimeSymbol);

// End runtime exports
// Begin JS library exports
// End JS library exports
// end include: postlibrary.js
function checkIncomingModuleAPI() {
  ignoredModuleProp("fetchSettings");
  ignoredModuleProp("logReadFiles");
  ignoredModuleProp("loadSplitModule");
}

var ASM_CONSTS = {
  941771: () => (Module.__winmod_last_buttons | 0) === 0 ? 1 : 0,
  941832: $0 => {
    var sw = (window.screen && window.screen.width) ? window.screen.width : window.innerWidth;
    var sh = (window.screen && window.screen.height) ? window.screen.height : window.innerHeight;
    if (!sw) sw = window.innerWidth;
    if (!sh) sh = window.innerHeight;
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, $0 >> 3, "storing")] = window.devicePixelRatio || 1;
    HEAPF64[SAFE_HEAP_INDEX(HEAPF64, ($0 >> 3) + 1, "storing")] = Math.min(sw, sh);
  },
  942180: () => {
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 1;
    if (window.matchMedia) {
      if (window.matchMedia("(pointer: coarse)").matches) return 1;
      if (window.matchMedia("(hover: none)").matches) return 1;
    }
    if (navigator.maxTouchPoints > 0 && !(window.matchMedia && window.matchMedia("(pointer: fine)").matches && window.matchMedia("(hover: hover)").matches)) return 1;
    return 0;
  },
  942593: () => {
    if (window.matchMedia) {
      if (window.matchMedia("(pointer: fine)").matches && window.matchMedia("(hover: hover)").matches) return 1;
    }
    return 0;
  },
  942738: ($0, $1, $2, $3, $4, $5, $6, $7, $8) => {
    var t = Module.phone_orientation;
    if (!t) return 0;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, $0 >> 2, "storing")] = t.a;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, $1 >> 2, "storing")] = t.b;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, $2 >> 2, "storing")] = t.g;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $3 >> 2, "storing")] = t.n | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $4 >> 2, "storing")] = t.secure | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $5 >> 2, "storing")] = t.screen | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $6 >> 2, "storing")] = t.manual | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $7 >> 2, "storing")] = t.android | 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, $8 >> 2, "storing")] = t.lock_rc | 0;
    return t.active ? 1 : 0;
  },
  943030: ($0, $1) => {
    try {
      var params = new URLSearchParams(String(location.search || ""));
      var code = params.get("c") || params.get("branch") || "";
      if (!code) return 0;
      stringToUTF8(code, $0, $1);
      return 1;
    } catch (e) {
      return 0;
    }
  },
  943243: ($0, $1) => {
    var u = "https://spinview.app/Numeris/";
    try {
      if (typeof location !== "undefined" && location.origin && location.pathname) u = location.origin + location.pathname;
    } catch (e) {}
    stringToUTF8(u, $0, $1);
  },
  943447: ($0, $1, $2) => {
    var ptr = $0;
    var len = $1;
    var name = UTF8ToString($2);
    var bytes = HEAPU8.slice(ptr, ptr + len);
    var blob = new Blob([ bytes ], {
      type: "image/png"
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  },
  943805: () => {
    try {
      return /(?:^|[?&])gui(?:[=&]|$)/i.test(String(location.search || "")) ? 1 : 0;
    } catch (e) {
      return 0;
    }
  }
};

function simgui_js_is_osx() {
  if (navigator.userAgent.includes("Macintosh")) {
    return 1;
  } else {
    return 0;
  }
}

function js_request_device_orientation_permission() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(function(state) {
        console.log("DeviceOrientation permission:", state);
      }).catch(function(err) {
        console.log("DeviceOrientation permission error:", err);
      });
    }
  } catch (e) {
    console.log("Permission request failed:", e);
  }
}

function emsc_mount_config_fs() {
  function mountOne(path) {
    try {
      FS.mkdir(path);
    } catch (e) {}
    try {
      FS.mount(IDBFS, {
        autoPersist: true
      }, path);
      console.log("IDBFS mounted on " + path);
    } catch (e) {
      console.error("IDBFS mount failed on " + path + ":", e);
    }
  }
  mountOne("/config");
  mountOne("/session");
}

function emsc_sync_config_fs_load() {
  try {
    FS.syncfs(true, function(err) {
      if (err) {
        console.error("syncfs load failed:", err);
        _emsc_on_config_fs_failed();
        return;
      }
      console.log("syncfs load success");
      _emsc_on_config_fs_ready();
    });
  } catch (e) {
    console.error("syncfs exception:", e);
    _emsc_on_config_fs_failed();
  }
}

function phone_cam_tilt_js_setup() {
  if (Module.phone_orientation_ready) return;
  Module.phone_orientation_ready = true;
  var screenAngle = function() {
    var a = 0;
    if (screen.orientation && typeof screen.orientation.angle === "number") a = screen.orientation.angle; else if (typeof window.orientation === "number") a = window.orientation;
    a = ((Math.round(a / 90) * 90) % 360 + 360) % 360;
    return a;
  };
  var t = Module.phone_orientation = {
    a: 0,
    b: 0,
    g: 0,
    active: 0,
    n: 0,
    secure: window.isSecureContext ? 1 : 0,
    android: (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")) ? 1 : 0,
    lock: 0,
    lock_rc: 0,
    perm: "",
    motionPerm: "",
    screen: screenAngle(),
    manual: 0,
    gx: 0,
    gy: 0,
    gz: 1,
    gravity: 0
  };
  var updateManualRotation = function(x, y, z) {
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len < 1e-5) return;
    x /= len;
    y /= len;
    z /= len;
    var ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    var cur = t.manual | 0, next = cur;
    if (!(az > Math.max(ax, ay) * 1.2)) {
      var landscape;
      if (cur === 1 || cur === 3) landscape = !(ay > ax * .7); else landscape = ax > ay * .7;
      if (!landscape) next = y >= 0 ? 0 : 2; else next = x >= 0 ? 3 : 1;
      if (Math.abs(ax - ay) < .05) next = cur;
    }
    if (next !== cur) {
      t.manual = next;
      t.screen = [ 0, 90, 180, 270 ][next];
    }
  };
  var onMotion = function(ev) {
    var a = ev.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    var k = .85;
    if (!t.gravity) {
      t.gx = +a.x;
      t.gy = +a.y;
      t.gz = +a.z;
      t.gravity = 1;
    } else {
      t.gx = k * t.gx + (1 - k) * (+a.x);
      t.gy = k * t.gy + (1 - k) * (+a.y);
      t.gz = k * t.gz + (1 - k) * (+a.z);
    }
    updateManualRotation(t.gx, t.gy, t.gz);
  };
  var onOrientation = function(ev) {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    t.a = +ev.alpha;
    t.b = +ev.beta;
    t.g = +ev.gamma;
    if (!t.gravity) t.screen = screenAngle();
    t.active = 1;
    t.n++;
  };
  var onScreenChange = function() {
    if (!t.gravity) t.screen = screenAngle();
  };
  var lockCurrentOrientation = function() {
    if (!t.lock || !t.android) return;
    try {
      if (!screen.orientation || typeof screen.orientation.lock !== "function") {
        t.lock_rc = -2;
        return;
      }
      var type = String(screen.orientation.type || "");
      var target = type.indexOf("landscape") === 0 ? "landscape" : (type.indexOf("portrait") === 0 ? "portrait" : (innerWidth >= innerHeight ? "landscape" : "portrait"));
      screen.orientation.lock(target).then(function() {
        t.lock_rc = 1;
      }).catch(function() {
        t.lock_rc = -1;
      });
    } catch (e) {
      t.lock_rc = -1;
    }
  };
  Module.phone_orientation_lock_current = lockCurrentOrientation;
  window.addEventListener("deviceorientation", onOrientation, true);
  window.addEventListener("devicemotion", onMotion, true);
  window.addEventListener("orientationchange", onScreenChange, true);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener("change", onScreenChange);
  var askPermission = function() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
        DeviceOrientationEvent.requestPermission().then(function(v) {
          t.perm = v;
        });
      } else t.perm = "n/a";
      if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
        DeviceMotionEvent.requestPermission().then(function(v) {
          t.motionPerm = v;
        });
      } else t.motionPerm = "n/a";
    } catch (e) {}
    lockCurrentOrientation();
  };
  Module.phone_orientation_ask = askPermission;
  window.addEventListener("pointerdown", askPermission, {
    capture: true,
    once: true
  });
  window.addEventListener("touchstart", askPermission, {
    capture: true,
    once: true
  });
  console.log("[phone_orientation] quaternion tilt ready; secure=" + t.secure + " android=" + t.android);
}

function phone_cam_tilt_js_ask_permission() {
  if (Module.phone_orientation_ask) Module.phone_orientation_ask();
}

function phone_cam_tilt_js_set_lock(on) {
  var t = Module.phone_orientation;
  if (!t) return;
  t.lock = on ? 1 : 0;
  try {
    if (t.lock && Module.phone_orientation_lock_current) Module.phone_orientation_lock_current(); else if (!t.lock && screen.orientation && typeof screen.orientation.unlock === "function") screen.orientation.unlock();
  } catch (e) {
    t.lock_rc = -1;
  }
}

function sound_worker_proto_js_start(stall_ms, width, synth_rate, unlock_fade_ms) {
  if (Module.sound_worker_proto && Module.sound_worker_proto.bus) return 1;
  Module.sound_worker_proto = {
    ready: 0,
    ok: 0,
    audio_ready: 0,
    error: "",
    starting: 1,
    stats: {
      n: 0,
      last_ms: 0,
      avg_ms: 0,
      max_ms: 0,
      stall_ms: 0,
      sample0: 0,
      pcm_blocks: 0,
      underruns: 0,
      queued_frames: 0
    }
  };
  function loc(name) {
    try {
      return (Module.locateFile ? Module.locateFile(name) : name);
    } catch (e) {
      return name;
    }
  }
  function loadScript(url) {
    return new Promise(function(resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = function() {
        resolve();
      };
      s.onerror = function() {
        reject(new Error("load " + url));
      };
      document.head.appendChild(s);
    });
  }
  function bindBus(bus) {
    var st = Module.sound_worker_proto;
    st.bus = bus;
    st.ok = bus.ok ? 1 : 0;
    if (bus.error) st.error = bus.error;
    if (!st._gestureBound) {
      st._gestureBound = 1;
      var unlock = function(ev) {
        var active = st.bus;
        var ctx0 = active && active.audioCtx;
        if (!active || active._retired || (!active.worker && !active.mainThreadPcm)) return;
        if (active._startPromise) {
          try {
            if (typeof active.primeGesture === "function") active.primeGesture();
            if (ctx0 && ctx0.state === "suspended") {
              var retryResume = ctx0.resume();
              if (retryResume && typeof retryResume.catch === "function") retryResume.catch(function() {});
            }
          } catch (eRetry) {}
          return;
        }
        if (active.audioReady && ctx0 && ctx0.state === "running" && (active.scriptNode || active.worklet)) return;
        var t = (ev && ev.type) ? ev.type : "gesture";
        if (!st.last_unlock_event || st.last_unlock_event === "none" || t === "pointerdown" || t === "touchstart" || t === "keydown") st.last_unlock_event = t;
        if (!active.startAudio) return;
        try {
          if (typeof active.primeGesture === "function") active.primeGesture();
        } catch (ePg) {}
        console.log("[sound_proto2] unlock via " + t);
        active.startAudio().then(function() {
          var c = active.audioCtx;
          if (c && c.state === "running" && (active.scriptNode || active.worklet)) {
            st.audio_ready = 1;
            console.log("[sound_proto2] audio running via " + (st.last_unlock_event || t) + " path=" + (active.audioPath || "?") + " gain=" + (active.outputGain ? active.outputGain.gain.value : "?"));
          } else {
            st.audio_ready = 0;
            console.warn("[sound_proto2] unlock incomplete ctx=" + (c ? c.state : "none") + " sink=" + (active.scriptNode ? "script" : active.worklet ? "worklet" : "none"));
          }
        }).catch(function(err) {
          st.audio_ready = 0;
          st.error = String(err && err.message ? err.message : err);
          console.error("[sound_proto2] audio", st.error);
        });
      };
      var optsCap = {
        capture: true
      };
      var optsTouch = {
        capture: true,
        passive: true
      };
      st._unlock = unlock;
      st._unlockOptsCap = optsCap;
      st._unlockOptsTouch = optsTouch;
      window.addEventListener("pointerdown", unlock, optsCap);
      window.addEventListener("touchstart", unlock, optsTouch);
      document.addEventListener("pointerdown", unlock, optsCap);
      document.addEventListener("touchstart", unlock, optsTouch);
      window.addEventListener("touchend", unlock, optsTouch);
      window.addEventListener("click", unlock, optsCap);
      window.addEventListener("keydown", unlock, optsCap);
    }
  }
  function onReady(bus, msg) {
    var st = Module.sound_worker_proto;
    st.ready = 1;
    st.ok = 1;
    st.renderer = (msg && msg.renderer) || bus.renderer || "";
    st.stats = st.stats || {};
    if (msg && msg.backend) st.stats.backend = String(msg.backend); else if (bus.stats && bus.stats.backend) st.stats.backend = String(bus.stats.backend);
    console.log("[sound_proto2] Sokol PCM bus ready", st.renderer, st.stats.backend || "");
  }
  function onStats(bus) {
    var st = Module.sound_worker_proto;
    if (st.bus && st.bus !== bus) return;
    var s = bus.stats || {};
    st.stats.n = s.n | 0;
    st.stats.last_ms = +s.last_ms || 0;
    st.stats.avg_ms = +s.avg_ms || 0;
    st.stats.max_ms = +s.max_ms || 0;
    st.stats.stall_ms = +s.stall_ms || 0;
    st.stats.sample0 = s.sample0 | 0;
    st.stats.pcm_blocks = s.pcm_blocks | 0;
    if (s.backend != null) st.stats.backend = String(s.backend);
    if (s.underruns != null) st.stats.underruns = s.underruns | 0;
    if (s.underrunFrames != null) st.stats.underrun_frames = s.underrunFrames | 0;
    if (s.maxGapMs != null) st.stats.max_gap_ms = +s.maxGapMs || 0;
    if (s.minQueuedFrames != null) st.stats.min_queued_frames = s.minQueuedFrames | 0;
    if (s.fillWaitMs != null) st.stats.fill_wait_ms = +s.fillWaitMs || 0;
    if (s.fillWaitMaxMs != null) st.stats.fill_wait_max_ms = +s.fillWaitMaxMs || 0;
    if (s.bufferBoostFrames != null) st.stats.buffer_boost_frames = s.bufferBoostFrames | 0;
    if (s.voices != null) st.stats.voices = s.voices | 0;
    if (s.queuedFrames != null) st.stats.queued_frames = s.queuedFrames | 0; else if (s.queued_est != null && !(bus.audioPath && bus.audioPath.indexOf("worklet") === 0)) st.stats.queued_frames = s.queued_est | 0;
    st.stats.synth_rate = (bus.synthRate | 0) || (s.synthRate | 0) || (s.synth_rate | 0) || 0;
    st.stats.output_rate = (bus.sampleRate | 0) || (s.outputRate | 0) || (s.output_rate | 0) || 0;
    if (s.synthLastMs != null) st.stats.synth_last_ms = +s.synthLastMs || 0;
    if (s.synthAvgMs != null) st.stats.synth_avg_ms = +s.synthAvgMs || 0;
    if (s.synthMaxMs != null) st.stats.synth_max_ms = +s.synthMaxMs || 0;
    if (s.workerFillLastMs != null) st.stats.worker_fill_last_ms = +s.workerFillLastMs || 0;
    if (s.workerFillMaxMs != null) st.stats.worker_fill_max_ms = +s.workerFillMaxMs || 0;
    if (s.gpuRequestFrames != null) st.stats.gpu_request_frames = s.gpuRequestFrames | 0;
    if (s.gpuRequestMaxFrames != null) st.stats.gpu_request_max_frames = s.gpuRequestMaxFrames | 0;
    if (s.pumpLateLastMs != null) st.stats.pump_late_last_ms = +s.pumpLateLastMs || 0;
    if (s.pumpLateMaxMs != null) st.stats.pump_late_max_ms = +s.pumpLateMaxMs || 0;
    if (s.pumpLateCount != null) st.stats.pump_late_count = s.pumpLateCount | 0;
    if (s.staleNeeds != null) st.stats.stale_needs = s.staleNeeds | 0;
  }
  function onError(bus, msg) {
    var st = Module.sound_worker_proto;
    if (st.bus && st.bus !== bus) return;
    st.ok = 0;
    st.ready = 0;
    st.error = bus.error || ((msg && msg.reason) ? msg.reason : "error");
    if (msg && msg.detail && st.error.indexOf(msg.detail) < 0) st.error += ":" + msg.detail;
    console.error("[sound_proto2]", st.error);
  }
  (async function() {
    var st = Module.sound_worker_proto;
    try {
      if (!Module.SoundBus && !Module.SoundBusProto) await loadScript(loc("sound_bus.js") + "?v=sokol-main1");
      var api = Module.SoundBus || Module.SoundBusProto || (typeof SoundBus !== "undefined" ? SoundBus : null) || (typeof SoundBusProto !== "undefined" ? SoundBusProto : null);
      if (!api || !api.create) throw new Error("SoundBus missing");
      var bus = api.create({
        width: width > 0 ? width : 1024,
        height: 1,
        stallMs: stall_ms > 0 ? stall_ms : 0,
        mainThreadPcm: true,
        inlineSynth: false,
        preferWorklet: true,
        synthRate: synth_rate > 0 ? synth_rate : 48e3,
        unlockFadeSec: unlock_fade_ms > 0 ? unlock_fade_ms / 1e3 : .02,
        onReady,
        onStats,
        onAudioStats: onStats,
        onError,
        onAudioReady: function() {
          Module.sound_worker_proto.audio_ready = 1;
          var b = Module.sound_worker_proto.bus || {};
          var st = Module.sound_worker_proto;
          st.stats = st.stats || {};
          st.stats.synth_rate = b.synthRate | 0;
          st.stats.output_rate = b.sampleRate | 0;
          var p = b.audioPath || "";
          var cfg = b.synthRate || 0;
          var dev = b.sampleRate || 0;
          var conv = b.convertPath || "";
          console.log("[sound_proto2] audio ready path=" + p + " config=" + cfg + "Hz device=" + dev + "Hz " + conv);
        }
      });
      bindBus(bus);
      if (bus.error) throw new Error(bus.error);
      st.starting = 0;
      console.log("[sound_proto2] bus started; click/tap to unlock audio");
    } catch (err) {
      st.starting = 0;
      st.error = String(err && err.message ? err.message : err);
      console.error("[sound_proto2] start failed", st.error);
    }
  })();
  return 1;
}

function sound_worker_proto_js_stop_all() {
  var st = Module.sound_worker_proto;
  if (st && st.bus && st.bus.stopAll) st.bus.stopAll();
}

function sound_worker_proto_js_set_echo(delay_ms, feedback, mix) {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.setEcho) return;
  st.bus.setEcho(delay_ms, feedback, mix);
}

function sound_worker_proto_js_set_master(vol) {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.setMaster) return;
  st.bus.setMaster(vol);
}

function sound_worker_proto_js_capture_audio(seconds) {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.captureAudio) return;
  st.bus.captureAudio(seconds > 0 ? seconds : 5);
}

function sound_worker_proto_js_capture_status() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.captureAudio) return -1;
  var s = st.bus.captureState || "idle";
  if (s === "requested" || s === "recording") return 1;
  if (s === "ready") return 2;
  return 0;
}

function sound_worker_proto_js_begin_graceful_shutdown() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus) return;
  if (typeof st.bus.beginGracefulShutdown === "function") st.bus.beginGracefulShutdown("shutdown"); else if (typeof st.bus.softMuteTeardown === "function") st.bus.softMuteTeardown("shutdown");
}

function sound_worker_proto_js_graceful_shutdown_sync() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus) return;
  if (typeof st.bus.gracefulTeardownSync === "function") st.bus.gracefulTeardownSync("shutdown"); else if (typeof st.bus.softMuteTeardown === "function") st.bus.softMuteTeardown("shutdown");
}

function sound_worker_proto_js_audio_ready() {
  var st = Module.sound_worker_proto;
  return (st && st.audio_ready) ? 1 : 0;
}

function sound_worker_proto_js_output_audible() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus) return 0;
  if (typeof st.bus.isOutputAudible === "function") return st.bus.isOutputAudible() ? 1 : 0;
  return (st.audio_ready && st.bus._outputFadedIn && !st.bus._backgroundMuted) ? 1 : 0;
}

function sound_worker_proto_js_audio_time() {
  var st = Module.sound_worker_proto;
  var ctx = st && st.bus && st.bus.audioCtx;
  return (ctx && ctx.state === "running") ? +ctx.currentTime : -1;
}

function sound_worker_proto_js_page_hidden() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return 1;
  return 0;
}

function sound_worker_proto_js_page_inactive() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus) return 0;
  if (typeof st.bus.isBackgroundInactive === "function") return st.bus.isBackgroundInactive() ? 1 : 0;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return 1;
  return (st.bus._backgroundMuted || st.bus._backgroundPausing) ? 1 : 0;
}

function sound_worker_proto_js_has_bus() {
  var st = Module.sound_worker_proto;
  return (st && st.bus) ? 1 : 0;
}

function sound_worker_proto_js_start_audio() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.startAudio) return;
  st.last_unlock_event = "hud";
  st.bus.startAudio().then(function() {
    st.audio_ready = 1;
  }).catch(function(err) {
    st.error = String(err && err.message ? err.message : err);
  });
}

function sound_worker_proto_js_expect_frames() {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.expectFrames) return 0;
  return st.bus.expectFrames() | 0;
}

function sound_worker_proto_js_push_pcm(pcm, frames) {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.pushPcm || frames <= 0) return;
  var samples = HEAPF32.slice(pcm >> 2, (pcm >> 2) + (frames << 1));
  st.bus.pushPcm(samples, frames | 0);
}

function sound_worker_proto_js_stop() {
  var st = Module.sound_worker_proto;
  if (!st) return;
  if (st._unlock) {
    try {
      var u = st._unlock;
      var cap = st._unlockOptsCap || true;
      var touch = st._unlockOptsTouch || {
        capture: true,
        passive: true
      };
      window.removeEventListener("pointerdown", u, cap);
      window.removeEventListener("touchstart", u, touch);
      document.removeEventListener("pointerdown", u, cap);
      document.removeEventListener("touchstart", u, touch);
      window.removeEventListener("touchend", u, touch);
      window.removeEventListener("click", u, cap);
      window.removeEventListener("keydown", u, cap);
    } catch (eUn) {}
    st._unlock = null;
    st._gestureBound = 0;
  }
  if (st.bus && st.bus.stop) st.bus.stop();
  st.bus = null;
  st.ready = 0;
  st.ok = 0;
  st.audio_ready = 0;
}

function sound_worker_proto_js_poll(out35, err_buf, err_cap, path_buf, path_cap, ctx_buf, ctx_cap, event_buf, event_cap, stage_buf, stage_cap, backend_buf, backend_cap) {
  var st = Module.sound_worker_proto;
  if (!st) return 0;
  var s = st.stats || {};
  var bus = st.bus || {};
  var ctx = bus.audioCtx || null;
  function put_ascii(ptr, cap, value) {
    if (!ptr || cap <= 0) return;
    value = String(value || "");
    var count = Math.min(cap - 1, value.length);
    for (var i = 0; i < count; i++) HEAPU8[SAFE_HEAP_INDEX(HEAPU8, ptr + i, "storing")] = value.charCodeAt(i) & 255;
    HEAPU8[SAFE_HEAP_INDEX(HEAPU8, ptr + count, "storing")] = 0;
  }
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 0, "storing")] = s.last_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 1, "storing")] = s.avg_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 2, "storing")] = s.max_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 3, "storing")] = s.stall_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 4, "storing")] = s.n || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 5, "storing")] = s.sample0 || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 6, "storing")] = s.underruns || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 7, "storing")] = s.queued_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 8, "storing")] = bus.sampleRate || (ctx ? ctx.sampleRate : 0) || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 9, "storing")] = bus._pendingPlays ? bus._pendingPlays.length : 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 10, "storing")] = bus._unlockAttempts || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 11, "storing")] = self.isSecureContext ? 1 : 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 12, "storing")] = ((Module.SoundBus || Module.SoundBusProto) && (Module.SoundBus || Module.SoundBusProto).workletSupported && (Module.SoundBus || Module.SoundBusProto).workletSupported()) ? 1 : 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 13, "storing")] = bus.mobile ? 1 : 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 14, "storing")] = bus._startPromise ? 1 : 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 15, "storing")] = s.underrun_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 16, "storing")] = s.max_gap_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 17, "storing")] = s.min_queued_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 18, "storing")] = s.fill_wait_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 19, "storing")] = s.fill_wait_max_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 20, "storing")] = s.buffer_boost_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 21, "storing")] = s.synth_rate || bus.synthRate || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 22, "storing")] = s.output_rate || bus.sampleRate || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 23, "storing")] = s.synth_last_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 24, "storing")] = s.synth_avg_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 25, "storing")] = s.synth_max_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 26, "storing")] = s.worker_fill_last_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 27, "storing")] = s.worker_fill_max_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 28, "storing")] = s.voices || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 29, "storing")] = s.gpu_request_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 30, "storing")] = s.gpu_request_max_frames || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 31, "storing")] = s.pump_late_last_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 32, "storing")] = s.pump_late_max_ms || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 33, "storing")] = s.pump_late_count || 0;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (out35 >> 2) + 34, "storing")] = s.stale_needs || 0;
  var livePath = bus.audioPath || "";
  if (!livePath && bus.scriptNode) livePath = "script-pcm";
  if (!livePath && bus.worklet) livePath = bus.inlineSynth ? "worklet-inline" : "worklet-pcm";
  var liveBe = s.backend || (bus.stats && bus.stats.backend) || "";
  if (!liveBe && (bus.stats && (bus.stats.gpu | 0))) liveBe = "wasm-gpu";
  put_ascii(path_buf, path_cap, livePath || "none");
  put_ascii(ctx_buf, ctx_cap, ctx ? ctx.state : "none");
  put_ascii(event_buf, event_cap, st.last_unlock_event || "none");
  put_ascii(stage_buf, stage_cap, bus.audioStage || "none");
  put_ascii(backend_buf, backend_cap, liveBe || "none");
  var diag = st.error || bus.error || "";
  if (!diag) {
    var attempts = bus._unlockAttempts | 0;
    var path = bus.audioPath || "";
    var stage = bus.audioStage || "";
    if (typeof AudioContext === "undefined" && typeof webkitAudioContext === "undefined") diag = "BLOCKED no-AudioContext"; else if (attempts > 0 && ctx && ctx.state === "suspended") diag = "BLOCKED ctx=suspended — retap"; else if (attempts > 0 && ctx && ctx.state === "interrupted") diag = "BLOCKED ctx=interrupted"; else if (attempts > 0 && ctx && ctx.state === "closed") diag = "BLOCKED ctx=closed"; else if (bus.audioReady && !path) diag = "BLOCKED no-sink"; else if (attempts >= 2 && !bus.audioReady && stage === "error") diag = "BLOCKED unlock-failed"; else if (attempts >= 3 && !bus.audioReady) diag = "BLOCKED unlock x" + attempts + " " + stage; else if (bus.audioReady && path.indexOf("script") === 0 && !self.isSecureContext) diag = "WARN HTTP script-pcm (need HTTPS)"; else if (bus.audioReady && path.indexOf("script") === 0 && self.isSecureContext) diag = "WARN HTTPS still script-pcm (worklet failed — check console)";
  }
  if (err_buf && err_cap > 1 && diag) {
    var e = String(diag);
    var n = Math.min(err_cap - 1, e.length);
    for (var i = 0; i < n; i++) HEAPU8[SAFE_HEAP_INDEX(HEAPU8, err_buf + i, "storing")] = e.charCodeAt(i) & 255;
    HEAPU8[SAFE_HEAP_INDEX(HEAPU8, err_buf + n, "storing")] = 0;
  } else if (err_buf && err_cap > 0) {
    HEAPU8[SAFE_HEAP_INDEX(HEAPU8, err_buf, "storing")] = 0;
  }
  return (st.ready ? 2 : 0) | (st.ok ? 1 : 0) | (diag ? 4 : 0) | ((st.audio_ready && ctx && ctx.state === "running") ? 8 : 0);
}

function numeris_id_js_fill_random(buf, n) {
  try {
    var a = new Uint8Array(n);
    var c = null;
    if (typeof self !== "undefined" && self.crypto) c = self.crypto; else if (typeof window !== "undefined" && window.crypto) c = window.crypto;
    if (!c || !c.getRandomValues) return 0;
    c.getRandomValues(a);
    HEAPU8.set(a, buf);
    return 1;
  } catch (e) {
    return 0;
  }
}

function numeris_identity_js_now_ms() {
  return Date.now();
}

function numeris_device_js_os_hint() {
  try {
    var ua = "";
    var p = "";
    if (typeof navigator !== "undefined") {
      if (navigator.userAgent) ua = String(navigator.userAgent).toLowerCase();
      if (navigator.platform) p = String(navigator.platform).toLowerCase();
    }
    if (/android/.test(ua)) return 4;
    if (/iphone|ipod/.test(ua)) return 5;
    if (/ipad/.test(ua) || (p === "macintel" && navigator.maxTouchPoints > 1)) return 5;
    if (/win/.test(ua) || /win/.test(p)) return 1;
    if (/mac/.test(ua) || /mac/.test(p)) return 2;
    if (/linux/.test(ua) || /linux/.test(p) || /cros/.test(ua)) return 3;
  } catch (e) {}
  return 0;
}

function numeris_device_js_class_hint() {
  try {
    var ua = "";
    if (typeof navigator !== "undefined" && navigator.userAgent) ua = String(navigator.userAgent).toLowerCase();
    if (/ipad|tablet|kindle|silk/.test(ua)) return 3;
    if (typeof navigator !== "undefined" && String(navigator.platform || "").toLowerCase() === "macintel" && navigator.maxTouchPoints > 1) return 3;
    if (/mobi|android|iphone|ipod|phone/.test(ua)) return 2;
    return 1;
  } catch (e) {}
  return 0;
}

function numeris_device_js_fill_env(lang_buf, dpr_ptr, sw_ptr, sh_ptr) {
  try {
    var lang = "und";
    if (typeof navigator !== "undefined") {
      if (navigator.language) lang = String(navigator.language); else if (navigator.userLanguage) lang = String(navigator.userLanguage);
    }
    if (lang.length > 15) lang = lang.substring(0, 15);
    stringToUTF8(lang, lang_buf, 16);
    var dpr = 1;
    if (typeof devicePixelRatio === "number" && isFinite(devicePixelRatio)) dpr = devicePixelRatio;
    setValue(dpr_ptr, dpr, "float");
    var sw = 0;
    var sh = 0;
    if (typeof screen !== "undefined") {
      if (screen.width) sw = screen.width | 0;
      if (screen.height) sh = screen.height | 0;
    }
    setValue(sw_ptr, sw, "i32");
    setValue(sh_ptr, sh, "i32");
  } catch (e) {
    stringToUTF8("und", lang_buf, 16);
    setValue(dpr_ptr, 1, "float");
    setValue(sw_ptr, 0, "i32");
    setValue(sh_ptr, 0, "i32");
  }
}

function numeris_analytics_net_js_post(url, body) {
  var u = UTF8ToString(url);
  var b = UTF8ToString(body);
  var hdr = {};
  hdr["Content-Type"] = "application/json";
  var opts = {};
  opts.method = "POST";
  opts.headers = hdr;
  opts.body = b;
  opts.mode = "cors";
  opts.keepalive = true;
  Module.numeris_ae_http = -2;
  fetch(u, opts).then(function(r) {
    Module.numeris_ae_http = r.status | 0;
  }).catch(function(err) {
    console.error("[numeris_analytics] FAIL fetch", err);
    Module.numeris_ae_http = 0;
  });
}

function numeris_analytics_net_js_poll_http() {
  if (typeof Module.numeris_ae_http !== "number") return -1;
  var s = Module.numeris_ae_http | 0;
  if (s === -2) return -1;
  delete Module.numeris_ae_http;
  return s;
}

function numeris_web_toggle_fullscreen() {
  var root = document.documentElement;
  var fs = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (!fs) {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) req.call(root);
    } else {
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) ex.call(document);
    }
  } catch (e) {}
}

function numeris_web_is_fullscreen() {
  return (document.fullscreenElement || document.webkitFullscreenElement) ? 1 : 0;
}

function numeris_web_vis_frac(xywh) {
  var c = (typeof Module !== "undefined" && Module.canvas) ? Module.canvas : document.getElementById("canvas");
  var cr, vv, x, y, w, h, ix0, iy0, ix1, iy1;
  if (!xywh) return;
  if (!c) {
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, xywh >> 2, "storing")] = 0;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 1, "storing")] = 0;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 2, "storing")] = 1;
    HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 3, "storing")] = 1;
    return;
  }
  cr = c.getBoundingClientRect();
  w = cr.width > 1 ? cr.width : 1;
  h = cr.height > 1 ? cr.height : 1;
  x = 0;
  y = 0;
  vv = window.visualViewport;
  if (vv) {
    ix0 = Math.max(cr.left, vv.offsetLeft);
    iy0 = Math.max(cr.top, vv.offsetTop);
    ix1 = Math.min(cr.right, vv.offsetLeft + vv.width);
    iy1 = Math.min(cr.bottom, vv.offsetTop + vv.height);
    x = (ix0 - cr.left) / w;
    y = (iy0 - cr.top) / h;
    w = Math.max(.08, (ix1 - ix0) / (cr.width > 1 ? cr.width : 1));
    h = Math.max(.12, (iy1 - iy0) / (cr.height > 1 ? cr.height : 1));
  } else {
    w = 1;
    h = 1;
  }
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, xywh >> 2, "storing")] = x;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 1, "storing")] = y;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 2, "storing")] = w;
  HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (xywh >> 2) + 3, "storing")] = h;
}

function numeris_text_js_boot() {
  var i, host;
  if (window.__numerisIme && window.__numerisIme.bound) return;
  window.__numerisIme = {
    want: 0,
    bound: 1,
    pw: 1,
    ph: 1,
    k: 1
  };
  function styleInp(inp) {
    inp.type = "text";
    inp.autocomplete = "off";
    inp.autocorrect = "off";
    inp.spellcheck = false;
    inp.setAttribute("inputmode", "text");
    inp.setAttribute("enterkeyhint", "done");
    inp.setAttribute("autocapitalize", "sentences");
    inp.style.position = "fixed";
    inp.style.zIndex = "2147483000";
    inp.style.opacity = "0.01";
    inp.style.background = "transparent";
    inp.style.color = "transparent";
    inp.style.caretColor = "transparent";
    inp.style.border = "none";
    inp.style.outline = "none";
    inp.style.padding = "0 8px";
    inp.style.margin = "0";
    inp.style.font = "16px sans-serif";
    inp.style.overflowX = "auto";
    inp.style.overflowY = "hidden";
    inp.style.whiteSpace = "nowrap";
    inp.style.userSelect = "text";
    inp.style.webkitUserSelect = "text";
    inp.style.touchAction = "manipulation";
    inp.style.pointerEvents = "none";
    inp.style.display = "none";
  }
  host = document.fullscreenElement || document.body;
  for (i = 0; i < 3; i++) {
    var id = "numerisTextEdit" + i;
    var inp = document.getElementById(id);
    if (!inp) {
      inp = document.createElement("input");
      inp.id = id;
      styleInp(inp);
      host.appendChild(inp);
    }
  }
}

function numeris_text_js_arm(want, x0, y0, w0, h0, x1, y1, w1, h1, x2, y2, w2, h2, panel_w, panel_h) {
  var boxes, i, inp, c, r, k, host, box, ua, touch;
  if (!window.__numerisIme) return;
  window.__numerisIme.want = want ? 1 : 0;
  window.__numerisIme.pw = panel_w > 1 ? panel_w : 1;
  window.__numerisIme.ph = panel_h > 1 ? panel_h : 1;
  c = (typeof Module !== "undefined" && Module.canvas) ? Module.canvas : document.getElementById("canvas");
  r = c ? c.getBoundingClientRect() : {
    left: 0,
    top: 0,
    width: 1,
    height: 1
  };
  k = r.width / (panel_w > 1 ? panel_w : r.width);
  if (!(k > .01)) k = 1;
  window.__numerisIme.k = k;
  host = document.fullscreenElement || document.body;
  boxes = [ {
    x: x0,
    y: y0,
    w: w0,
    h: h0
  }, {
    x: x1,
    y: y1,
    w: w1,
    h: h1
  }, {
    x: x2,
    y: y2,
    w: w2,
    h: h2
  } ];
  ua = navigator.userAgent || "";
  touch = (ua.indexOf("Android") >= 0 || ua.indexOf("iPhone") >= 0 || ua.indexOf("iPad") >= 0 || ua.indexOf("iPod") >= 0) ? 1 : 0;
  for (i = 0; i < 3; i++) {
    inp = document.getElementById("numerisTextEdit" + i);
    if (!inp) continue;
    if (host && inp.parentNode !== host) host.appendChild(inp);
    if (!want || !touch) {
      inp.blur();
      inp.style.display = "none";
      inp.style.pointerEvents = "none";
      continue;
    }
    box = boxes[i];
    inp.style.left = (r.left + box.x * k) + "px";
    inp.style.top = (r.top + box.y * (r.height / (panel_h > 1 ? panel_h : r.height))) + "px";
    inp.style.width = Math.max(8, box.w * k) + "px";
    inp.style.height = Math.max(28, box.h * (r.height / (panel_h > 1 ? panel_h : r.height))) + "px";
    inp.style.display = "block";
    inp.style.pointerEvents = "auto";
  }
}

function numeris_text_js_move(fi, x, y, w, h) {
  var inp, c, r, k, ky, ime;
  if (fi < 0 || fi > 2) return;
  inp = document.getElementById("numerisTextEdit" + fi);
  if (!inp) return;
  ime = window.__numerisIme;
  c = (typeof Module !== "undefined" && Module.canvas) ? Module.canvas : document.getElementById("canvas");
  r = c ? c.getBoundingClientRect() : {
    left: 0,
    top: 0,
    width: 1,
    height: 1
  };
  k = ime && ime.k > .01 ? ime.k : 1;
  ky = (ime && ime.ph > 1 && r.height > 1) ? r.height / ime.ph : k;
  inp.style.left = (r.left + x * k) + "px";
  inp.style.top = (r.top + y * ky) + "px";
  inp.style.width = Math.max(8, w * k) + "px";
  inp.style.height = Math.max(28, h * ky) + "px";
  inp.style.display = "block";
  inp.style.pointerEvents = "auto";
}

function numeris_text_js_open(fi, x, y, w, h, maxlen) {
  var inp, fs, ex, ua, touch;
  if (fi < 0 || fi > 2) return;
  inp = document.getElementById("numerisTextEdit" + fi);
  if (!inp) return;
  inp.maxLength = maxlen > 0 ? maxlen : 48;
  ua = navigator.userAgent || "";
  touch = (ua.indexOf("Android") >= 0 || ua.indexOf("iPhone") >= 0 || ua.indexOf("iPad") >= 0 || ua.indexOf("iPod") >= 0) ? 1 : 0;
  if (!touch) {
    try {
      inp.blur();
    } catch (e) {}
    return;
  }
  fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (fs && fs.tagName === "CANVAS") {
    ex = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      if (ex) ex.call(document);
    } catch (e) {}
  }
  try {
    inp.focus();
  } catch (e) {}
}

function numeris_text_js_set(fi, s) {
  var inp = (fi >= 0 && fi <= 2) ? document.getElementById("numerisTextEdit" + fi) : null;
  var v;
  if (!inp) return;
  v = UTF8ToString(s);
  if (inp.value !== v) inp.value = v;
}

function numeris_text_js_get(fi, dst, cap) {
  var inp = (fi >= 0 && fi <= 2) ? document.getElementById("numerisTextEdit" + fi) : null;
  if (!inp || cap < 2) return 0;
  stringToUTF8(inp.value || "", dst, cap);
  return 1;
}

function numeris_text_js_sel(fi, a, b) {
  var inp = (fi >= 0 && fi <= 2) ? document.getElementById("numerisTextEdit" + fi) : null;
  if (!inp) {
    HEAP32[SAFE_HEAP_INDEX(HEAP32, a >> 2, "storing")] = 0;
    HEAP32[SAFE_HEAP_INDEX(HEAP32, b >> 2, "storing")] = 0;
    return;
  }
  HEAP32[SAFE_HEAP_INDEX(HEAP32, a >> 2, "storing")] = inp.selectionStart | 0;
  HEAP32[SAFE_HEAP_INDEX(HEAP32, b >> 2, "storing")] = inp.selectionEnd | 0;
}

function numeris_text_js_set_sel(fi, a, b) {
  var inp = (fi >= 0 && fi <= 2) ? document.getElementById("numerisTextEdit" + fi) : null;
  if (!inp) return;
  try {
    inp.setSelectionRange(a, b);
  } catch (e) {}
}

function numeris_text_js_set_scroll(fi, px) {
  var inp = (fi >= 0 && fi <= 2) ? document.getElementById("numerisTextEdit" + fi) : null;
  var k = window.__numerisIme && window.__numerisIme.k > .01 ? window.__numerisIme.k : 1;
  if (!inp) return;
  inp.scrollLeft = px * k;
}

function numeris_text_js_focused_i() {
  var a = document.activeElement;
  var n;
  if (!a || !a.id || a.id.indexOf("numerisTextEdit") !== 0) return -1;
  n = parseInt(a.id.replace("numerisTextEdit", ""), 10);
  return (n >= 0 && n <= 2) ? n : -1;
}

function numeris_text_js_touch_ime() {
  var ua = navigator.userAgent || "";
  if (ua.indexOf("Android") >= 0) return 1;
  if (ua.indexOf("iPhone") >= 0) return 1;
  if (ua.indexOf("iPad") >= 0) return 1;
  if (ua.indexOf("iPod") >= 0) return 1;
  return 0;
}

function numeris_awaken_js_hide_loader() {
  if (typeof window !== "undefined" && typeof window.numerisHideLoader === "function") window.numerisHideLoader();
}

function sapp_js_add_beforeunload_listener() {
  Module.sokol_beforeunload = event => {
    if (__sapp_html5_get_ask_leave_site() != 0) {
      event.preventDefault();
      event.returnValue = " ";
    }
  };
  window.addEventListener("beforeunload", Module.sokol_beforeunload);
}

function sapp_js_remove_beforeunload_listener() {
  window.removeEventListener("beforeunload", Module.sokol_beforeunload);
}

function sapp_js_add_clipboard_listener() {
  Module.sokol_paste = event => {
    const pasted_str = event.clipboardData.getData("text");
    withStackSave(() => {
      const cstr = stringToUTF8OnStack(pasted_str);
      __sapp_emsc_onpaste(cstr);
    });
  };
  window.addEventListener("paste", Module.sokol_paste);
}

function sapp_js_remove_clipboard_listener() {
  window.removeEventListener("paste", Module.sokol_paste);
}

function sapp_js_write_clipboard(c_str) {
  const str = UTF8ToString(c_str);
  const ta = document.createElement("textarea");
  ta.setAttribute("autocomplete", "off");
  ta.setAttribute("autocorrect", "off");
  ta.setAttribute("autocapitalize", "off");
  ta.setAttribute("spellcheck", "false");
  ta.style.left = -100 + "px";
  ta.style.top = -100 + "px";
  ta.style.height = 1;
  ta.style.width = 1;
  ta.value = str;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function sapp_js_add_dragndrop_listeners() {
  Module.sokol_drop_files = [];
  Module.sokol_dragenter = event => {
    event.stopPropagation();
    event.preventDefault();
  };
  Module.sokol_dragleave = event => {
    event.stopPropagation();
    event.preventDefault();
  };
  Module.sokol_dragover = event => {
    event.stopPropagation();
    event.preventDefault();
  };
  Module.sokol_drop = event => {
    event.stopPropagation();
    event.preventDefault();
    const files = event.dataTransfer.files;
    Module.sokol_dropped_files = files;
    __sapp_emsc_begin_drop(files.length);
    for (let i = 0; i < files.length; i++) {
      withStackSave(() => {
        const cstr = stringToUTF8OnStack(files[i].name);
        __sapp_emsc_drop(i, cstr);
      });
    }
    let mods = 0;
    if (event.shiftKey) {
      mods |= 1;
    }
    if (event.ctrlKey) {
      mods |= 2;
    }
    if (event.altKey) {
      mods |= 4;
    }
    if (event.metaKey) {
      mods |= 8;
    }
    __sapp_emsc_end_drop(event.clientX, event.clientY, mods);
  };
  /** @suppress {missingProperties} */ const canvas = Module.sapp_emsc_target;
  canvas.addEventListener("dragenter", Module.sokol_dragenter, false);
  canvas.addEventListener("dragleave", Module.sokol_dragleave, false);
  canvas.addEventListener("dragover", Module.sokol_dragover, false);
  canvas.addEventListener("drop", Module.sokol_drop, false);
}

function sapp_js_remove_dragndrop_listeners() {
  /** @suppress {missingProperties} */ const canvas = Module.sapp_emsc_target;
  canvas.removeEventListener("dragenter", Module.sokol_dragenter);
  canvas.removeEventListener("dragleave", Module.sokol_dragleave);
  canvas.removeEventListener("dragover", Module.sokol_dragover);
  canvas.removeEventListener("drop", Module.sokol_drop);
}

function sapp_js_init(c_str_target_selector, c_str_document_title) {
  if (c_str_document_title !== 0) {
    document.title = UTF8ToString(c_str_document_title);
  }
  const target_selector_str = UTF8ToString(c_str_target_selector);
  if (Module["canvas"] !== undefined) {
    if (typeof Module["canvas"] === "object") {
      specialHTMLTargets[target_selector_str] = Module["canvas"];
    } else {
      console.warn("sokol_app.h: Module['canvas'] is set but is not an object");
    }
  }
  Module.sapp_emsc_target = findCanvasEventTarget(target_selector_str);
  if (!Module.sapp_emsc_target) {
    console.warn("sokol_app.h: can't find html5_canvas_selector ", target_selector_str);
  }
  if (!Module.sapp_emsc_target.requestPointerLock) {
    console.warn("sokol_app.h: target doesn't support requestPointerLock: ", target_selector_str);
  }
}

function sapp_js_request_pointerlock() {
  if (Module.sapp_emsc_target) {
    if (Module.sapp_emsc_target.requestPointerLock) {
      Module.sapp_emsc_target.requestPointerLock();
    }
  }
}

function sapp_js_set_cursor(cursor_type, shown, use_custom_cursor_image) {
  if (Module.sapp_emsc_target) {
    let cursor;
    if (shown === 0) {
      cursor = "none";
    } else if (use_custom_cursor_image != 0) {
      cursor = Module.__sapp_custom_cursors[cursor_type].css_property;
    } else switch (cursor_type) {
     case 0:
      cursor = "auto";
      break;

     case 1:
      cursor = "default";
      break;

     case 2:
      cursor = "text";
      break;

     case 3:
      cursor = "crosshair";
      break;

     case 4:
      cursor = "pointer";
      break;

     case 5:
      cursor = "ew-resize";
      break;

     case 6:
      cursor = "ns-resize";
      break;

     case 7:
      cursor = "nwse-resize";
      break;

     case 8:
      cursor = "nesw-resize";
      break;

     case 9:
      cursor = "all-scroll";
      break;

     case 10:
      cursor = "not-allowed";
      break;

     default:
      cursor = "auto";
      break;
    }
    Module.sapp_emsc_target.style.cursor = cursor;
  }
}

function sapp_js_destroy_custom_mouse_cursor(cursor_slot_idx) {
  if (Module.__sapp_custom_cursors) {
    const cursor = Module.__sapp_custom_cursors[cursor_slot_idx];
    URL.revokeObjectURL(cursor.blob_url);
    Module.__sapp_custom_cursors[cursor_slot_idx] = null;
  }
}

function sapp_js_clear_favicon() {
  const link = document.getElementById("sokol-app-favicon");
  if (link) {
    document.head.removeChild(link);
  }
}

function sapp_js_set_favicon(w, h, pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img_data = ctx.createImageData(w, h);
  img_data.data.set(HEAPU8.subarray(pixels, pixels + w * h * 4));
  ctx.putImageData(img_data, 0, 0);
  const new_link = document.createElement("link");
  new_link.id = "sokol-app-favicon";
  new_link.rel = "shortcut icon";
  new_link.href = canvas.toDataURL();
  document.head.appendChild(new_link);
}

function slog_js_log(level, c_str) {
  const str = UTF8ToString(c_str);
  switch (level) {
   case 0:
    console.error(str);
    break;

   case 1:
    console.error(str);
    break;

   case 2:
    console.warn(str);
    break;

   default:
    console.info(str);
    break;
  }
}

function sfetch_js_send_get_request(slot_id, path_cstr, offset, bytes_to_read, buf_ptr, buf_size) {
  const path_str = UTF8ToString(path_cstr);
  const headers = new Headers;
  const range_request = bytes_to_read > 0;
  if (range_request) {
    headers.append("Range", `bytes=${offset}-${offset + bytes_to_read - 1}`);
  }
  fetch(path_str, {
    method: "GET",
    headers
  }).then(response => {
    if (response.ok) {
      response.arrayBuffer().then(data => {
        const u8_data = new Uint8Array(data);
        if (u8_data.length <= buf_size) {
          HEAPU8.set(u8_data, buf_ptr);
          __sfetch_emsc_get_response(slot_id, bytes_to_read, u8_data.length);
        } else {
          __sfetch_emsc_failed_buffer_too_small(slot_id);
        }
      }).catch(err => {
        console.error(`sokol_fetch.h: GET ${path_str} failed with: `, err);
        __sfetch_emsc_failed_other(slot_id);
      });
    } else {
      __sfetch_emsc_failed_http_status(slot_id, response.status);
    }
  }).catch(err => {
    console.error(`sokol_fetch.h: GET ${path_str} failed with: `, err);
    __sfetch_emsc_failed_other(slot_id);
  });
}

function saudio_js_init(sample_rate, num_channels, buffer_size) {
  Module._saudio_context = null;
  Module._saudio_node = null;
  if (typeof AudioContext !== "undefined") {
    Module._saudio_context = new AudioContext({
      sampleRate: sample_rate,
      latencyHint: "interactive"
    });
  } else {
    Module._saudio_context = null;
    console.log("sokol_audio.h: no WebAudio support");
  }
  if (Module._saudio_context) {
    console.log("sokol_audio.h: sample rate ", Module._saudio_context.sampleRate);
    Module._saudio_node = Module._saudio_context.createScriptProcessor(buffer_size, 0, num_channels);
    Module._saudio_node.onaudioprocess = event => {
      const num_frames = event.outputBuffer.length;
      const ptr = __saudio_emsc_pull(num_frames);
      if (ptr) {
        const num_channels = event.outputBuffer.numberOfChannels;
        for (let chn = 0; chn < num_channels; chn++) {
          const chan = event.outputBuffer.getChannelData(chn);
          for (let i = 0; i < num_frames; i++) {
            chan[i] = HEAPF32[SAFE_HEAP_INDEX(HEAPF32, (ptr >> 2) + ((num_channels * i) + chn), "loading")];
          }
        }
      }
    };
    Module._saudio_node.connect(Module._saudio_context.destination);
    const resume_webaudio = () => {
      if (Module._saudio_context) {
        if (Module._saudio_context.state === "suspended") {
          Module._saudio_context.resume();
        }
      }
    };
    document.addEventListener("click", resume_webaudio, {
      once: true
    });
    document.addEventListener("touchend", resume_webaudio, {
      once: true
    });
    document.addEventListener("keydown", resume_webaudio, {
      once: true
    });
    return 1;
  } else {
    return 0;
  }
}

function saudio_js_shutdown() {
  /** @suppress {missingProperties} */ const ctx = Module._saudio_context;
  if (ctx !== null) {
    if (Module._saudio_node) {
      Module._saudio_node.disconnect();
    }
    ctx.close();
    Module._saudio_context = null;
    Module._saudio_node = null;
  }
}

function saudio_js_sample_rate() {
  if (Module._saudio_context) {
    return Module._saudio_context.sampleRate;
  } else {
    return 0;
  }
}

function saudio_js_buffer_frames() {
  if (Module._saudio_node) {
    return Module._saudio_node.bufferSize;
  } else {
    return 0;
  }
}

// Imports from the Wasm binary.
var ___getTypeName = makeInvalidEarlyAccess("___getTypeName");

var _malloc = makeInvalidEarlyAccess("_malloc");

var _free = makeInvalidEarlyAccess("_free");

var _winmod_emsc_release_pointers = Module["_winmod_emsc_release_pointers"] = makeInvalidEarlyAccess("_winmod_emsc_release_pointers");

var _emsc_on_config_fs_ready = Module["_emsc_on_config_fs_ready"] = makeInvalidEarlyAccess("_emsc_on_config_fs_ready");

var _emsc_on_config_fs_failed = Module["_emsc_on_config_fs_failed"] = makeInvalidEarlyAccess("_emsc_on_config_fs_failed");

var _main = Module["_main"] = makeInvalidEarlyAccess("_main");

var __sapp_emsc_onpaste = Module["__sapp_emsc_onpaste"] = makeInvalidEarlyAccess("__sapp_emsc_onpaste");

var __sapp_html5_get_ask_leave_site = Module["__sapp_html5_get_ask_leave_site"] = makeInvalidEarlyAccess("__sapp_html5_get_ask_leave_site");

var __sapp_emsc_begin_drop = Module["__sapp_emsc_begin_drop"] = makeInvalidEarlyAccess("__sapp_emsc_begin_drop");

var __sapp_emsc_drop = Module["__sapp_emsc_drop"] = makeInvalidEarlyAccess("__sapp_emsc_drop");

var __sapp_emsc_end_drop = Module["__sapp_emsc_end_drop"] = makeInvalidEarlyAccess("__sapp_emsc_end_drop");

var __sapp_emsc_invoke_fetch_cb = Module["__sapp_emsc_invoke_fetch_cb"] = makeInvalidEarlyAccess("__sapp_emsc_invoke_fetch_cb");

var __sapp_emsc_set_fullscreen_flag = Module["__sapp_emsc_set_fullscreen_flag"] = makeInvalidEarlyAccess("__sapp_emsc_set_fullscreen_flag");

var __sfetch_emsc_head_response = Module["__sfetch_emsc_head_response"] = makeInvalidEarlyAccess("__sfetch_emsc_head_response");

var __sfetch_emsc_get_response = Module["__sfetch_emsc_get_response"] = makeInvalidEarlyAccess("__sfetch_emsc_get_response");

var __sfetch_emsc_failed_http_status = Module["__sfetch_emsc_failed_http_status"] = makeInvalidEarlyAccess("__sfetch_emsc_failed_http_status");

var __sfetch_emsc_failed_buffer_too_small = Module["__sfetch_emsc_failed_buffer_too_small"] = makeInvalidEarlyAccess("__sfetch_emsc_failed_buffer_too_small");

var __sfetch_emsc_failed_other = Module["__sfetch_emsc_failed_other"] = makeInvalidEarlyAccess("__sfetch_emsc_failed_other");

var __saudio_emsc_pull = Module["__saudio_emsc_pull"] = makeInvalidEarlyAccess("__saudio_emsc_pull");

var _fflush = makeInvalidEarlyAccess("_fflush");

var _strerror = makeInvalidEarlyAccess("_strerror");

var _emwgpuCreateBindGroup = makeInvalidEarlyAccess("_emwgpuCreateBindGroup");

var _emwgpuCreateBindGroupLayout = makeInvalidEarlyAccess("_emwgpuCreateBindGroupLayout");

var _emwgpuCreateCommandBuffer = makeInvalidEarlyAccess("_emwgpuCreateCommandBuffer");

var _emwgpuCreateCommandEncoder = makeInvalidEarlyAccess("_emwgpuCreateCommandEncoder");

var _emwgpuCreateComputePassEncoder = makeInvalidEarlyAccess("_emwgpuCreateComputePassEncoder");

var _emwgpuCreateComputePipeline = makeInvalidEarlyAccess("_emwgpuCreateComputePipeline");

var _emwgpuCreatePipelineLayout = makeInvalidEarlyAccess("_emwgpuCreatePipelineLayout");

var _emwgpuCreateQuerySet = makeInvalidEarlyAccess("_emwgpuCreateQuerySet");

var _emwgpuCreateRenderBundle = makeInvalidEarlyAccess("_emwgpuCreateRenderBundle");

var _emwgpuCreateRenderBundleEncoder = makeInvalidEarlyAccess("_emwgpuCreateRenderBundleEncoder");

var _emwgpuCreateRenderPassEncoder = makeInvalidEarlyAccess("_emwgpuCreateRenderPassEncoder");

var _emwgpuCreateRenderPipeline = makeInvalidEarlyAccess("_emwgpuCreateRenderPipeline");

var _emwgpuCreateSampler = makeInvalidEarlyAccess("_emwgpuCreateSampler");

var _emwgpuCreateSurface = makeInvalidEarlyAccess("_emwgpuCreateSurface");

var _emwgpuCreateTexture = makeInvalidEarlyAccess("_emwgpuCreateTexture");

var _emwgpuCreateTextureView = makeInvalidEarlyAccess("_emwgpuCreateTextureView");

var _emwgpuCreateAdapter = makeInvalidEarlyAccess("_emwgpuCreateAdapter");

var _emwgpuCreateBuffer = makeInvalidEarlyAccess("_emwgpuCreateBuffer");

var _emwgpuCreateDevice = makeInvalidEarlyAccess("_emwgpuCreateDevice");

var _emwgpuCreateQueue = makeInvalidEarlyAccess("_emwgpuCreateQueue");

var _emwgpuCreateShaderModule = makeInvalidEarlyAccess("_emwgpuCreateShaderModule");

var _emwgpuOnCompilationInfoCompleted = makeInvalidEarlyAccess("_emwgpuOnCompilationInfoCompleted");

var _emwgpuOnCreateComputePipelineCompleted = makeInvalidEarlyAccess("_emwgpuOnCreateComputePipelineCompleted");

var _emwgpuOnCreateRenderPipelineCompleted = makeInvalidEarlyAccess("_emwgpuOnCreateRenderPipelineCompleted");

var _emwgpuOnDeviceLostCompleted = makeInvalidEarlyAccess("_emwgpuOnDeviceLostCompleted");

var _emwgpuOnMapAsyncCompleted = makeInvalidEarlyAccess("_emwgpuOnMapAsyncCompleted");

var _emwgpuOnPopErrorScopeCompleted = makeInvalidEarlyAccess("_emwgpuOnPopErrorScopeCompleted");

var _emwgpuOnRequestAdapterCompleted = makeInvalidEarlyAccess("_emwgpuOnRequestAdapterCompleted");

var _emwgpuOnRequestDeviceCompleted = makeInvalidEarlyAccess("_emwgpuOnRequestDeviceCompleted");

var _emwgpuOnWorkDoneCompleted = makeInvalidEarlyAccess("_emwgpuOnWorkDoneCompleted");

var _emwgpuOnUncapturedError = makeInvalidEarlyAccess("_emwgpuOnUncapturedError");

var _emscripten_stack_get_end = makeInvalidEarlyAccess("_emscripten_stack_get_end");

var _emscripten_stack_get_base = makeInvalidEarlyAccess("_emscripten_stack_get_base");

var _sbrk = makeInvalidEarlyAccess("_sbrk");

var _memalign = makeInvalidEarlyAccess("_memalign");

var _emscripten_get_sbrk_ptr = makeInvalidEarlyAccess("_emscripten_get_sbrk_ptr");

var _setThrew = makeInvalidEarlyAccess("_setThrew");

var _emscripten_stack_init = makeInvalidEarlyAccess("_emscripten_stack_init");

var _emscripten_stack_get_free = makeInvalidEarlyAccess("_emscripten_stack_get_free");

var __emscripten_stack_restore = makeInvalidEarlyAccess("__emscripten_stack_restore");

var __emscripten_stack_alloc = makeInvalidEarlyAccess("__emscripten_stack_alloc");

var _emscripten_stack_get_current = makeInvalidEarlyAccess("_emscripten_stack_get_current");

var ___set_stack_limits = Module["___set_stack_limits"] = makeInvalidEarlyAccess("___set_stack_limits");

var memory = makeInvalidEarlyAccess("memory");

var __indirect_function_table = makeInvalidEarlyAccess("__indirect_function_table");

var wasmMemory = makeInvalidEarlyAccess("wasmMemory");

var wasmTable = makeInvalidEarlyAccess("wasmTable");

function assignWasmExports(wasmExports) {
  assert(typeof wasmExports["__getTypeName"] != "undefined", "missing Wasm export: __getTypeName");
  assert(typeof wasmExports["malloc"] != "undefined", "missing Wasm export: malloc");
  assert(typeof wasmExports["free"] != "undefined", "missing Wasm export: free");
  assert(typeof wasmExports["winmod_emsc_release_pointers"] != "undefined", "missing Wasm export: winmod_emsc_release_pointers");
  assert(typeof wasmExports["emsc_on_config_fs_ready"] != "undefined", "missing Wasm export: emsc_on_config_fs_ready");
  assert(typeof wasmExports["emsc_on_config_fs_failed"] != "undefined", "missing Wasm export: emsc_on_config_fs_failed");
  assert(typeof wasmExports["__main_argc_argv"] != "undefined", "missing Wasm export: __main_argc_argv");
  assert(typeof wasmExports["_sapp_emsc_onpaste"] != "undefined", "missing Wasm export: _sapp_emsc_onpaste");
  assert(typeof wasmExports["_sapp_html5_get_ask_leave_site"] != "undefined", "missing Wasm export: _sapp_html5_get_ask_leave_site");
  assert(typeof wasmExports["_sapp_emsc_begin_drop"] != "undefined", "missing Wasm export: _sapp_emsc_begin_drop");
  assert(typeof wasmExports["_sapp_emsc_drop"] != "undefined", "missing Wasm export: _sapp_emsc_drop");
  assert(typeof wasmExports["_sapp_emsc_end_drop"] != "undefined", "missing Wasm export: _sapp_emsc_end_drop");
  assert(typeof wasmExports["_sapp_emsc_invoke_fetch_cb"] != "undefined", "missing Wasm export: _sapp_emsc_invoke_fetch_cb");
  assert(typeof wasmExports["_sapp_emsc_set_fullscreen_flag"] != "undefined", "missing Wasm export: _sapp_emsc_set_fullscreen_flag");
  assert(typeof wasmExports["_sfetch_emsc_head_response"] != "undefined", "missing Wasm export: _sfetch_emsc_head_response");
  assert(typeof wasmExports["_sfetch_emsc_get_response"] != "undefined", "missing Wasm export: _sfetch_emsc_get_response");
  assert(typeof wasmExports["_sfetch_emsc_failed_http_status"] != "undefined", "missing Wasm export: _sfetch_emsc_failed_http_status");
  assert(typeof wasmExports["_sfetch_emsc_failed_buffer_too_small"] != "undefined", "missing Wasm export: _sfetch_emsc_failed_buffer_too_small");
  assert(typeof wasmExports["_sfetch_emsc_failed_other"] != "undefined", "missing Wasm export: _sfetch_emsc_failed_other");
  assert(typeof wasmExports["_saudio_emsc_pull"] != "undefined", "missing Wasm export: _saudio_emsc_pull");
  assert(typeof wasmExports["fflush"] != "undefined", "missing Wasm export: fflush");
  assert(typeof wasmExports["strerror"] != "undefined", "missing Wasm export: strerror");
  assert(typeof wasmExports["emwgpuCreateBindGroup"] != "undefined", "missing Wasm export: emwgpuCreateBindGroup");
  assert(typeof wasmExports["emwgpuCreateBindGroupLayout"] != "undefined", "missing Wasm export: emwgpuCreateBindGroupLayout");
  assert(typeof wasmExports["emwgpuCreateCommandBuffer"] != "undefined", "missing Wasm export: emwgpuCreateCommandBuffer");
  assert(typeof wasmExports["emwgpuCreateCommandEncoder"] != "undefined", "missing Wasm export: emwgpuCreateCommandEncoder");
  assert(typeof wasmExports["emwgpuCreateComputePassEncoder"] != "undefined", "missing Wasm export: emwgpuCreateComputePassEncoder");
  assert(typeof wasmExports["emwgpuCreateComputePipeline"] != "undefined", "missing Wasm export: emwgpuCreateComputePipeline");
  assert(typeof wasmExports["emwgpuCreatePipelineLayout"] != "undefined", "missing Wasm export: emwgpuCreatePipelineLayout");
  assert(typeof wasmExports["emwgpuCreateQuerySet"] != "undefined", "missing Wasm export: emwgpuCreateQuerySet");
  assert(typeof wasmExports["emwgpuCreateRenderBundle"] != "undefined", "missing Wasm export: emwgpuCreateRenderBundle");
  assert(typeof wasmExports["emwgpuCreateRenderBundleEncoder"] != "undefined", "missing Wasm export: emwgpuCreateRenderBundleEncoder");
  assert(typeof wasmExports["emwgpuCreateRenderPassEncoder"] != "undefined", "missing Wasm export: emwgpuCreateRenderPassEncoder");
  assert(typeof wasmExports["emwgpuCreateRenderPipeline"] != "undefined", "missing Wasm export: emwgpuCreateRenderPipeline");
  assert(typeof wasmExports["emwgpuCreateSampler"] != "undefined", "missing Wasm export: emwgpuCreateSampler");
  assert(typeof wasmExports["emwgpuCreateSurface"] != "undefined", "missing Wasm export: emwgpuCreateSurface");
  assert(typeof wasmExports["emwgpuCreateTexture"] != "undefined", "missing Wasm export: emwgpuCreateTexture");
  assert(typeof wasmExports["emwgpuCreateTextureView"] != "undefined", "missing Wasm export: emwgpuCreateTextureView");
  assert(typeof wasmExports["emwgpuCreateAdapter"] != "undefined", "missing Wasm export: emwgpuCreateAdapter");
  assert(typeof wasmExports["emwgpuCreateBuffer"] != "undefined", "missing Wasm export: emwgpuCreateBuffer");
  assert(typeof wasmExports["emwgpuCreateDevice"] != "undefined", "missing Wasm export: emwgpuCreateDevice");
  assert(typeof wasmExports["emwgpuCreateQueue"] != "undefined", "missing Wasm export: emwgpuCreateQueue");
  assert(typeof wasmExports["emwgpuCreateShaderModule"] != "undefined", "missing Wasm export: emwgpuCreateShaderModule");
  assert(typeof wasmExports["emwgpuOnCompilationInfoCompleted"] != "undefined", "missing Wasm export: emwgpuOnCompilationInfoCompleted");
  assert(typeof wasmExports["emwgpuOnCreateComputePipelineCompleted"] != "undefined", "missing Wasm export: emwgpuOnCreateComputePipelineCompleted");
  assert(typeof wasmExports["emwgpuOnCreateRenderPipelineCompleted"] != "undefined", "missing Wasm export: emwgpuOnCreateRenderPipelineCompleted");
  assert(typeof wasmExports["emwgpuOnDeviceLostCompleted"] != "undefined", "missing Wasm export: emwgpuOnDeviceLostCompleted");
  assert(typeof wasmExports["emwgpuOnMapAsyncCompleted"] != "undefined", "missing Wasm export: emwgpuOnMapAsyncCompleted");
  assert(typeof wasmExports["emwgpuOnPopErrorScopeCompleted"] != "undefined", "missing Wasm export: emwgpuOnPopErrorScopeCompleted");
  assert(typeof wasmExports["emwgpuOnRequestAdapterCompleted"] != "undefined", "missing Wasm export: emwgpuOnRequestAdapterCompleted");
  assert(typeof wasmExports["emwgpuOnRequestDeviceCompleted"] != "undefined", "missing Wasm export: emwgpuOnRequestDeviceCompleted");
  assert(typeof wasmExports["emwgpuOnWorkDoneCompleted"] != "undefined", "missing Wasm export: emwgpuOnWorkDoneCompleted");
  assert(typeof wasmExports["emwgpuOnUncapturedError"] != "undefined", "missing Wasm export: emwgpuOnUncapturedError");
  assert(typeof wasmExports["emscripten_stack_get_end"] != "undefined", "missing Wasm export: emscripten_stack_get_end");
  assert(typeof wasmExports["emscripten_stack_get_base"] != "undefined", "missing Wasm export: emscripten_stack_get_base");
  assert(typeof wasmExports["sbrk"] != "undefined", "missing Wasm export: sbrk");
  assert(typeof wasmExports["memalign"] != "undefined", "missing Wasm export: memalign");
  assert(typeof wasmExports["emscripten_get_sbrk_ptr"] != "undefined", "missing Wasm export: emscripten_get_sbrk_ptr");
  assert(typeof wasmExports["setThrew"] != "undefined", "missing Wasm export: setThrew");
  assert(typeof wasmExports["emscripten_stack_init"] != "undefined", "missing Wasm export: emscripten_stack_init");
  assert(typeof wasmExports["emscripten_stack_get_free"] != "undefined", "missing Wasm export: emscripten_stack_get_free");
  assert(typeof wasmExports["_emscripten_stack_restore"] != "undefined", "missing Wasm export: _emscripten_stack_restore");
  assert(typeof wasmExports["_emscripten_stack_alloc"] != "undefined", "missing Wasm export: _emscripten_stack_alloc");
  assert(typeof wasmExports["emscripten_stack_get_current"] != "undefined", "missing Wasm export: emscripten_stack_get_current");
  assert(typeof wasmExports["__set_stack_limits"] != "undefined", "missing Wasm export: __set_stack_limits");
  assert(typeof wasmExports["memory"] != "undefined", "missing Wasm export: memory");
  assert(typeof wasmExports["__indirect_function_table"] != "undefined", "missing Wasm export: __indirect_function_table");
  ___getTypeName = createExportWrapper("__getTypeName", 1);
  _malloc = createExportWrapper("malloc", 1);
  _free = createExportWrapper("free", 1);
  _winmod_emsc_release_pointers = Module["_winmod_emsc_release_pointers"] = createExportWrapper("winmod_emsc_release_pointers", 0);
  _emsc_on_config_fs_ready = Module["_emsc_on_config_fs_ready"] = createExportWrapper("emsc_on_config_fs_ready", 0);
  _emsc_on_config_fs_failed = Module["_emsc_on_config_fs_failed"] = createExportWrapper("emsc_on_config_fs_failed", 0);
  _main = Module["_main"] = createExportWrapper("__main_argc_argv", 2);
  __sapp_emsc_onpaste = Module["__sapp_emsc_onpaste"] = createExportWrapper("_sapp_emsc_onpaste", 1);
  __sapp_html5_get_ask_leave_site = Module["__sapp_html5_get_ask_leave_site"] = createExportWrapper("_sapp_html5_get_ask_leave_site", 0);
  __sapp_emsc_begin_drop = Module["__sapp_emsc_begin_drop"] = createExportWrapper("_sapp_emsc_begin_drop", 1);
  __sapp_emsc_drop = Module["__sapp_emsc_drop"] = createExportWrapper("_sapp_emsc_drop", 2);
  __sapp_emsc_end_drop = Module["__sapp_emsc_end_drop"] = createExportWrapper("_sapp_emsc_end_drop", 3);
  __sapp_emsc_invoke_fetch_cb = Module["__sapp_emsc_invoke_fetch_cb"] = createExportWrapper("_sapp_emsc_invoke_fetch_cb", 8);
  __sapp_emsc_set_fullscreen_flag = Module["__sapp_emsc_set_fullscreen_flag"] = createExportWrapper("_sapp_emsc_set_fullscreen_flag", 1);
  __sfetch_emsc_head_response = Module["__sfetch_emsc_head_response"] = createExportWrapper("_sfetch_emsc_head_response", 2);
  __sfetch_emsc_get_response = Module["__sfetch_emsc_get_response"] = createExportWrapper("_sfetch_emsc_get_response", 3);
  __sfetch_emsc_failed_http_status = Module["__sfetch_emsc_failed_http_status"] = createExportWrapper("_sfetch_emsc_failed_http_status", 2);
  __sfetch_emsc_failed_buffer_too_small = Module["__sfetch_emsc_failed_buffer_too_small"] = createExportWrapper("_sfetch_emsc_failed_buffer_too_small", 1);
  __sfetch_emsc_failed_other = Module["__sfetch_emsc_failed_other"] = createExportWrapper("_sfetch_emsc_failed_other", 1);
  __saudio_emsc_pull = Module["__saudio_emsc_pull"] = createExportWrapper("_saudio_emsc_pull", 1);
  _fflush = createExportWrapper("fflush", 1);
  _strerror = createExportWrapper("strerror", 1);
  _emwgpuCreateBindGroup = createExportWrapper("emwgpuCreateBindGroup", 1);
  _emwgpuCreateBindGroupLayout = createExportWrapper("emwgpuCreateBindGroupLayout", 1);
  _emwgpuCreateCommandBuffer = createExportWrapper("emwgpuCreateCommandBuffer", 1);
  _emwgpuCreateCommandEncoder = createExportWrapper("emwgpuCreateCommandEncoder", 1);
  _emwgpuCreateComputePassEncoder = createExportWrapper("emwgpuCreateComputePassEncoder", 1);
  _emwgpuCreateComputePipeline = createExportWrapper("emwgpuCreateComputePipeline", 1);
  _emwgpuCreatePipelineLayout = createExportWrapper("emwgpuCreatePipelineLayout", 1);
  _emwgpuCreateQuerySet = createExportWrapper("emwgpuCreateQuerySet", 1);
  _emwgpuCreateRenderBundle = createExportWrapper("emwgpuCreateRenderBundle", 1);
  _emwgpuCreateRenderBundleEncoder = createExportWrapper("emwgpuCreateRenderBundleEncoder", 1);
  _emwgpuCreateRenderPassEncoder = createExportWrapper("emwgpuCreateRenderPassEncoder", 1);
  _emwgpuCreateRenderPipeline = createExportWrapper("emwgpuCreateRenderPipeline", 1);
  _emwgpuCreateSampler = createExportWrapper("emwgpuCreateSampler", 1);
  _emwgpuCreateSurface = createExportWrapper("emwgpuCreateSurface", 1);
  _emwgpuCreateTexture = createExportWrapper("emwgpuCreateTexture", 1);
  _emwgpuCreateTextureView = createExportWrapper("emwgpuCreateTextureView", 1);
  _emwgpuCreateAdapter = createExportWrapper("emwgpuCreateAdapter", 1);
  _emwgpuCreateBuffer = createExportWrapper("emwgpuCreateBuffer", 2);
  _emwgpuCreateDevice = createExportWrapper("emwgpuCreateDevice", 2);
  _emwgpuCreateQueue = createExportWrapper("emwgpuCreateQueue", 1);
  _emwgpuCreateShaderModule = createExportWrapper("emwgpuCreateShaderModule", 1);
  _emwgpuOnCompilationInfoCompleted = createExportWrapper("emwgpuOnCompilationInfoCompleted", 3);
  _emwgpuOnCreateComputePipelineCompleted = createExportWrapper("emwgpuOnCreateComputePipelineCompleted", 4);
  _emwgpuOnCreateRenderPipelineCompleted = createExportWrapper("emwgpuOnCreateRenderPipelineCompleted", 4);
  _emwgpuOnDeviceLostCompleted = createExportWrapper("emwgpuOnDeviceLostCompleted", 3);
  _emwgpuOnMapAsyncCompleted = createExportWrapper("emwgpuOnMapAsyncCompleted", 3);
  _emwgpuOnPopErrorScopeCompleted = createExportWrapper("emwgpuOnPopErrorScopeCompleted", 4);
  _emwgpuOnRequestAdapterCompleted = createExportWrapper("emwgpuOnRequestAdapterCompleted", 4);
  _emwgpuOnRequestDeviceCompleted = createExportWrapper("emwgpuOnRequestDeviceCompleted", 4);
  _emwgpuOnWorkDoneCompleted = createExportWrapper("emwgpuOnWorkDoneCompleted", 2);
  _emwgpuOnUncapturedError = createExportWrapper("emwgpuOnUncapturedError", 3);
  _emscripten_stack_get_end = wasmExports["emscripten_stack_get_end"];
  _emscripten_stack_get_base = wasmExports["emscripten_stack_get_base"];
  _sbrk = createExportWrapper("sbrk", 1);
  _memalign = createExportWrapper("memalign", 2);
  _emscripten_get_sbrk_ptr = wasmExports["emscripten_get_sbrk_ptr"];
  _setThrew = createExportWrapper("setThrew", 2);
  _emscripten_stack_init = wasmExports["emscripten_stack_init"];
  _emscripten_stack_get_free = wasmExports["emscripten_stack_get_free"];
  __emscripten_stack_restore = wasmExports["_emscripten_stack_restore"];
  __emscripten_stack_alloc = wasmExports["_emscripten_stack_alloc"];
  _emscripten_stack_get_current = wasmExports["emscripten_stack_get_current"];
  ___set_stack_limits = Module["___set_stack_limits"] = createExportWrapper("__set_stack_limits", 2);
  memory = wasmMemory = wasmExports["memory"];
  __indirect_function_table = wasmTable = wasmExports["__indirect_function_table"];
}

var wasmImports = {
  /** @export */ __assert_fail: ___assert_fail,
  /** @export */ __handle_stack_overflow: ___handle_stack_overflow,
  /** @export */ __syscall_fcntl64: ___syscall_fcntl64,
  /** @export */ __syscall_fstat64: ___syscall_fstat64,
  /** @export */ __syscall_ftruncate64: ___syscall_ftruncate64,
  /** @export */ __syscall_getdents64: ___syscall_getdents64,
  /** @export */ __syscall_ioctl: ___syscall_ioctl,
  /** @export */ __syscall_lstat64: ___syscall_lstat64,
  /** @export */ __syscall_mkdirat: ___syscall_mkdirat,
  /** @export */ __syscall_newfstatat: ___syscall_newfstatat,
  /** @export */ __syscall_openat: ___syscall_openat,
  /** @export */ __syscall_stat64: ___syscall_stat64,
  /** @export */ _abort_js: __abort_js,
  /** @export */ _embind_register_bigint: __embind_register_bigint,
  /** @export */ _embind_register_bool: __embind_register_bool,
  /** @export */ _embind_register_emval: __embind_register_emval,
  /** @export */ _embind_register_float: __embind_register_float,
  /** @export */ _embind_register_integer: __embind_register_integer,
  /** @export */ _embind_register_memory_view: __embind_register_memory_view,
  /** @export */ _embind_register_std_string: __embind_register_std_string,
  /** @export */ _embind_register_std_wstring: __embind_register_std_wstring,
  /** @export */ _embind_register_void: __embind_register_void,
  /** @export */ _gmtime_js: __gmtime_js,
  /** @export */ _localtime_js: __localtime_js,
  /** @export */ _mktime_js: __mktime_js,
  /** @export */ _timegm_js: __timegm_js,
  /** @export */ _tzset_js: __tzset_js,
  /** @export */ alignfault,
  /** @export */ emsc_mount_config_fs,
  /** @export */ emsc_sync_config_fs_load,
  /** @export */ emscripten_asm_const_int: _emscripten_asm_const_int,
  /** @export */ emscripten_cancel_main_loop: _emscripten_cancel_main_loop,
  /** @export */ emscripten_console_log: _emscripten_console_log,
  /** @export */ emscripten_date_now: _emscripten_date_now,
  /** @export */ emscripten_err: _emscripten_err,
  /** @export */ emscripten_get_device_pixel_ratio: _emscripten_get_device_pixel_ratio,
  /** @export */ emscripten_get_element_css_size: _emscripten_get_element_css_size,
  /** @export */ emscripten_get_now: _emscripten_get_now,
  /** @export */ emscripten_has_asyncify: _emscripten_has_asyncify,
  /** @export */ emscripten_performance_now: _emscripten_performance_now,
  /** @export */ emscripten_request_animation_frame_loop: _emscripten_request_animation_frame_loop,
  /** @export */ emscripten_resize_heap: _emscripten_resize_heap,
  /** @export */ emscripten_set_blur_callback_on_thread: _emscripten_set_blur_callback_on_thread,
  /** @export */ emscripten_set_canvas_element_size: _emscripten_set_canvas_element_size,
  /** @export */ emscripten_set_deviceorientation_callback_on_thread: _emscripten_set_deviceorientation_callback_on_thread,
  /** @export */ emscripten_set_focus_callback_on_thread: _emscripten_set_focus_callback_on_thread,
  /** @export */ emscripten_set_fullscreenchange_callback_on_thread: _emscripten_set_fullscreenchange_callback_on_thread,
  /** @export */ emscripten_set_keydown_callback_on_thread: _emscripten_set_keydown_callback_on_thread,
  /** @export */ emscripten_set_keypress_callback_on_thread: _emscripten_set_keypress_callback_on_thread,
  /** @export */ emscripten_set_keyup_callback_on_thread: _emscripten_set_keyup_callback_on_thread,
  /** @export */ emscripten_set_main_loop: _emscripten_set_main_loop,
  /** @export */ emscripten_set_mousedown_callback_on_thread: _emscripten_set_mousedown_callback_on_thread,
  /** @export */ emscripten_set_mouseenter_callback_on_thread: _emscripten_set_mouseenter_callback_on_thread,
  /** @export */ emscripten_set_mouseleave_callback_on_thread: _emscripten_set_mouseleave_callback_on_thread,
  /** @export */ emscripten_set_mousemove_callback_on_thread: _emscripten_set_mousemove_callback_on_thread,
  /** @export */ emscripten_set_mouseup_callback_on_thread: _emscripten_set_mouseup_callback_on_thread,
  /** @export */ emscripten_set_pointerlockchange_callback_on_thread: _emscripten_set_pointerlockchange_callback_on_thread,
  /** @export */ emscripten_set_pointerlockerror_callback_on_thread: _emscripten_set_pointerlockerror_callback_on_thread,
  /** @export */ emscripten_set_resize_callback_on_thread: _emscripten_set_resize_callback_on_thread,
  /** @export */ emscripten_set_touchcancel_callback_on_thread: _emscripten_set_touchcancel_callback_on_thread,
  /** @export */ emscripten_set_touchend_callback_on_thread: _emscripten_set_touchend_callback_on_thread,
  /** @export */ emscripten_set_touchmove_callback_on_thread: _emscripten_set_touchmove_callback_on_thread,
  /** @export */ emscripten_set_touchstart_callback_on_thread: _emscripten_set_touchstart_callback_on_thread,
  /** @export */ emscripten_set_wheel_callback_on_thread: _emscripten_set_wheel_callback_on_thread,
  /** @export */ emwgpuAdapterRequestDevice: _emwgpuAdapterRequestDevice,
  /** @export */ emwgpuBufferGetMappedRange: _emwgpuBufferGetMappedRange,
  /** @export */ emwgpuBufferUnmap: _emwgpuBufferUnmap,
  /** @export */ emwgpuDelete: _emwgpuDelete,
  /** @export */ emwgpuDeviceCreateBuffer: _emwgpuDeviceCreateBuffer,
  /** @export */ emwgpuDeviceCreateShaderModule: _emwgpuDeviceCreateShaderModule,
  /** @export */ emwgpuDeviceDestroy: _emwgpuDeviceDestroy,
  /** @export */ emwgpuGetPreferredFormat: _emwgpuGetPreferredFormat,
  /** @export */ emwgpuInstanceRequestAdapter: _emwgpuInstanceRequestAdapter,
  /** @export */ environ_get: _environ_get,
  /** @export */ environ_sizes_get: _environ_sizes_get,
  /** @export */ exit: _exit,
  /** @export */ fd_close: _fd_close,
  /** @export */ fd_read: _fd_read,
  /** @export */ fd_seek: _fd_seek,
  /** @export */ fd_write: _fd_write,
  /** @export */ js_request_device_orientation_permission,
  /** @export */ numeris_analytics_net_js_poll_http,
  /** @export */ numeris_analytics_net_js_post,
  /** @export */ numeris_awaken_js_hide_loader,
  /** @export */ numeris_device_js_class_hint,
  /** @export */ numeris_device_js_fill_env,
  /** @export */ numeris_device_js_os_hint,
  /** @export */ numeris_id_js_fill_random,
  /** @export */ numeris_identity_js_now_ms,
  /** @export */ numeris_text_js_arm,
  /** @export */ numeris_text_js_boot,
  /** @export */ numeris_text_js_focused_i,
  /** @export */ numeris_text_js_get,
  /** @export */ numeris_text_js_move,
  /** @export */ numeris_text_js_open,
  /** @export */ numeris_text_js_sel,
  /** @export */ numeris_text_js_set,
  /** @export */ numeris_text_js_set_scroll,
  /** @export */ numeris_text_js_set_sel,
  /** @export */ numeris_text_js_touch_ime,
  /** @export */ numeris_web_is_fullscreen,
  /** @export */ numeris_web_toggle_fullscreen,
  /** @export */ numeris_web_vis_frac,
  /** @export */ phone_cam_tilt_js_ask_permission,
  /** @export */ phone_cam_tilt_js_set_lock,
  /** @export */ phone_cam_tilt_js_setup,
  /** @export */ sapp_js_add_beforeunload_listener,
  /** @export */ sapp_js_add_clipboard_listener,
  /** @export */ sapp_js_add_dragndrop_listeners,
  /** @export */ sapp_js_clear_favicon,
  /** @export */ sapp_js_destroy_custom_mouse_cursor,
  /** @export */ sapp_js_init,
  /** @export */ sapp_js_remove_beforeunload_listener,
  /** @export */ sapp_js_remove_clipboard_listener,
  /** @export */ sapp_js_remove_dragndrop_listeners,
  /** @export */ sapp_js_request_pointerlock,
  /** @export */ sapp_js_set_cursor,
  /** @export */ sapp_js_set_favicon,
  /** @export */ sapp_js_write_clipboard,
  /** @export */ saudio_js_buffer_frames,
  /** @export */ saudio_js_init,
  /** @export */ saudio_js_sample_rate,
  /** @export */ saudio_js_shutdown,
  /** @export */ segfault,
  /** @export */ sfetch_js_send_get_request,
  /** @export */ simgui_js_is_osx,
  /** @export */ slog_js_log,
  /** @export */ sound_worker_proto_js_audio_ready,
  /** @export */ sound_worker_proto_js_audio_time,
  /** @export */ sound_worker_proto_js_begin_graceful_shutdown,
  /** @export */ sound_worker_proto_js_capture_audio,
  /** @export */ sound_worker_proto_js_capture_status,
  /** @export */ sound_worker_proto_js_expect_frames,
  /** @export */ sound_worker_proto_js_graceful_shutdown_sync,
  /** @export */ sound_worker_proto_js_has_bus,
  /** @export */ sound_worker_proto_js_output_audible,
  /** @export */ sound_worker_proto_js_page_hidden,
  /** @export */ sound_worker_proto_js_page_inactive,
  /** @export */ sound_worker_proto_js_poll,
  /** @export */ sound_worker_proto_js_push_pcm,
  /** @export */ sound_worker_proto_js_set_echo,
  /** @export */ sound_worker_proto_js_set_master,
  /** @export */ sound_worker_proto_js_start,
  /** @export */ sound_worker_proto_js_start_audio,
  /** @export */ sound_worker_proto_js_stop,
  /** @export */ sound_worker_proto_js_stop_all,
  /** @export */ wgpuAdapterGetLimits: _wgpuAdapterGetLimits,
  /** @export */ wgpuAdapterHasFeature: _wgpuAdapterHasFeature,
  /** @export */ wgpuCommandEncoderBeginComputePass: _wgpuCommandEncoderBeginComputePass,
  /** @export */ wgpuCommandEncoderBeginRenderPass: _wgpuCommandEncoderBeginRenderPass,
  /** @export */ wgpuCommandEncoderFinish: _wgpuCommandEncoderFinish,
  /** @export */ wgpuComputePassEncoderEnd: _wgpuComputePassEncoderEnd,
  /** @export */ wgpuComputePassEncoderSetBindGroup: _wgpuComputePassEncoderSetBindGroup,
  /** @export */ wgpuComputePassEncoderSetPipeline: _wgpuComputePassEncoderSetPipeline,
  /** @export */ wgpuDeviceCreateBindGroup: _wgpuDeviceCreateBindGroup,
  /** @export */ wgpuDeviceCreateBindGroupLayout: _wgpuDeviceCreateBindGroupLayout,
  /** @export */ wgpuDeviceCreateCommandEncoder: _wgpuDeviceCreateCommandEncoder,
  /** @export */ wgpuDeviceCreateComputePipeline: _wgpuDeviceCreateComputePipeline,
  /** @export */ wgpuDeviceCreatePipelineLayout: _wgpuDeviceCreatePipelineLayout,
  /** @export */ wgpuDeviceCreateRenderPipeline: _wgpuDeviceCreateRenderPipeline,
  /** @export */ wgpuDeviceCreateSampler: _wgpuDeviceCreateSampler,
  /** @export */ wgpuDeviceCreateTexture: _wgpuDeviceCreateTexture,
  /** @export */ wgpuDeviceGetLimits: _wgpuDeviceGetLimits,
  /** @export */ wgpuDeviceHasFeature: _wgpuDeviceHasFeature,
  /** @export */ wgpuInstanceCreateSurface: _wgpuInstanceCreateSurface,
  /** @export */ wgpuQueueSubmit: _wgpuQueueSubmit,
  /** @export */ wgpuQueueWriteBuffer: _wgpuQueueWriteBuffer,
  /** @export */ wgpuQueueWriteTexture: _wgpuQueueWriteTexture,
  /** @export */ wgpuRenderPassEncoderDraw: _wgpuRenderPassEncoderDraw,
  /** @export */ wgpuRenderPassEncoderDrawIndexed: _wgpuRenderPassEncoderDrawIndexed,
  /** @export */ wgpuRenderPassEncoderEnd: _wgpuRenderPassEncoderEnd,
  /** @export */ wgpuRenderPassEncoderSetBindGroup: _wgpuRenderPassEncoderSetBindGroup,
  /** @export */ wgpuRenderPassEncoderSetBlendConstant: _wgpuRenderPassEncoderSetBlendConstant,
  /** @export */ wgpuRenderPassEncoderSetIndexBuffer: _wgpuRenderPassEncoderSetIndexBuffer,
  /** @export */ wgpuRenderPassEncoderSetPipeline: _wgpuRenderPassEncoderSetPipeline,
  /** @export */ wgpuRenderPassEncoderSetScissorRect: _wgpuRenderPassEncoderSetScissorRect,
  /** @export */ wgpuRenderPassEncoderSetStencilReference: _wgpuRenderPassEncoderSetStencilReference,
  /** @export */ wgpuRenderPassEncoderSetVertexBuffer: _wgpuRenderPassEncoderSetVertexBuffer,
  /** @export */ wgpuRenderPassEncoderSetViewport: _wgpuRenderPassEncoderSetViewport,
  /** @export */ wgpuSurfaceConfigure: _wgpuSurfaceConfigure,
  /** @export */ wgpuSurfaceGetCurrentTexture: _wgpuSurfaceGetCurrentTexture,
  /** @export */ wgpuTextureCreateView: _wgpuTextureCreateView
};

// include: postamble.js
// === Auto-generated postamble setup entry stuff ===
var calledRun;

function callMain(args = []) {
  assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on Module["onRuntimeInitialized"])');
  assert(typeof onPreRuns === "undefined" || onPreRuns.length == 0, "cannot call main when preRun functions remain to be called");
  var entryFunction = _main;
  args.unshift(thisProgram);
  var argc = args.length;
  var argv = stackAlloc((argc + 1) * 4);
  var argv_ptr = argv;
  for (var arg of args) {
    HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((argv_ptr) >> 2), "storing")] = stringToUTF8OnStack(arg);
    argv_ptr += 4;
  }
  HEAPU32[SAFE_HEAP_INDEX(HEAPU32, ((argv_ptr) >> 2), "storing")] = 0;
  try {
    var ret = entryFunction(argc, argv);
    // if we're not running an evented main loop, it's time to exit
    exitJS(ret, /* implicit = */ true);
    return ret;
  } catch (e) {
    return handleException(e);
  }
}

function stackCheckInit() {
  // This is normally called automatically during __wasm_call_ctors but need to
  // get these values before even running any of the ctors so we call it redundantly
  // here.
  _emscripten_stack_init();
  // TODO(sbc): Move writeStackCookie to native to to avoid this.
  writeStackCookie();
}

function run(args = arguments_) {
  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }
  stackCheckInit();
  preRun();
  // a preRun added a dependency, run will be called later
  if (runDependencies > 0) {
    dependenciesFulfilled = run;
    return;
  }
  function doRun() {
    // run may have just been called through dependencies being fulfilled just in this very frame,
    // or while the async setStatus time below was happening
    assert(!calledRun);
    calledRun = true;
    Module["calledRun"] = true;
    if (ABORT) return;
    initRuntime();
    preMain();
    Module["onRuntimeInitialized"]?.();
    consumedModuleProp("onRuntimeInitialized");
    var noInitialRun = Module["noInitialRun"] || false;
    if (!noInitialRun) callMain(args);
    postRun();
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(() => {
      setTimeout(() => Module["setStatus"](""), 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
  checkStackCookie();
}

function checkUnflushedContent() {
  // Compiler settings do not allow exiting the runtime, so flushing
  // the streams is not possible. but in ASSERTIONS mode we check
  // if there was something to flush, and if so tell the user they
  // should request that the runtime be exitable.
  // Normally we would not even include flush() at all, but in ASSERTIONS
  // builds we do so just for this check, and here we see if there is any
  // content to flush, that is, we check if there would have been
  // something a non-ASSERTIONS build would have not seen.
  // How we flush the streams depends on whether we are in SYSCALLS_REQUIRE_FILESYSTEM=0
  // mode (which has its own special function for this; otherwise, all
  // the code is inside libc)
  var oldOut = out;
  var oldErr = err;
  var has = false;
  out = err = x => {
    has = true;
  };
  try {
    // it doesn't matter if it fails
    _fflush(0);
    // also flush in the JS FS layer
    for (var name of [ "stdout", "stderr" ]) {
      var info = FS.analyzePath("/dev/" + name);
      if (!info) return;
      var stream = info.object;
      var rdev = stream.rdev;
      var tty = TTY.ttys[rdev];
      if (tty?.output?.length) {
        has = true;
      }
    }
  } catch (e) {}
  out = oldOut;
  err = oldErr;
  if (has) {
    warnOnce("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
  }
}

var wasmExports;

// With async instantation wasmExports is assigned asynchronously when the
// instance is received.
createWasm();

run();
