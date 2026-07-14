/* version.js */
(function(){
    "use strict";

    var VERSION_FILE = "version.txt";
    var DEFAULT_VERSION = "dev";
    var VERSION_KEY = "siteVersion";
    var RELOAD_KEY = "lastReloadVersion";

    function isLocalDevelopmentHost(){
        var host = location.hostname;

        return (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "::1" ||
            host.indexOf("192.168.") === 0
        );
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

    function getCurrentVersion(){
        return (
            getPageVersion() ||
            readStorage(localStorage,VERSION_KEY) ||
            DEFAULT_VERSION
        );
    }

    window.getCurrentVersion =
        getCurrentVersion;

    var storedVersion =
        readStorage(localStorage,VERSION_KEY);

    var pageVersion =
        getPageVersion();

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

        if(typeof window.spinviewUpdateVersionLabel === "function"){
            window.spinviewUpdateVersionLabel();
        }

        if(pageVersion === remoteVersion){
            return;
        }

        /*
            Local development hosts update the stored version
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
    });
})();