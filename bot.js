require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const AdmZip = require("adm-zip"); // <-- Tambahan modul untuk membaca ZIP

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
  }, 4080);
}

function stopTyping(interval) {
  if (interval) {
    clearInterval(interval);
  }
}

// Kirim pesan panjang dengan menjaga format Markdown (khususnya Code Block)
async function sendLongMessage(chatId, text, options = {}) {
  const LIMIT = 4080; // Sedikit di bawah batas maksimal 4096 agar aman
  if (text.length <= LIMIT) {
    return await bot.sendMessage(chatId, text, options);
  }

  const lines = text.split('\n');
  const chunks = [];
  let currentChunk = '';
  let isCodeBlockOpen = false;
  let currentLanguage = '';

  for (const line of lines) {
    // Cek apakah baris ini membuka atau menutup code block (```)
    if (line.trim().startsWith('
```')) {
      isCodeBlockOpen = !isCodeBlockOpen;
      if (isCodeBlockOpen) {
        // Simpan nama bahasanya (misal: js, python) jika ada
        currentLanguage = line.trim().replace(/`/g, ''); 
      } else {
        currentLanguage = '';
      }
    }

    // Jika menambah baris ini bikin overlimit, kita potong pesannya
    if (currentChunk.length + line.length + 1 > LIMIT) {
      if (isCodeBlockOpen) {
        // Tutup sementara code block di pesan ini agar format Telegram tidak error
        currentChunk += '\n```';
      }
      chunks.push(currentChunk);

      // Mulai potongan pesan baru
      if (isCodeBlockOpen) {
        // Buka kembali code block di pesan selanjutnya dengan bahasa yang sama
        currentChunk = '
```' + currentLanguage + '\n' + line + '\n';
      } else {
        currentChunk = line + '\n';
      }
    } else {
      currentChunk += line + '\n';
    }
  }

  // Masukkan sisa teks terakhir
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  let lastSent;
  for (let i = 0; i < chunks.length; i++) {
    // Penanda bersambung yang rapi
    const suffix = (i !== chunks.length - 1) ? `\n\n_...bersambung ke pesan selanjutnya_` : "";
    
    try {
      lastSent = await bot.sendMessage(chatId, chunks[i] + suffix, options);
    } catch (err) {
      console.error("[Markdown Error] Gagal mengirim potongan pesan:", err.message);
      // Fallback jika masih ada format markdown lain yang tidak valid
      const plainOptions = { ...options };
      delete plainOptions.parse_mode; 
      lastSent = await bot.sendMessage(chatId, chunks[i] + suffix, plainOptions);
    }
    
    if (i !== chunks.length - 1) await new Promise(r => setTimeout(r, 500)); // Jeda 0.5 detik
  }
  return lastSent;
}

// === HANDLER COMMAND (Perintah) ===
bot.onText(/\/start/, async (msg) => {
  if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot
  await bot.sendMessage(
    msg.chat.id,
    "Nroz AI\n\nsiap membantumu, buat obrolan baru:\nsaya bisa baca teks/foto/jpg/dokumen/zip\ndengan sangat akurat"
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
    
    const sent = await sendLongMessage(chatId, answer, { parse_mode: "Markdown" });
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

  // Pengecekan khusus untuk grup
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const mention = `@${BOT_USERNAME}`;
    const replied = msg.reply_to_message?.from?.username === BOT_USERNAME;
    const mentioned = msg.caption?.includes(mention); 
    if (!mentioned && !replied) {
      return; // Hentikan proses jika bot tidak dipanggil
    }
  }
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
    
    const sent = await sendLongMessage(chatId, answer, { parse_mode: "Markdown" });
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

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const mention = `@${BOT_USERNAME}`;
    const replied = msg.reply_to_message?.from?.username === BOT_USERNAME;
    const mentioned = msg.caption?.includes(mention); 
    if (!mentioned && !replied) {
      return; // Hentikan proses jika bot tidak dipanggil
    }
  }
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
    } else if (fileName.endsWith(".zip")) {
      // --- LOGIKA PEMBACAAN FILE ZIP ---
      try {
        const zip = new AdmZip(bufferData);
        const zipEntries = zip.getEntries();
        
        extractedText = `Daftar isi file dalam ${fileName}:\n`;
        for (const zipEntry of zipEntries) {
          if (!zipEntry.isDirectory) {
            const entryName = zipEntry.name.toLowerCase();
            const entryBuffer = zipEntry.getData();

            if (textExtensions.some(ext => entryName.endsWith(ext))) {
              // File teks biasa (js, py, txt, dll)
              extractedText += `\n--- Mulai File: ${zipEntry.name} ---\n`;
              extractedText += entryBuffer.toString("utf8");
              extractedText += `\n--- Akhir File: ${zipEntry.name} ---\n`;
            } else if (entryName.endsWith(".pdf")) {
              // File PDF di dalam ZIP
              try {
                const pdfData = await pdf(entryBuffer);
                extractedText += `\n--- Mulai File: ${zipEntry.name} ---\n`;
                extractedText += pdfData.text;
                extractedText += `\n--- Akhir File: ${zipEntry.name} ---\n`;
              } catch (e) {
                extractedText += `\n- [PDF Error]: ${zipEntry.name} (Gagal membaca isi PDF)`;
              }
            } else if (entryName.endsWith(".docx")) {
              // File DOCX di dalam ZIP
              try {
                const docxData = await mammoth.extractRawText({ buffer: entryBuffer });
                extractedText += `\n--- Mulai File: ${zipEntry.name} ---\n`;
                extractedText += docxData.value;
                extractedText += `\n--- Akhir File: ${zipEntry.name} ---\n`;
              } catch (e) {
                extractedText += `\n- [DOCX Error]: ${zipEntry.name} (Gagal membaca isi DOCX)`;
              }
            } else {
              // Format lain yang tidak bisa dibaca (exe, mp4, dll)
              extractedText += `\n- [File lain]: ${zipEntry.name} (Format tidak didukung, isinya tidak bisa dibaca AI)`;
            }
          }
        }
      } catch (e) {
        extractedText = "[Sistem]: Gagal mengekstrak file ZIP karena file rusak, dilindungi password, atau format tidak dikenali.";
      }
      // ----------------------------------
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

      const sent = await sendLongMessage(chatId, answer, { parse_mode: "Markdown" });
      await saveMemory(chatId, "assistant", answer, sent.message_id);
      return;
    } else {
      bot.sendMessage(chatId, "Format file belum didukung. Harap kirim TXT, PDF, DOCX, atau ZIP.");
      return;
    }

    await saveMemory(chatId, "user", `FILE: ${fileName} ${prompt}\n\n${extractedText}`);
    
    const result = await client.chat.completions.create({
      model: process.env.MODEL,
      messages: await getHistory(chatId)
    });

    let answer = result.choices[0].message.content;
    answer = cleanAnswer(answer);
   
    const sent = await sendLongMessage(chatId, answer, { parse_mode: "Markdown" });
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
