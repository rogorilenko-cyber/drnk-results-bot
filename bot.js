const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

let offset = 0;

function apiUrl(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function telegram(method, body) {
  const response = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method}: ${data.description}`);
  }
  return data.result;
}

function userLabel(user = {}) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username ? `@${user.username}` : "";
  const id = user.id ? `ID ${user.id}` : "";
  return [name, username, id].filter(Boolean).join(" · ") || "Неизвестный студент";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function formatResult(payload, from) {
  const status = payload.passed ? "ПРОШЕЛ" : "НЕ ПРОШЕЛ";
  const mistakes = (payload.answers || []).filter((answer) => !answer.isCorrect);
  const student = userLabel(from || normalizePayloadUser(payload.user));

  const lines = [
    `<b>Сертификация ДРНК: ${status}</b>`,
    "",
    `<b>Студент:</b> ${escapeHtml(student)}`,
    `<b>Результат:</b> ${payload.score}/${payload.total}`,
    `<b>Проходной балл:</b> ${payload.passScore}`,
    `<b>Ошибок:</b> ${mistakes.length}`,
    `<b>Дата:</b> ${new Date(payload.finishedAt || Date.now()).toLocaleString("ru-RU")}`
  ];

  if (mistakes.length) {
    lines.push("", "<b>Ошибки:</b>");
    mistakes.forEach((answer) => {
      lines.push(
        "",
        `<b>${answer.number}. ${escapeHtml(answer.question)}</b>`,
        `Ответ студента: ${escapeHtml(answer.selectedAnswer || "не выбран")}`,
        `Правильно: ${escapeHtml(answer.correctAnswer)}`
      );
    });
  }

  return lines.join("\\n");
}

function normalizePayloadUser(user = {}) {
  return {
    id: user.id,
    username: user.username,
    first_name: user.first_name || user.firstName,
    last_name: user.last_name || user.lastName
  };
}

async function sendResult(payload, from, replyChatId) {
  if (payload.type !== "drnk_certification_result") return false;

  const adminChatId = ADMIN_CHAT_ID || replyChatId;
  if (!adminChatId) {
    throw new Error("ADMIN_CHAT_ID is required for direct result sending");
  }

  await sendLongMessage(adminChatId, formatResult(payload, from));

  if (replyChatId && String(adminChatId) !== String(replyChatId)) {
    await telegram("sendMessage", {
      chat_id: replyChatId,
      text: "Результат сертификации отправлен."
    });
  }

  return true;
}

async function sendLongMessage(chatId, text) {
  const maxLength = 3900;
  for (let index = 0; index < text.length; index += maxLength) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: text.slice(index, index + maxLength),
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  if (message.text === "/start") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `Бот подключен. Ваш chat_id: ${message.chat.id}`
    });
    return;
  }

  const rawData = message.web_app_data?.data;
  if (!rawData) return;

  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Не удалось прочитать результат сертификации."
    });
    return;
  }

  await sendResult(payload, message.from, message.chat.id);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(payload));
}

async function handleHttpRequest(request, response) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    sendJson(response, 200, { ok: true, service: "drnk-results-bot" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/result") {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }

  try {
    const payload = JSON.parse(await readRequestBody(request));
    const accepted = await sendResult(payload, normalizePayloadUser(payload.user));
    sendJson(response, accepted ? 200 : 400, { ok: accepted });
  } catch (error) {
    console.error(error.message);
    sendJson(response, 500, { ok: false, error: "Result was not sent" });
  }
}

async function startHttpServer() {
  const { createServer } = await import("node:http");
  createServer((request, response) => {
    handleHttpRequest(request, response).catch((error) => {
      console.error(error.message);
      sendJson(response, 500, { ok: false, error: "Server error" });
    });
  }).listen(PORT, () => {
    console.log(`HTTP result endpoint is listening on port ${PORT}`);
  });
}

async function poll() {
  await telegram("deleteWebhook", { drop_pending_updates: false });

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

console.log("DRNK certification bot is running");
startHttpServer();
poll();
