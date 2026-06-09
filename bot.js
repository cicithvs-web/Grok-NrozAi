require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const axios = require("axios");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const BOT_USERNAME = "NrozBot";
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
async function saveMemory(
  chatId,
  role,
  content,
  telegramMessageId = null
) {
  const { error } = await supabase
    .from("chat_memory")
    .insert({
   chat_id: chatId,
   role,
   content,
   telegram_message_id:
    telegramMessageId 
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
async function getReplyContext(
  chatId,
  messageId
) {

  const {
    data,
    error
  } = await supabase
    .from("chat_memory")
    .select("*")
    .eq("chat_id", chatId)
    .eq(
      "telegram_message_id",
      messageId
    )
    .single();

  if (error) {
    return null;
  }

  return data;

}
function cleanAnswer(text) {
  return text
    .replace(/\*\*/g, "*")    // Ubah **bold** (OpenAI) menjadi *bold* (Telegram Markdown)
    .replace(/### /g, "")     // Hapus simbol heading ### karena Telegram tidak mendukungnya
    // Hapus replace untuk "```" agar blok kode tetap menyala dengan rapi
}

function startTyping(chatId) {
  bot.sendChatAction(chatId, "typing");
  return setInterval(() => {
    bot.sendChatAction(chatId, "typing");
  }, 4000);
}
function stopTyping(interval) {
  if (interval) {
    clearInterval(interval);
  }
}
// [FIX] Perbaikan penulisan Regex
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    "Nroz AI\n\nsiap membantumu, buat obrolan baru:\nsaya bisa baca teks/foto/jpg/dokumen\n dengan sangat akurat"
  );
});
bot.onText(/\/newtopic/, async (msg) => {
  await supabase
    .from("chat_memory")
    .delete()
    .eq("chat_id", msg.chat.id);
  await bot.sendMessage(
    msg.chat.id,
    "berhasil mengganti topic."
  );
});
// Handler Teks
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/"))
return;

if (
  msg.chat.type === "group" ||
  msg.chat.type === "supergroup"
) {

  const mention =
  `@${BOT_USERNAME}`;

  const replied =
msg.reply_to_message?.from?.username ===
BOT_USERNAME;

  const mentioned =
  msg.text?.includes(mention);

  if (
    !mentioned &&
    !replied
  ) {
    return;
  }

}
  if (!msg.text) return;
  const chatId = msg.chat.id;
  let typing;
  try {
    typing = startTyping(chatId);
    let userText =
msg.text;

if (
  msg.reply_to_message
) {

  const replied =
  await getReplyContext(
    chatId,
    msg.reply_to_message.message_id
  );

  if (replied) {

    userText =
`Pesan yang direply:

${replied.content}

Pesan baru:

${msg.text}`;

  }

}

await saveMemory(
  chatId,
  "user",
  userText,
  msg.message_id
);
    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: await getHistory(chatId)
    });
    let answer = result.choices[0].message.content || "";
    answer = cleanAnswer(answer);
    
    const sent = 
await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
await saveMemory(chatId, "assistant", answer, sent.message_id);
  } catch(err) {
    console.error("TEXT ERROR:", err);
    await bot.sendMessage(chatId, "Terjadi kesalahan.");
  } finally {
    stopTyping(typing);
  }
});
// Handler Foto
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  let typing;
  try {
    typing = startTyping(chatId);
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(telegramUrl, { responseType: "arraybuffer" });
    const base64 = Buffer.from(response.data).toString("base64");
    const prompt = msg.caption || "";
    // Kirim pesan langsung tanpa menarik history sebelumnya
    const currentMessage = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
        ]
      }
    ];
    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: currentMessage
    });
    let answer = result.choices[0].message.content;
    answer = cleanAnswer(answer);
    // Simpan prompt berupa teks saja ke database agar tipe data tetap aman
    if (prompt !== "") {
      await saveMemory(chatId, "user",
      `[Kirim Foto]: ${prompt || "(tanpa caption)"}`);
    }
const sent = 
  await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
  await saveMemory(chatId, "assistant", answer, sent.message_id);
return;
  } catch(err) {
    console.error("PHOTO ERROR:", err);
    await bot.sendMessage(chatId, "Gagal memproses foto.");
  } finally {
    stopTyping(typing);
  }
});
// Handler Dokumen
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  let typing;
  try {
    typing = startTyping(chatId);
    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    // Ambil data sebagai buffer
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const bufferData = Buffer.from(response.data);
    const fileName = msg.document.file_name.toLowerCase();
    let extractedText = "";
    const prompt = msg.caption || "";
    // [FIX] Ekstrak teks langsung dari Buffer, tidak perlu simpan ke disk (fs)
    const textExtensions = [
  ".txt",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".json",
  ".html",
  ".css",
  ".py",
  ".java",
  ".c",
  ".cpp",
  ".cs",
  ".php",
  ".go",
  ".rs",
  ".sql",
  ".xml",
  ".yaml",
  ".yml",
  ".md"
];

if (
  textExtensions.some(
    ext => fileName.endsWith(ext)
  )
) {

  extractedText =
  bufferData.toString("utf8");

    } else if (fileName.endsWith(".pdf")) {
      const pdfData = await pdf(bufferData);
      extractedText = pdfData.text;
    } else if (fileName.endsWith(".docx")) {
      const docxData = await mammoth.extractRawText({ buffer: bufferData
});
      extractedText = docxData.value;
    } else if (
  fileName.endsWith(".jpg") ||
  fileName.endsWith(".jpeg") ||
  fileName.endsWith(".png") ||
  fileName.endsWith(".webp")
) {
   const mime =
    fileName.endsWith(".png")
      ? "image/png"
      : fileName.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
      
      await saveMemory(chatId, "user", `[Kirim Gambar HD]: ${fileName}`);
  
const currentMessage = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: prompt || ""
      },
      {
        type: "image_url",
        image_url: {
          url:
            `data:${mime};base64,` +
            bufferData.toString("base64")
        }
      }
    ]
  }
];

const result =
await client.chat.completions.create({
  model: process.env.MODEL,
  messages: currentMessage
});

  let answer = result.choices[0].message.content;
  answer = cleanAnswer(answer); // Gunakan fungsi terpusat

  const sent = 
    await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
    await saveMemory(chatId, "assistant", answer, sent.message_id);
return;
  } else {
      return bot.sendMessage(chatId, "Format file belum didukung. Harap kirim TXT, PDF, atau DOCX.");
    }
    // Gabungkan instruksi dengan teks dokumen
    await saveMemory(chatId, "user", `FILE: ${fileName} ${prompt} ${extractedText}`);
    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: await getHistory(chatId)
    });
    let answer = result.choices[0].message.content;
    answer = cleanAnswer(answer);
   
    const sent = 
      await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
      await saveMemory(chatId, "assistant", answer, sent.message_id);
  } catch(err) {
    console.error("DOCUMENT ERROR:", err);
    await bot.sendMessage(chatId, "Gagal mengekstrak atau memproses dokumen.");
  } finally {
    stopTyping(typing);
  }
});
