require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");

// Import semua helper database dari supabaseHelper.js
const { supabase, saveMemory, getHistory, getReplyContext } = require("./supabaseHelper");

const BOT_USERNAME = "NrozBot";
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL
});

// === FUNGSI UTILITY ===
function cleanAnswer(text) {
  return text
    .replace(/\*\*/g, "*")    // Ubah **bold** (OpenAI) menjadi *bold* (Telegram Markdown)
    .replace(/### /g, "");     // Hapus simbol heading ###
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

// === HANDLER COMMAND (Perintah) ===
bot.onText(/\/start/, async (msg) => {
  if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot
  await bot.sendMessage(
    msg.chat.id,
    "Nroz AI\n\nsiap membantumu, buat obrolan baru:\nsaya bisa baca teks/foto/jpg/dokumen\n dengan sangat akurat"
  );
});

bot.onText(/\/newtopic/, async (msg) => {
  if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot
  await supabase
    .from("chat_memory")
    .delete()
    .eq("chat_id", msg.chat.id);
    
  await bot.sendMessage(
    msg.chat.id,
    "berhasil mengganti topic."
  );
});

// === HANDLER TEKS ===
bot.on("message", async (msg) => {
  if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam
  if (msg.text?.startsWith("/")) return;   // Abaikan jika berawalan slash (sudah ditangani onText)

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const mention = `@${BOT_USERNAME}`;
    const replied = msg.reply_to_message?.from?.username === BOT_USERNAME;
    const mentioned = msg.text?.includes(mention);

    if (!mentioned && !replied) {
      return;
    }
  }

  if (!msg.text) return;
  const chatId = msg.chat.id;
  let typing;

  try {
    typing = startTyping(chatId);
    let userText = msg.text;

    if (msg.reply_to_message) {
      const replied = await getReplyContext(chatId, msg.reply_to_message.message_id);
      if (replied) {
        userText = `Pesan yang direply:\n\n${replied.content}\n\nPesan baru:\n\n${msg.text}`;
      }
    }

    await saveMemory(chatId, "user", userText, msg.message_id);

    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: await getHistory(chatId)
    });

    let answer = result.choices[0].message.content || "";
    answer = cleanAnswer(answer);
    
    const sent = await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
    await saveMemory(chatId, "assistant", answer, sent.message_id);
  } catch(err) {
    console.error("TEXT ERROR:", err);
    await bot.sendMessage(chatId, "Terjadi kesalahan.");
  } finally {
    stopTyping(typing);
  }
});

// === HANDLER FOTO ===
bot.on("photo", async (msg) => {
  if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam

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

    if (prompt !== "") {
      await saveMemory(chatId, "user", `[Kirim Foto]: ${prompt || "(tanpa caption)"}`);
    }
    
    const sent = await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
    await saveMemory(chatId, "assistant", answer, sent.message_id);
  } catch(err) {
    console.error("PHOTO ERROR:", err);
    await bot.sendMessage(chatId, "Gagal memproses foto.");
  } finally {
    stopTyping(typing);
  }
});

// === HANDLER DOKUMEN ===
bot.on("document", async (msg) => {
  if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam

  const chatId = msg.chat.id;
  let typing;
  try {
    typing = startTyping(chatId);
    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    const bufferData = Buffer.from(response.data);
    const fileName = msg.document.file_name.toLowerCase();
    
    let extractedText = "";
    const prompt = msg.caption || "";
    
    const textExtensions = [
      ".txt", ".js", ".ts", ".jsx", ".tsx", ".json", ".html", ".css", 
      ".py", ".java", ".c", ".cpp", ".cs", ".php", ".go", ".rs", 
      ".sql", ".xml", ".yaml", ".yml", ".md"
    ];

    if (textExtensions.some(ext => fileName.endsWith(ext))) {
      extractedText = bufferData.toString("utf8");
    } else if (fileName.endsWith(".pdf")) {
      const pdfData = await pdf(bufferData);
      extractedText = pdfData.text;
    } else if (fileName.endsWith(".docx")) {
      const docxData = await mammoth.extractRawText({ buffer: bufferData });
      extractedText = docxData.value;
    } else if (
      fileName.endsWith(".jpg") ||
      fileName.endsWith(".jpeg") ||
      fileName.endsWith(".png") ||
      fileName.endsWith(".webp")
    ) {
      const mime = fileName.endsWith(".png") ? "image/png" : 
                   fileName.endsWith(".webp") ? "image/webp" : "image/jpeg";
      
      await saveMemory(chatId, "user", `[Kirim Gambar HD]: ${fileName}`);
      
      const currentMessage = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt || "" },
            { type: "image_url", image_url: { url: `data:${mime};base64,${bufferData.toString("base64")}` } }
          ]
        }
      ];

      const result = await client.chat.completions.create({
        model: process.env.MODEL,
        messages: currentMessage
      });

      let answer = result.choices[0].message.content;
      answer = cleanAnswer(answer);

      const sent = await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
      await saveMemory(chatId, "assistant", answer, sent.message_id);
      return;
    } else {
      bot.sendMessage(chatId, "Format file belum didukung. Harap kirim TXT, PDF, atau DOCX.");
      return;
    }

    await saveMemory(chatId, "user", `FILE: ${fileName} ${prompt} ${extractedText}`);
    
    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: await getHistory(chatId)
    });

    let answer = result.choices[0].message.content;
    answer = cleanAnswer(answer);
   
    const sent = await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
    await saveMemory(chatId, "assistant", answer, sent.message_id);
  } catch(err) {
    console.error("DOCUMENT ERROR:", err);
    await bot.sendMessage(chatId, "Gagal mengekstrak atau memproses dokumen.");
  } finally {
    stopTyping(typing);
  }
});

// === PENANGAN ERROR POLLING (Agar Log Railway Bersih) ===
bot.on("polling_error", (error) => {
  console.log(`[Polling Error]: ${error.message}`);
});
