import { Client, Databases, ID, Query } from "node-appwrite";
import fetch from "node-fetch";

// Main function executed by Appwrite
export default async ({ req, res, log, error }) => {
  // Environment variables
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
  const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
  const APPWRITE_DATABASE_ID = process.env.APPWRITE_DATABASE_ID;
  const APPWRITE_USERS_COLLECTION_ID = process.env.APPWRITE_USERS_COLLECTION_ID;
  const APPWRITE_CHATS_COLLECTION_ID = process.env.APPWRITE_CHATS_COLLECTION_ID;
  const USAGE_LIMIT = 5;

  // Log environment variables presence (without sensitive values)
  log(
    "Environment variables loaded: " +
      !!TELEGRAM_BOT_TOKEN +
      ", " +
      !!OPENROUTER_API_KEY +
      ", " +
      !!APPWRITE_API_KEY
  );

  // Validate environment variables
  if (
    !TELEGRAM_BOT_TOKEN ||
    !OPENROUTER_API_KEY ||
    !APPWRITE_API_KEY ||
    !APPWRITE_PROJECT_ID ||
    !APPWRITE_DATABASE_ID ||
    !APPWRITE_USERS_COLLECTION_ID ||
    !APPWRITE_CHATS_COLLECTION_ID
  ) {
    error("Missing environment variables");
    return res.json({ ok: false, error: "Server configuration error" }, 500);
  }

  // Initialize Appwrite client
  const client = new Client()
    .setEndpoint("https://cloud.appwrite.io/v1")
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

  const databases = new Databases(client);

  // Log raw request body for debugging
  log("Raw request body type: " + typeof req.body);
  log("Raw request body content: " + JSON.stringify(req.body, null, 2));

  // Parse incoming Telegram webhook request
  let update;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    error("Failed to parse webhook payload: " + e.message);
    return res.json({ ok: true }, 200); // Return 200 to Telegram to avoid retries
  }

  // Validate Telegram update
  if (
    !update.message ||
    !update.message.chat ||
    !update.message.from ||
    !update.message.text
  ) {
    log("Invalid Telegram update: " + JSON.stringify(update, null, 2));
    return res.json({ ok: true }, 200); // Acknowledge invalid update
  }

  const chatId = update.message.chat.id;
  const telegramId = update.message.from.id.toString();
  const username = update.message.from.username || "";
  const userMessage = update.message.text;
  const sessionId = new Date().toISOString().split("T")[0]; // Daily session ID

  log(
    `Processing message from telegramId: ${telegramId}, chatId: ${chatId}, message: ${userMessage}`
  );

  try {
    // Check or create user
    let user;
    try {
      user = await databases.getDocument(
        APPWRITE_DATABASE_ID,
        APPWRITE_USERS_COLLECTION_ID,
        telegramId
      );
    } catch (e) {
      if (e.code === 404) {
        // User not found, create new
        user = await databases.createDocument(
          APPWRITE_DATABASE_ID,
          APPWRITE_USERS_COLLECTION_ID,
          telegramId,
          {
            telegramId,
            username,
            usageCount: 0,
          }
        );
        log(`Created new user: ${telegramId}`);
      } else {
        throw e; // Rethrow other errors
      }
    }

    // Check usage limit
    if (user.usageCount >= USAGE_LIMIT) {
      await sendTelegramMessage(
        TELEGRAM_BOT_TOKEN,
        chatId,
        "You have reached the usage limit of 5 messages."
      );
      return res.json({ ok: true }, 200);
    }

    // Save user message to chats collection
    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_CHATS_COLLECTION_ID,
      ID.unique(),
      {
        telegramId,
        message: userMessage,
        role: "user",
        sessionId,
      }
    );

    // Increment usage count
    await databases.updateDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_USERS_COLLECTION_ID,
      telegramId,
      {
        usageCount: user.usageCount + 1,
      }
    );

    // Fetch last 10 messages for context using Query class
    const chatHistory = await databases.listDocuments(
      APPWRITE_DATABASE_ID,
      APPWRITE_CHATS_COLLECTION_ID,
      [
        Query.equal("telegramId", telegramId),
        Query.equal("sessionId", sessionId),
        Query.orderDesc("$createdAt"),
        Query.limit(10),
      ]
    );

    // Prepare messages for OpenRouter (newest to oldest)
    const messages = chatHistory.documents
      .reverse()
      .map((doc) => ({
        role: doc.role,
        content: doc.message,
      }))
      .concat([{ role: "user", content: userMessage }]);

    // Query OpenRouter
    const openRouterResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "moonshotai/kimi-k2:free",
          messages,
        }),
      }
    );

    const openRouterData = await openRouterResponse.json();
    if (
      !openRouterResponse.ok ||
      !openRouterData.choices?.[0]?.message?.content
    ) {
      throw new Error(
        "OpenRouter API error: " +
          (openRouterData.error?.message || "Unknown error")
      );
    }

    const aiResponse = openRouterData.choices[0].message.content;

    // Save AI response to chats collection
    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      APPWRITE_CHATS_COLLECTION_ID,
      ID.unique(),
      {
        telegramId,
        message: aiResponse,
        role: "assistant",
        sessionId,
      }
    );

    // Send AI response to Telegram
    await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, aiResponse);

    return res.json({ ok: true }, 200);
  } catch (e) {
    error("Error processing request: " + e.message);
    await sendTelegramMessage(
      TELEGRAM_BOT_TOKEN,
      chatId,
      "An error occurred. Please try again later."
    );
    return res.json({ ok: true }, 200); // Always return 200 to Telegram
  }
};

// Helper function to send Telegram messages
async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to send Telegram message: " + response.statusText);
  }
}
