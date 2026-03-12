(function() {
    var el = document.getElementById("debugConsole");
    if (!el) {
        return;
    }

    var oldLog = console.log;
    var oldWarn = console.warn;
    var oldError = console.error;

    function write(prefix, args) {
        var parts = [];
        var i;

        for (i = 0; i < args.length; i++) {
            var v = args[i];
            if (typeof v === "object") {
                try {
                    parts.push(JSON.stringify(v));
                } catch (_) {
                    parts.push(String(v));
                }
            } else {
                parts.push(String(v));
            }
        }

        el.textContent += prefix + parts.join(" ") + "\n";
        el.scrollTop = el.scrollHeight;
    }

    console.log = function() {
        oldLog.apply(console, arguments);
        write("", arguments);
    };

    console.warn = function() {
        oldWarn.apply(console, arguments);
        write("[warn] ", arguments);
    };

    console.error = function() {
        oldError.apply(console, arguments);
        write("[error] ", arguments);
    };
})();