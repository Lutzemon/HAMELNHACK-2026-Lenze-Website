(() => {
    "use strict";

    const byId = (id) => document.getElementById(id);
    const defaults = {
        robotName: "Lenze / Roboter 01",
        endpoint: "",
        apiUrl: "",
        forwardApi: false,
        limitX: 500,
        limitY: 500,
        limitZ: 400,
        language: "de-DE",
        forwardTranscript: false,
        showGrid: true,
        showActual: true,
        actualOpacity: 30,
        units: "mm",
        sendInterim: true,
        autoRestart: true
    };
    const storageKey = "lenze-motion-settings-v2";
    let settings = { ...defaults };
    let target = { x: 240, y: 125, z: 180 };
    let telemetry = null;
    let gripper = "open";
    let targetLocked = false;
    let apiQueue = [];
    let apiRequest = null;
    let apiGeneration = 0;
    let apiDelivered = 0;
    let socket = null;
    let connectionTimer = null;
    let streamSequence = 0;
    let messageCount = 0;
    let confirmedText = "";
    let visibleText = "";
    let session = null;
    let phase = "idle";
    let wantsRecording = false;
    let restartTimer = null;
    let endReason = "ended";
    let speechError = false;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = Recognition ? new Recognition() : null;

    function notice(text) {
        byId("appNotice").textContent = text;
    }

    function validateSetting(key, value) {
        if (typeof defaults[key] === "boolean") return typeof value === "boolean" ? value : defaults[key];
        if (["limitX", "limitY", "limitZ"].includes(key)) {
            return Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10000 ? Number(value) : defaults[key];
        }
        if (key === "actualOpacity") return Math.max(10, Math.min(80, Number(value) || 30));
        if (key === "language") return ["de-DE", "en-US"].includes(value) ? value : defaults[key];
        if (key === "units") return ["mm", "cm"].includes(value) ? value : defaults[key];
        return typeof value === "string" ? value.slice(0, key === "robotName" ? 60 : 2000) : defaults[key];
    }

    function loadSettings() {
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");
            for (const key of Object.keys(defaults)) {
                if (stored && Object.hasOwn(stored, key)) settings[key] = validateSetting(key, stored[key]);
            }
        } catch {
            notice("Gespeicherte Einstellungen konnten nicht geladen werden. Standardwerte sind aktiv.");
        }
        for (const key of Object.keys(defaults)) {
            if (typeof defaults[key] === "boolean") byId(key).checked = settings[key];
            else byId(key).value = settings[key];
        }
        applySettings();
    }

    function persistSettings() {
        try {
            localStorage.setItem(storageKey, JSON.stringify(settings));
            notice("Einstellungen auf diesem Gerät gespeichert.");
        } catch {
            notice("Einstellungen gelten für diese Sitzung. Lokales Speichern ist nicht verfügbar.");
        }
    }

    function applySettings() {
        byId("workspaceName").textContent = settings.robotName || defaults.robotName;
        document.querySelector(".grid-layer").style.display = settings.showGrid ? "" : "none";
        byId("actualArm").style.opacity = settings.actualOpacity / 100;
        target.x = Math.max(0, Math.min(settings.limitX, target.x));
        target.y = Math.max(0, Math.min(settings.limitY, target.y));
        target.z = Math.max(0, Math.min(settings.limitZ, target.z));
        byId("heightControl").max = settings.limitZ;
        byId("heightControl").value = target.z;
        renderRobot();
        updateStreamStatus();
    }

    for (const key of Object.keys(defaults)) {
        const input = byId(key);
        input.addEventListener("change", () => {
            if (input.type === "number" && !input.checkValidity()) {
                input.reportValidity();
                input.value = settings[key];
                return;
            }
            settings[key] = validateSetting(key, input.type === "checkbox" ? input.checked : input.value);
            if (key === "apiUrl" || key === "forwardApi") {
                cancelApiRequests();
                if (settings.forwardApi && !validApiUrl()) {
                    settings.forwardApi = false;
                    byId("forwardApi").checked = false;
                    notice("Bitte zuerst eine gültige HTTP(S)-API-Adresse eintragen.");
                }
            }
            persistSettings();
            applySettings();
        });
    }
    byId("actualOpacity").addEventListener("input", () => {
        byId("actualArm").style.opacity = Number(byId("actualOpacity").value) / 100;
    });

    document.querySelectorAll(".nav-button").forEach((button) => {
        button.addEventListener("click", () => {
            document.querySelectorAll(".nav-button").forEach((item) => {
                item.classList.toggle("active", item === button);
                if (item === button) item.setAttribute("aria-current", "page");
                else item.removeAttribute("aria-current");
            });
            document.querySelectorAll(".page").forEach((page) => {
                page.hidden = page.id !== `page-${button.dataset.page}`;
            });
        });
    });

    function toggleFocus(force) {
        const active = typeof force === "boolean" ? force : !document.body.classList.contains("focus-mode");
        document.body.classList.toggle("focus-mode", active);
        byId("focusButton").setAttribute("aria-pressed", String(active));
        byId("focusButton").textContent = active ? "Ansicht schließen ⛶" : "Ansicht vergrößern ⛶";
    }
    byId("focusButton").addEventListener("click", () => toggleFocus());
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") toggleFocus(false);
    });

    function armGeometry(position) {
        const x = 90 + position.x / settings.limitX * 620;
        const y = 390 - position.y / settings.limitY * 280;
        const dx = x - 170;
        const dy = y - 420;
        const distance = Math.max(31, Math.min(629, Math.hypot(dx, dy)));
        const angle = Math.atan2(dy, dx) - Math.acos(Math.max(-1, Math.min(1, (330 ** 2 + distance ** 2 - 300 ** 2) / (2 * 330 * distance))));
        const jointX = 170 + Math.cos(angle) * 330;
        const jointY = 420 + Math.sin(angle) * 330;
        return { x, y, jointX, jointY, path: `M170 420 L${jointX} ${jointY} L${x} ${y}` };
    }

    function renderRobot() {
        const arm = armGeometry(target);
        byId("armPath").setAttribute("d", arm.path);
        byId("armShadow").setAttribute("d", arm.path);
        for (const [id, x, y] of [["armJoint", arm.jointX, arm.jointY], ["armTip", arm.x, arm.y]]) {
            byId(id).setAttribute("cx", x);
            byId(id).setAttribute("cy", y);
        }
        byId("targetMarker").setAttribute("transform", `translate(${arm.x} ${arm.y})`);
        byId("gripperDrawing").setAttribute("d", gripper === "open" ? "M-10-8V9L-5 15M10-8V9L5 15" : "M-5-8V9L0 15M5-8V9L0 15");
        const factor = settings.units === "cm" ? 10 : 1;
        for (const axis of ["x", "y", "z"]) byId(`coord${axis.toUpperCase()}`).textContent = String(Math.round(target[axis] / factor * 10) / 10);
        byId("unitLabel").textContent = settings.units;
        byId("gripperState").textContent = gripper === "open" ? "offen" : "geschlossen";
        byId("gripperButton").setAttribute("aria-pressed", String(gripper === "closed"));
        const showTelemetry = settings.showActual && telemetry !== null;
        byId("actualArm").setAttribute("visibility", showTelemetry ? "visible" : "hidden");
        if (showTelemetry) {
            const actual = armGeometry(telemetry.position);
            byId("actualPath").setAttribute("d", actual.path);
            byId("actualJoint").setAttribute("cx", actual.jointX);
            byId("actualJoint").setAttribute("cy", actual.jointY);
            byId("actualTip").setAttribute("cx", actual.x);
            byId("actualTip").setAttribute("cy", actual.y);
        }
    }

    function setTargetLocked(locked) {
        targetLocked = locked;
        byId("targetMode").textContent = locked ? "ZIEL FIXIERT" : "ZIEL WÄHLEN";
        byId("stageHint").textContent = locked ? "Phantomarm folgt den Roboterkoordinaten" : "Maus bewegen · Klick oder Tippen fixiert";
        byId("robotStage").classList.toggle("target-locked", locked);
        byId("unlockTargetButton").disabled = !locked;
        byId("heightControl").disabled = locked;
        byId("gripperButton").disabled = locked;
    }

    function updateTelemetry(message) {
        if (!message || message.type !== "telemetry" || message.units !== "mm") return false;
        const position = message.position;
        if (!position || !["x", "y", "z"].every((key) => typeof position[key] === "number" && Number.isFinite(position[key]) && position[key] >= 0 && position[key] <= settings[`limit${key.toUpperCase()}`])) return false;
        telemetry = { position: { x: position.x, y: position.y, z: position.z } };
        byId("telemetryLabel").textContent = `· ${new Date().toLocaleTimeString("de-DE")} / Z ${position.z} mm`;
        renderRobot();
        return true;
    }

    function moveTarget(event) {
        if (targetLocked) return;
        if (event.pointerType !== "mouse" && event.type !== "pointerdown" && !event.buttons) return;
        const rect = byId("robotDrawing").getBoundingClientRect();
        const scale = Math.min(rect.width / 800, rect.height / 500);
        const offsetX = rect.left + (rect.width - 800 * scale) / 2;
        const offsetY = rect.top + (rect.height - 500 * scale) / 2;
        target.x = Math.round(Math.max(0, Math.min(1, ((event.clientX - offsetX) / scale - 90) / 620)) * settings.limitX);
        target.y = Math.round(Math.max(0, Math.min(1, (390 - (event.clientY - offsetY) / scale) / 280)) * settings.limitY);
        renderRobot();
    }
    byId("robotStage").addEventListener("pointermove", moveTarget);
    byId("robotStage").addEventListener("pointerdown", (event) => {
        if (event.isPrimary === false || (event.button !== undefined && event.button !== 0) || targetLocked) return;
        moveTarget(event);
        setTargetLocked(true);
    });
    byId("unlockTargetButton").addEventListener("click", () => setTargetLocked(false));
    byId("robotStage").addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setTargetLocked(true);
            return;
        }
        if (targetLocked) return;
        const moves = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] };
        if (!moves[event.key]) return;
        event.preventDefault();
        target.x = Math.max(0, Math.min(settings.limitX, target.x + moves[event.key][0]));
        target.y = Math.max(0, Math.min(settings.limitY, target.y + moves[event.key][1]));
        renderRobot();
    });
    byId("heightControl").addEventListener("input", () => {
        if (targetLocked) return;
        target.z = Number(byId("heightControl").value);
        renderRobot();
    });
    byId("homeButton").addEventListener("click", () => {
        setTargetLocked(false);
        target = { x: settings.limitX / 2, y: settings.limitY / 2, z: settings.limitZ / 2 };
        gripper = "open";
        applySettings();
    });
    byId("gripperButton").addEventListener("click", () => {
        if (targetLocked) return;
        gripper = gripper === "open" ? "closed" : "open";
        renderRobot();
    });

    function isConnected() {
        return socket && socket.readyState === WebSocket.OPEN;
    }
    function sendMessage(message) {
        if (!isConnected()) return false;
        if (socket.bufferedAmount > 256 * 1024) {
            notice("Backend verarbeitet Daten zu langsam. Nachricht wurde nicht gesendet.");
            return false;
        }
        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch {
            notice("Nachricht konnte nicht gesendet werden.");
            return false;
        }
    }
    function updateStreamStatus() {
        const destinations = ["Browser-Events"];
        if (settings.forwardApi && validApiUrl()) destinations.push("HTTP-API");
        if (isConnected() && settings.forwardTranscript) destinations.push("WebSocket");
        byId("streamStatus").textContent = destinations.join(" + ");
        byId("apiStatus").textContent = !settings.apiUrl ? "API noch nicht konfiguriert." : settings.forwardApi && validApiUrl() ? `API aktiv · ${apiDelivered} bestätigt · ${apiQueue.length} warten` : "API-Weiterleitung pausiert.";
    }
    function updateConnection(text) {
        const connected = Boolean(isConnected());
        byId("headerConnection").textContent = connected ? "Backend verbunden" : "Lokal · nicht verbunden";
        byId("headerConnection").classList.toggle("connected", connected);
        byId("connectionStatus").textContent = text;
        byId("disconnectButton").disabled = !socket;
        byId("connectButton").disabled = Boolean(socket);
        byId("endpoint").disabled = Boolean(socket);
        byId("sendTargetButton").disabled = !connected;
        byId("targetStatus").textContent = connected ? "Ziele werden nur über den Button ans Backend gesendet." : "Nur lokale Vorschau. Keine Roboterverbindung.";
        updateStreamStatus();
    }
    function clearTelemetry() {
        telemetry = null;
        byId("telemetryLabel").textContent = "· keine Daten";
        renderRobot();
    }
    function disconnect() {
        clearTimeout(connectionTimer);
        const previous = socket;
        socket = null;
        if (previous) previous.close();
        clearTelemetry();
        updateConnection("Verbindung getrennt. Textstream bleibt lokal verfügbar.");
    }
    byId("connectButton").addEventListener("click", () => {
        if (socket) return;
        let url;
        try {
            url = new URL(byId("endpoint").value.trim());
            if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("URL");
            if (location.protocol === "https:" && url.protocol !== "wss:") throw new Error("TLS");
        } catch {
            byId("connectionStatus").textContent = "Gültige ws://- oder wss://-Adresse eingeben. Auf HTTPS ist wss:// erforderlich. Zugangsdaten nicht in die URL schreiben.";
            return;
        }
        try {
            settings.endpoint = url.href;
            persistSettings();
            const activeSocket = new WebSocket(url.href);
            socket = activeSocket;
            clearTelemetry();
            updateConnection("Verbindung wird aufgebaut …");
            connectionTimer = setTimeout(() => {
                if (socket !== activeSocket || isConnected()) return;
                disconnect();
                updateConnection("Zeitüberschreitung. Adresse und Backend prüfen.");
            }, 8000);
            activeSocket.addEventListener("open", () => {
                if (socket !== activeSocket) return;
                clearTimeout(connectionTimer);
                updateConnection("WebSocket verbunden. Nachrichtenformat muss zum Backend passen.");
            });
            activeSocket.addEventListener("message", (event) => {
                if (socket !== activeSocket) return;
                try {
                    if (!updateTelemetry(JSON.parse(event.data))) notice("Backend-Nachricht nicht übernommen: gültige Telemetrie in mm erwartet.");
                } catch {
                    notice("Backend-Nachricht ist kein gültiges JSON.");
                }
            });
            activeSocket.addEventListener("error", () => {
                if (socket === activeSocket) updateConnection("Verbindungsfehler. Backend-Adresse und Erreichbarkeit prüfen.");
            });
            activeSocket.addEventListener("close", () => {
                if (socket !== activeSocket) return;
                clearTimeout(connectionTimer);
                socket = null;
                clearTelemetry();
                updateConnection("Verbindung geschlossen. Keine Nachrichten werden zwischengespeichert.");
            });
        } catch {
            socket = null;
            updateConnection("WebSocket konnte nicht gestartet werden.");
        }
    });
    byId("disconnectButton").addEventListener("click", disconnect);
    byId("sendTargetButton").addEventListener("click", () => {
        const message = { type: "target", position: { ...target }, gripper, units: "mm" };
        if (sendMessage(message)) {
            window.dispatchEvent(new CustomEvent("robot:target", { detail: message }));
            byId("targetStatus").textContent = "Ziel ans Backend gesendet. Ausführung nicht bestätigt.";
        } else byId("targetStatus").textContent = "Ziel nicht gesendet. Backend-Verbindung prüfen.";
    });

    function validApiUrl() {
        try {
            const url = new URL(settings.apiUrl);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
            if (location.protocol === "https:" && url.protocol !== "https:") return null;
            return url;
        } catch {
            return null;
        }
    }

    function cancelApiRequests() {
        apiGeneration++;
        apiQueue = [];
        if (apiRequest) apiRequest.abort();
        apiRequest = null;
    }

    function pauseApi(message) {
        cancelApiRequests();
        settings.forwardApi = false;
        byId("forwardApi").checked = false;
        persistSettings();
        updateStreamStatus();
        byId("apiStatus").textContent = message;
        notice(message);
    }

    async function pumpApi() {
        if (apiRequest || !settings.forwardApi || !apiQueue.length) return;
        const item = apiQueue.shift();
        const generation = apiGeneration;
        const controller = new AbortController();
        apiRequest = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        updateStreamStatus();
        try {
            const headers = { "Content-Type": "application/json" };
            if (item.key) headers.Authorization = `Bearer ${item.key}`;
            const response = await fetch(item.url, {
                method: "POST",
                headers,
                body: item.body,
                signal: controller.signal,
                credentials: "omit",
                redirect: "error"
            });
            if (generation !== apiGeneration) return;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            apiDelivered++;
            if (response.headers.get("content-type")?.includes("application/json")) {
                const data = await response.json();
                if (generation === apiGeneration && data?.type === "telemetry" && !updateTelemetry(data)) {
                    notice("API bestätigt. Enthaltene Roboterkoordinaten waren jedoch ungültig.");
                }
            }
        } catch (error) {
            if (generation !== apiGeneration) return;
            const detail = error.message?.startsWith("HTTP ") ? error.message : "Netzwerk, CORS, Antwort oder Zeitüberschreitung prüfen";
            pauseApi(`API pausiert: ${detail}. Offene Nachrichten wurden nicht wiederholt.`);
        } finally {
            clearTimeout(timeout);
            if (generation === apiGeneration) {
                apiRequest = null;
                updateStreamStatus();
                void pumpApi();
            }
        }
    }

    function enqueueApi(message) {
        if (!settings.forwardApi) return;
        const url = validApiUrl();
        if (!url) return pauseApi("API pausiert: Gültige HTTP(S)-Adresse erforderlich.");
        if (message.type === "transcript") {
            apiQueue = apiQueue.filter((item) => item.segmentId !== message.segmentId || item.isFinal);
        }
        if (apiQueue.length >= 100) return pauseApi("API pausiert: Zu viele offene Nachrichten. Backend-Verarbeitung prüfen.");
        apiQueue.push({
            url: url.href,
            key: byId("apiKey").value.trim(),
            body: JSON.stringify(message),
            segmentId: message.segmentId,
            isFinal: message.isFinal
        });
        void pumpApi();
    }

    byId("apiKey").addEventListener("input", () => {
        cancelApiRequests();
        updateStreamStatus();
    });

    function publish(message) {
        message.sequence = ++streamSequence;
        message.timestamp = new Date().toISOString();
        messageCount++;
        byId("streamCount").textContent = String(messageCount).padStart(3, "0");
        window.dispatchEvent(new CustomEvent(message.type === "transcript" ? "transcript:update" : message.type, { detail: message }));
        if (settings.forwardTranscript) sendMessage(message);
        enqueueApi(message);
    }

    function transcriptText(finalOnly = false) {
        const segments = session ? [...session.segments.values()].filter((item) => !finalOnly || item.isFinal).map((item) => item.text) : [];
        return [confirmedText, ...segments].filter(Boolean).join(" ").trim();
    }
    function displayTranscript(text) {
        visibleText = text;
        byId("log").value = text;
        byId("log").scrollTop = byId("log").scrollHeight;
        byId("transcriptCount").textContent = `${text.length} Zeichen`;
    }
    function updateRecordingUI(status) {
        const busy = phase !== "idle" || wantsRecording;
        byId("startButton").disabled = !recognition || busy;
        byId("stopButton").disabled = !busy || phase === "stopping";
        byId("clearButton").disabled = busy;
        byId("language").disabled = busy;
        document.body.classList.toggle("recording", phase === "recording");
        byId("recordingBadge").textContent = phase === "recording" ? "AUFNAHME" : busy ? "WARTE" : "BEREIT";
        if (status) byId("recordingStatus").textContent = status;
    }
    function finishSession() {
        if (!session) return;
        const id = session.id;
        confirmedText = transcriptText(true);
        session = null;
        displayTranscript(confirmedText);
        publish({ type: "transcript.end", sessionId: id, reason: endReason, fullText: confirmedText });
    }
    function beginRecognition() {
        if (!recognition || !wantsRecording || phase !== "idle") return;
        session = { id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, segments: new Map() };
        endReason = "ended";
        speechError = false;
        phase = "starting";
        recognition.lang = settings.language;
        updateRecordingUI("Mikrofon wird gestartet …");
        try {
            recognition.start();
        } catch {
            wantsRecording = false;
            phase = "idle";
            endReason = "error";
            finishSession();
            updateRecordingUI("Aufnahme konnte nicht gestartet werden. Mikrofonzugriff und Browser prüfen.");
        }
    }
    function stopRecording(reason = "stopped") {
        wantsRecording = false;
        clearTimeout(restartTimer);
        endReason = reason;
        if (phase === "idle") {
            updateRecordingUI("Aufnahme beendet.");
            return;
        }
        phase = "stopping";
        updateRecordingUI("Aufnahme wird beendet …");
        try {
            recognition.stop();
        } catch {
            phase = "idle";
            finishSession();
            updateRecordingUI("Aufnahme beendet.");
        }
    }
    byId("startButton").addEventListener("click", () => {
        if (!recognition || wantsRecording || phase !== "idle") return;
        wantsRecording = true;
        beginRecognition();
    });
    byId("stopButton").addEventListener("click", () => stopRecording());

    if (recognition) {
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => {
            if (!wantsRecording) {
                stopRecording();
                return;
            }
            phase = "recording";
            updateRecordingUI("Aufnahme läuft. Dein Text wird fortlaufend transkribiert.");
        };
        recognition.onresult = (event) => {
            if (!session) return;
            const changed = [];
            for (let index = event.resultIndex; index < event.results.length; index++) {
                const result = event.results[index];
                const next = { text: result[0].transcript.trim(), isFinal: result.isFinal };
                const previous = session.segments.get(index);
                session.segments.set(index, next);
                if (!previous || previous.text !== next.text || previous.isFinal !== next.isFinal) changed.push({ index, ...next });
            }
            displayTranscript(transcriptText());
            for (const item of changed) {
                if (!item.isFinal && !settings.sendInterim) continue;
                publish({
                    type: "transcript",
                    sessionId: session.id,
                    segmentId: `${session.id}:${item.index}`,
                    text: item.text,
                    isFinal: item.isFinal,
                    fullText: visibleText,
                    language: recognition.lang
                });
            }
        };
        recognition.onerror = (event) => {
            speechError = true;
            wantsRecording = false;
            endReason = "error";
            const messages = {
                "not-allowed": "Mikrofonzugriff verweigert. Berechtigung im Browser prüfen.",
                "service-not-allowed": "Spracherkennungsdienst ist in diesem Browser nicht erlaubt.",
                "audio-capture": "Kein nutzbares Mikrofon gefunden.",
                "no-speech": "Keine Sprache erkannt. Starte eine neue Aufnahme.",
                "network": "Verbindungsproblem beim Spracherkennungsdienst.",
                "aborted": "Aufnahme abgebrochen.",
                "language-not-supported": "Die ausgewählte Sprache wird nicht unterstützt."
            };
            updateRecordingUI(messages[event.error] || "Spracherkennung fehlgeschlagen. Bitte erneut starten.");
        };
        recognition.onend = () => {
            phase = "idle";
            finishSession();
            if (wantsRecording && settings.autoRestart && !document.hidden && !speechError) {
                updateRecordingUI("Browser hat die Aufnahme pausiert. Fortsetzung …");
                restartTimer = setTimeout(beginRecognition, 350);
            } else {
                wantsRecording = false;
                updateRecordingUI(speechError ? undefined : "Aufnahme beendet. Endgültiger Text bleibt erhalten.");
            }
        };
    }

    byId("clearButton").addEventListener("click", () => {
        if (phase !== "idle" || wantsRecording) return;
        confirmedText = "";
        displayTranscript("");
        publish({ type: "transcript.reset", fullText: "" });
        notice("Transkript geleert.");
    });
    byId("copyButton").addEventListener("click", async () => {
        if (!visibleText) return notice("Noch kein Text zum Kopieren vorhanden.");
        try {
            await navigator.clipboard.writeText(visibleText);
            notice("Transkript kopiert.");
        } catch {
            byId("log").focus();
            byId("log").select();
            notice("Text ausgewählt. Mit Strg+C oder der Kopierfunktion deines Geräts kopieren.");
        }
    });
    byId("downloadButton").addEventListener("click", () => {
        if (!visibleText) return notice("Noch kein Text zum Herunterladen vorhanden.");
        const url = URL.createObjectURL(new Blob([visibleText], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "lenze-transkript.txt";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        notice("Textdatei zum Download bereitgestellt.");
    });
    byId("resetSettings").addEventListener("click", () => {
        stopRecording();
        disconnect();
        cancelApiRequests();
        byId("apiKey").value = "";
        settings = { ...defaults };
        persistSettings();
        loadSettings();
        notice("Standardwerte wiederhergestellt.");
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && (wantsRecording || phase !== "idle")) stopRecording("hidden");
    });
    window.addEventListener("pagehide", () => {
        stopRecording("closed");
        disconnect();
        cancelApiRequests();
        byId("apiKey").value = "";
    });

    window.motionInterface = {
        updateTelemetry,
        getTranscript: () => visibleText,
        getTarget: () => ({ type: "target", position: { ...target }, gripper, units: "mm" })
    };
    loadSettings();
    setTargetLocked(false);
    updateConnection("Nicht verbunden. Text bleibt lokal verfügbar.");
    updateRecordingUI(recognition ? "Bereit für deine Aufnahme." : "Dieser Browser unterstützt keine Spracherkennung. Bitte Chrome oder Edge ausprobieren.");
})();
