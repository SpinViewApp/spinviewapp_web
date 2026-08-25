/* version.js */
(function(){
    "use strict";

    var VERSION_FILE = "version.txt";
    var DEFAULT_VERSION = "dev";

    /* Same reason as above: scope what is left in storage to this app's own
       path, so two apps under one host never read each other's counters. */
    var SCOPE = (function(){
        try{ return location.pathname.replace(/[^/]*$/, ""); }
        catch(error){ return "/"; }
    })();
    var VERSION_KEY = "siteVersion:" + SCOPE;
    var RELOAD_KEY = "lastReloadVersion:" + SCOPE;

    function isLocalDevelopmentHost(){
        var host = location.hostname;

        return (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host.indexOf("192.168.") === 0
        );
    }

    function hasDebugParameter(){
        return /(?:^|[?&])(?:dev|debug)(?:[=&]|$)/i.test(location.search);
    }

    function readStorage(storage,key){
        try{
            return storage.getItem(key) || "";
        }
        catch(error){
            return "";
        }
    }

    function writeStorage(storage,key,value){
        try{
            storage.setItem(key,value);
        }
        catch(error){
        }
    }

    function getPageVersion(){
        try{
            return (
                new URL(location.href)
                    .searchParams
                    .get("_v") ||
                ""
            );
        }
        catch(error){
            return "";
        }
    }

    /*
        THE FROZEN VERSION COMES FROM THE URL OR NOWHERE.

        localStorage is per ORIGIN, not per app. Several apps served from the
        same host - spinview.app/nanite, /numeris, /raytracer, or one local
        port pointed at a different build folder from one day to the next -
        share this key. Seeding the freeze from it made a page cache-bust
        itself with ANOTHER app's version, and the label then disagreed with
        the number in the log.

        So: ?_v when the page carries one (authoritative, and production puts
        it there with the reload below), otherwise "dev". Cache-busting does
        not suffer - every URL also carries a per-load _t. The real version is
        pushed to the label by spinviewSetDisplayVersion as soon as
        version.txt lands.
    */
    function getCurrentVersion(){
        return getPageVersion() || DEFAULT_VERSION;
    }

    function updateDebugState(){
        var enabled =
            hasDebugParameter() ||
            isLocalDevelopmentHost();

        window.spinviewDebugEnabled = enabled;

        if(typeof window.spinviewSetDebugEnabled === "function"){
            window.spinviewSetDebugEnabled(enabled);
        }

        if(typeof window.spinviewUpdateVersionLabel === "function"){
            window.spinviewUpdateVersionLabel();
        }
    }

    window.getCurrentVersion = getCurrentVersion;
    window.spinviewHasDebugParameter = hasDebugParameter;
    window.spinviewIsLocalDevelopmentHost = isLocalDevelopmentHost;
    window.spinviewDebugEnabled =
        hasDebugParameter() ||
        isLocalDevelopmentHost();

    var storedVersion =
        readStorage(localStorage,VERSION_KEY);

    var pageVersion =
        getPageVersion();

    updateDebugState();

    fetch(
        VERSION_FILE + "?_=" + Date.now(),
        {
            cache:"no-store"
        }
    )
    .then(function(response){
        if(!response.ok){
            throw new Error(
                "HTTP " + response.status
            );
        }

        return response.text();
    })
    .then(function(remoteVersion){
        var lastReloadVersion;
        var url;

        remoteVersion =
            remoteVersion.trim();

        if(!remoteVersion){
            return;
        }

        writeStorage(
            localStorage,
            VERSION_KEY,
            remoteVersion
        );

        /* Label: the shell froze its version before this fetch answered. */
        if(typeof window.spinviewSetDisplayVersion === "function"){
            window.spinviewSetDisplayVersion(remoteVersion);
        }

        updateDebugState();

        if(pageVersion === remoteVersion){
            return;
        }

        /*
            Local development hosts update the stored version,
            but never force a reload.
        */
        if(isLocalDevelopmentHost()){
            return;
        }

        lastReloadVersion =
            readStorage(
                sessionStorage,
                RELOAD_KEY
            );

        if(lastReloadVersion === remoteVersion){
            return;
        }

        writeStorage(
            sessionStorage,
            RELOAD_KEY,
            remoteVersion
        );

        url = new URL(location.href);

        /*
            Existing parameters such as ?debug are preserved.
        */
        url.searchParams.set(
            "_v",
            remoteVersion
        );

        location.replace(
            url.toString()
        );
    })
    .catch(function(error){
        console.warn(
            "[version] Could not load version.txt.",
            "Using version:",
            storedVersion ||
            pageVersion ||
            DEFAULT_VERSION,
            error
        );

        updateDebugState();
    });
})();