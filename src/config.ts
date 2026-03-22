import 'dotenv/config';

const botToken = process.env.BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;

if (!botToken) throw new Error('BOT_TOKEN is required in .env');
if (!adminChatId) throw new Error('ADMIN_CHAT_ID is required in .env');

export const config = {
  botToken,
  adminChatId: Number(adminChatId),
};
