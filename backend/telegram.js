require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

async function sendSignal(msg) {
  if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) {
    return null;
  }

  try {
    return await bot.sendMessage(process.env.CHAT_ID, msg);
  } catch (error) {
    console.error("Telegram send failed:", error?.message || error);
    return null;
  }
}

module.exports = sendSignal;
