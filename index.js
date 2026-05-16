const makeWASocket = require("@whiskeysockets/baileys").default;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const NodeCache = require("@cacheable/node-cache").default;
const P = require("pino");
const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const qrcode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const port = 8001;
const logger = P({ level: "silent" });

// retry cache
const msgRetryCounterCache = new NodeCache();

let sock;
let qrGlobal = null;
let socketClient = null;
const SESSION_DIR = "./session";


const path = require("path");

// static assets
app.use("/assets", express.static(path.join(__dirname, "client/assets")));

// halaman scan QR
app.get("/scan", (req, res) => {
    res.sendFile(path.join(__dirname, "client/server.html"));
});

// halaman utama
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "client/index.html"));
});


// ================= RESET SESSION =================
const resetSession = () => {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log("SESSION DELETED");
        }
    } catch (err) {
        console.log("RESET ERROR:", err);
    }
};

// ================= HELPERS =================
const isConnected = () => !!sock?.user;

const formatJid = (number) => "62" + number.substring(1) + "@s.whatsapp.net";

const normalizeText = (msg) =>
    (msg?.message?.conversation ||
     msg?.message?.extendedTextMessage?.text ||
     "").toLowerCase();

// ================= MESSAGE HANDLER =================
async function handleIncomingMessage(msg) {
    try {
        if (msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = normalizeText(msg);

        if (!text) return;

        await sock.readMessages([msg.key]);

        if (text === "ping") {
            return sock.sendMessage(jid, { text: "Pong" }, { quoted: msg });
        }

        return sock.sendMessage(jid, { text: "Saya adalah Bot!" }, { quoted: msg });

    } catch (err) {
        console.log("MSG ERROR:", err);
    }
}

// ================= CONNECT =================
async function connectToWhatsApp() {
    qrGlobal = null;

    const { state, saveCreds } = await useMultiFileAuthState("session");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        msgRetryCounterCache,
    });

    sock.ev.process(async (events) => {

        // ================= CONNECTION =================
        if (events["connection.update"]) {
            const { connection, lastDisconnect, qr } = events["connection.update"];

            if (qr) {
                qrGlobal = qr;
                console.log("QR READY");
                updateQR("qr");
            }

            if (connection === "open") {
                console.log("CONNECTED");
                updateQR("connected");
            }

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                const isLoggedOut = statusCode === DisconnectReason.loggedOut;

                if (isLoggedOut) {
                    console.log("LOGGED OUT -> RESET SESSION");

                    resetSession();

                    setTimeout(() => connectToWhatsApp(), 2000);
                    return;
                }

                console.log("RECONNECTING...");
                setTimeout(() => connectToWhatsApp(), 2000);
            }
        }

        // ================= SAVE CREDS =================
        if (events["creds.update"]) {
            await saveCreds();
        }

        // ================= MESSAGES =================
        if (events["messages.upsert"]) {
            const upsert = events["messages.upsert"];

            if (upsert.type === "notify") {
                for (const msg of upsert.messages) {
                    await handleIncomingMessage(msg);
                }
            }
        }
    });
}

// ================= SOCKET.IO =================
io.on("connection", (socket) => {
    socketClient = socket;

    if (isConnected()) {
        updateQR("connected");
    } else if (qrGlobal) {
        updateQR("qr");
    } else {
        updateQR("loading");
    }
});

// ================= QR UI =================
const updateQR = (type) => {
    if (!socketClient) return;

    switch (type) {
        case "qr":
            qrcode.toDataURL(qrGlobal, (err, url) => {
                socketClient.emit("qr", url);
                socketClient.emit("log", "QR Code received, please scan!");
            });
            break;

        case "connected":
            socketClient.emit("qrstatus", "/assets/check.svg");
            socketClient.emit("log", "WhatsApp terhubung!");
            break;

        case "qrscanned":
            socketClient.emit("qrstatus", "/assets/check.svg");
            socketClient.emit("log", "QR Code Telah discan!");
            break;

        case "loading":
            socketClient.emit("qrstatus", "/assets/loader.gif");
            socketClient.emit("log", "Registering QR Code , please wait!");
            break;
    }
};

// ================= API =================
app.use(express.json());
// SEND MESSAGE
app.post("/send-message", async (req, res) => {
    try {
        const { number, message } = req.body;
        const file = req.files?.file_dikirim;

        if (!number) {
            return res.status(400).json({
                status: false,
                message: "Nomor kosong"
            });
        }

        if (!isConnected()) {
            return res.status(500).json({
                status: false,
                message: "WhatsApp belum connect"
            });
        }

        const jid = formatJid(number);

        const exists = await sock.onWhatsApp(jid);

        if (!exists || !exists[0]?.jid) {
            return res.status(400).json({
                status: false,
                message: "Nomor tidak terdaftar"
            });
        }

        const target = exists[0].jid;

        // ================= CASE 1: TEXT ONLY =================
        if (!file) {
            await sock.sendMessage(target, {
                text: message || ""
            });

            return res.json({
                status: true,
                type: "text"
            });
        }

        // ================= CASE 2: FILE =================
        const uploadPath = "./uploads/";
        const fileName = Date.now() + "_" + file.name;
        const filePath = path.join(uploadPath, fileName);

        await file.mv(filePath);

        const ext = path.extname(filePath).toLowerCase();

        // ================= IMAGE =================
        if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
            await sock.sendMessage(target, {
                image: { url: filePath },
                caption: message || ""
            });
        }

        // ================= AUDIO =================
        else if ([".mp3", ".ogg", ".wav"].includes(ext)) {
            await sock.sendMessage(target, {
                audio: { url: filePath },
                mimetype: "audio/mp4"
            });
        }

        // ================= VIDEO (optional upgrade) =================
        else if ([".mp4", ".mkv"].includes(ext)) {
            await sock.sendMessage(target, {
                video: { url: filePath },
                caption: message || ""
            });
        }

        // ================= DOCUMENT =================
        else {
            await sock.sendMessage(target, {
                document: { url: filePath },
                fileName: file.name,
                mimetype: file.mimetype
            });
        }

        // cleanup file (pattern lama lu)
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.log("cleanup error:", err);
            });
        }

        return res.json({
            status: true,
            type: "file",
            message: "sent"
        });

    } catch (err) {
        console.log(err);
        return res.status(500).json({
            status: false,
            error: err.message
        });
    }
});

app.post("/send-group-message", async (req, res) => {
    try {
        const { id_group, message } = req.body;

        if (!id_group) {
            return res.status(400).json({
                error: "ID Group kosong"
            });
        }

        if (!isConnected()) {
            return res.status(500).json({
                error: "WhatsApp belum terhubung"
            });
        }

        // validasi group (pattern lama lu, tapi dirapihin)
        let metadata;
        try {
            metadata = await sock.groupMetadata(id_group);
        } catch (err) {
            return res.status(400).json({
                error: "Group tidak valid / tidak ditemukan"
            });
        }

        console.log("SEND TO GROUP:", metadata.subject);

        await sock.sendMessage(id_group, {
            text: message || "Test message group"
        });

        res.json({
            success: true,
            group: metadata.subject
        });

    } catch (err) {
        res.status(500).json({
            error: err.message
        });
    }
});
// ================= START =================
connectToWhatsApp();

server.listen(port, () => {
    console.log("Server jalan di " + port);
});