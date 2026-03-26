import 'dotenv/config';

const botToken = process.env.BOT_TOKEN;
const adminChatIds = process.env.ADMIN_CHAT_IDS ?? process.env.ADMIN_CHAT_ID;

if (!botToken) throw new Error('BOT_TOKEN is required in .env');
if (!adminChatIds) throw new Error('ADMIN_CHAT_IDS is required in .env');

const parsedAdminChatIds = adminChatIds.split(',').map((id) => Number(id.trim()));
const invalidIds = parsedAdminChatIds.filter((id) => isNaN(id) || id === 0);
if (invalidIds.length > 0) {
  throw new Error(`ADMIN_CHAT_IDS contains invalid values: ${invalidIds.join(', ')}. Must be numeric chat IDs.`);
}

export const config = {
  botToken,
  adminChatIds: parsedAdminChatIds,
};
