const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
async function saveMemory(chatId, role, content) {
  const { error } = await supabase
    .from("chat_memory")
    .insert({
      chat_id: chatId,
      role,
      content
    });
  // Tambahkan ini agar error terdeteksi oleh try-catch di file utama
  if (error) {
    throw error;
  }
}
async function getHistory(chatId) {
  const { data, error } = await supabase
    .from("chat_memory")
    .select("role,content")
    .eq("chat_id", chatId)
    .order("id", {
      ascending: false
    })
    .limit(20);
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
// Tambahkan ini JIKA kode ini ada di file terpisah (misal: supabaseHelp>
module.exports = {
  supabase,
  saveMemory,
  getHistory
};
