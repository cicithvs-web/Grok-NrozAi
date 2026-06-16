require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Tambahkan telegramMessageId agar sinkron dengan kebutuhan di Bot.js
async function saveMemory(chatId, role, content, telegramMessageId = null) {
  const { error } = await supabase
    .from("chat_memory")
    .insert({
      chat_id: chatId,
      role,
      content,
      telegram_message_id: telegramMessageId
    });

  if (error) {
    throw error;
  }
}

async function getHistory(chatId) {
  const { data, error } = await supabase
    .from("chat_memory")
    .select("role,content")
    .eq("chat_id", chatId)
    .order("id", { ascending: false })
    .limit(100); // Limit diubah ke 100 mengikuti Bot.js lama kamu

  if (error) {
    throw error;
  }

  return (data || [])
    .reverse()
    .map(row => ({
      role: row.role,
      content: row.content
    }));
}

// Pindahkan fungsi getReplyContext dari Bot.js ke sini
async function getReplyContext(chatId, messageId) {
  const { data, error } = await supabase
    .from("chat_memory")
    .select("*")
    .eq("chat_id", chatId)
    .eq("telegram_message_id", messageId)
    .single();

  if (error) {
    return null;
  }

  return data;
}

module.exports = {
  supabase,
  saveMemory,
  getHistory,
  getReplyContext
};
