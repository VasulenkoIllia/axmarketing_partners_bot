import 'dotenv/config';

const botToken = process.env.BOT_TOKEN;
const adminChatIds = process.env.ADMIN_CHAT_IDS ?? process.env.ADMIN_CHAT_ID;

if (!botToken) throw new Error('BOT_TOKEN is required in .env');
if (!adminChatIds) throw new Error('ADMIN_CHAT_IDS is required in .env');

export const config = {
  botToken,
  adminChatIds: adminChatIds.split(',').map((id) => Number(id.trim())),
};
