/* Numeris web: copy pane/layout/Rc next to App, then pull them into MEMFS
 * before main() (no --preload-file / file_packager).
 * Linked with: --pre-js web/fs_assets.js
 */
(function () {
  var M = (typeof Module !== "undefined") ? Module : (window.Module = window.Module || {});
  M.preRun = M.preRun || [];

  var ASSETS = [
    "pane/options.pane",
    "layout/layout.json",
    "Rc/font/legacy_clean.sdffont.json",
    "Rc/defaults/app.json",
    "Rc/localization/en.json",
    "Rc/localization/fr.json"
  ];

  function ensureDir(path) {
    var parts = path.split("/");
    var dir = "";
    for (var i = 0; i < parts.length - 1; i++) {
      dir = dir ? (dir + "/" + parts[i]) : parts[i];
      try { FS.mkdir(dir); } catch (e) { /* exists */ }
    }
  }

  function assetUrl(path) {
    var v = "dev", t = Date.now(), sep;
    try {
      if (typeof window !== "undefined") {
        if (typeof window.getCurrentVersion === "function")
          v = window.getCurrentVersion() || v;
        if (window.__spinBootTok) t = window.__spinBootTok;
      }
    } catch (e) {}
    sep = path.indexOf("?") >= 0 ? "&" : "?";
    return path + sep + "_v=" + encodeURIComponent(v) + "&_t=" + t;
  }

  function fnv1a32(bytes) {
    var hash = 0x811c9dc5, hex;
    for (var i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
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
      console.info("[fs_assets][sdf-diag] bytes=" + bytes.byteLength +
        " fnv1a32=" + fnv1a32(bytes) +
        " declared=" + (doc.glyph_count | 0) +
        " nodes=" + keys.length +
        " U+0047=" + (gKey || "MISSING"));
    } catch (err) {
      console.error("[fs_assets][sdf-diag] parse failed bytes=" + bytes.byteLength +
        " fnv1a32=" + fnv1a32(bytes), err);
    }
  }

  function loadOne(path) {
    var dep = "numeris_asset:" + path;
    addRunDependency(dep);
    fetch(assetUrl(path), { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(path + " HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      ensureDir(path);
      FS.writeFile(path, bytes);
      if (typeof console !== "undefined" && console.info)
        console.info("[fs_assets] mounted", path, "(" + buf.byteLength + " bytes)");
      logSdfFontDiag(path, bytes);
      removeRunDependency(dep);
    }).catch(function (err) {
      if (typeof console !== "undefined" && console.error)
        console.error("[fs_assets] failed", path, err);
      removeRunDependency(dep);
    });
  }

  M.preRun.push(function () {
    for (var i = 0; i < ASSETS.length; i++) loadOne(ASSETS[i]);
  });
})();
