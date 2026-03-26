import { bot, restoreScheduledBroadcasts } from './bot';

restoreScheduledBroadcasts();

bot.start({
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  onStart: (info) => {
    console.log(`[Bot] @${info.username} started`);
  },
});

// Graceful shutdown: finish current update before stopping
process.once('SIGINT', () => {
  console.log('[Bot] SIGINT received, stopping...');
  bot.stop();
});
process.once('SIGTERM', () => {
  console.log('[Bot] SIGTERM received, stopping...');
  bot.stop();
});
