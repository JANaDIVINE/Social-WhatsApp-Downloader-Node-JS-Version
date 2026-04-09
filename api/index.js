/*===============================================*\
|| ############################################# ||
|| # WWW.AMITDAS.SITE / Version 1.0.0          # ||
|| # ----------------------------------------- # ||
|| # Copyright 2025 AMITDAS All Rights Reserved # ||
|| ############################################# ||
\*===============================================*/

// api/index.js
const { API_BASE, WHATSAPP_INSTANCE_ID, WHATSAPP_ACCESS_TOKEN } = require('../config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const DEBUG_LOG = true; // Set to false to disable debugging
  function debugLog(msg) {
    if (DEBUG_LOG) console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`);
  }

  debugLog("Script started");
  debugLog(`Raw body: ${JSON.stringify(req.body)}`);

  const data = req.body;
  if (!data) {
    debugLog("Invalid JSON format");
    return res.status(400).json({ error: "❌ Invalid JSON format." });
  }

  // Check event type - only process messages
  const event = data.data?.event || '';
  debugLog(`Webhook event type: ${event}`);

  if (event !== 'received_message' && event !== 'messages.upsert') {
    debugLog(`Ignoring non-message event: ${event}`);
    return res.status(200).json({ message: "⚠️ Ignoring non-message event." });
  }

  // Extract data based on event type
  let bodyMsg, messageKey, remoteJid, remoteJidAlt;

  if (event === 'received_message') {
    // Format 1: received_message event
    bodyMsg = data.data.message?.body_message || {};
    messageKey = data.data.message?.message_key || {};
    remoteJid = messageKey.remoteJid || '';
    remoteJidAlt = messageKey.remoteJidAlt || '';
  } else if (event === 'messages.upsert') {
    // Format 2: messages.upsert event
    const messages = data.data.data?.messages || [];
    if (!messages.length) {
      debugLog("No messages in webhook");
      return res.status(400).json({ error: "❌ No messages found." });
    }
    
    const firstMessage = messages[0];
    messageKey = firstMessage.key || {};
    remoteJid = messageKey.remoteJid || '';
    remoteJidAlt = messageKey.remoteJidAlt || '';
    
    // Extract message text from extendedTextMessage
    bodyMsg = {
      messages: firstMessage.message || {},
      content: firstMessage.message?.extendedTextMessage?.text || ''
    };
  }

  debugLog(`remoteJid: ${remoteJid}, remoteJidAlt: ${remoteJidAlt}`);

  // Ignore groups, broadcasts, newsletters, etc.
  // FIXED: Removed '@lid' as it's used for regular 1-on-1 messages
  const ignorePatterns = [
    '@g.us',              // WhatsApp groups
    '@broadcast',         // Broadcast lists
    '@newsletter',        // Newsletter
    'status@broadcast',   // Status updates
    '-@g.us',             // Groups with dash
    'broadcast',          // Just broadcast
    'newsletter',         // Just newsletter
    'status'              // Status messages
  ];

  if (ignorePatterns.some(pattern => remoteJid.toLowerCase().includes(pattern.toLowerCase()))) {
    debugLog(`Ignored remoteJid (matched pattern): ${remoteJid}`);
    return res.status(200).json({ message: `⚠️ Ignored remoteJid: ${remoteJid}` });
  }

  // Extract message text
  let messageText = '';
  if (bodyMsg?.messages?.conversation) {
    messageText = bodyMsg.messages.conversation;
  } else if (bodyMsg?.content) {
    messageText = bodyMsg.content;
  } else if (bodyMsg?.messages?.extendedTextMessage?.text) {
    messageText = bodyMsg.messages.extendedTextMessage.text;
  }

  debugLog(`messageText: ${messageText}, remoteJid: ${remoteJid}`);

  if (!messageText || !remoteJid) {
    debugLog("Missing messageText or remoteJid");
    return res.status(400).json({ error: "❌ Invalid webhook format." });
  }

  // Extract phone number - PREFER remoteJidAlt format
  let number = '';
  
  // First try remoteJidAlt (this has the correct WhatsApp format)
  if (remoteJidAlt) {
    const altMatch = remoteJidAlt.match(/^(\d+)@/);
    if (altMatch) {
      number = altMatch[1];
      debugLog(`Using phone number from remoteJidAlt: ${number}`);
    }
  }

  // Fallback to remoteJid
  if (!number) {
    const numberMatch = remoteJid.match(/^(\d+)@/);
    if (numberMatch) {
      number = numberMatch[1];
      debugLog(`Using phone number from remoteJid: ${number}`);
    }
  }

  if (!number) {
    debugLog("Could not extract phone number");
    return res.status(400).json({ error: "❌ Invalid remoteJid format." });
  }

  debugLog(`Final phone number to send: ${number}`);

  // Detect supported URLs (Pinterest, Facebook, Instagram, YouTube, TeraBox)
  const videoRegexes = [
    // Pinterest
    /(https:\/\/pin\.it\/[a-zA-Z0-9]+|https:\/\/(?:[a-z]+\.)?pinterest\.[a-z]+\/pin\/\d+\/?)/i,
    // Facebook
    /https:\/\/(?:www\.)?facebook\.[a-z]+\/[^\s]+/i,
    // Instagram
    /https:\/\/(?:www\.)?instagram\.[a-z]+\/[^\s]+/i,
    // TeraBox
    /https?:\/\/(?:[A-Za-z0-9\.-]*terabox[A-Za-z0-9\.-]*\.[A-Za-z]{2,})(?:\/[^\s]*)*/i,
    // YouTube Shorts
    /https:\/\/(?:www\.)?youtube\.com\/shorts\/[\w\-]+/i,
    // YouTube Regular videos
    /https:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w\-]+/i
  ];

  let linkFound = '';
  for (const regex of videoRegexes) {
    const match = messageText.match(regex);
    if (match) {
      linkFound = match[0];
      break;
    }
  }

  if (!linkFound) {
    debugLog(`No supported video link found in: ${messageText}`);
    return res.status(400).json({ error: "❌ No supported video link found in message." });
  }

  debugLog(`Detected video URL: ${linkFound}`);

  // Downloader API with 40-second timeout
  const downloaderUrl = `${API_BASE}?url=${encodeURIComponent(linkFound)}`;
  debugLog(`Calling downloader API: ${downloaderUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000); // 40 seconds timeout

  let downloaderRes;
  try {
    downloaderRes = await fetch(downloaderUrl, {
      signal: controller.signal,
      timeout: 40000
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      debugLog("Downloader API request timed out (40s)");
      return res.status(504).json({ error: '❌ Downloader API request timed out (40s).' });
    }
    debugLog(`Downloader API fetch error: ${err.message}`);
    return res.status(500).json({ error: `❌ Downloader API fetch error: ${err.message}` });
  }

  clearTimeout(timeout);

  debugLog(`Downloader API HTTP code: ${downloaderRes.status}`);

  if (!downloaderRes.ok) {
    debugLog(`Downloader API HTTP error: ${downloaderRes.status}`);
    return res.status(500).json({ error: `❌ Downloader API HTTP error: ${downloaderRes.status}` });
  }

  let downloaderData;
  try {
    downloaderData = await downloaderRes.json();
  } catch (err) {
    debugLog(`Failed to parse downloader response: ${err.message}`);
    return res.status(500).json({ error: `❌ Failed to parse downloader response` });
  }

  debugLog(`Downloader API Response: ${JSON.stringify(downloaderData)}`);

  if (!downloaderData || downloaderData.status !== 'success' || !downloaderData.media_url) {
    debugLog(`Failed Downloader API response: ${JSON.stringify(downloaderData)}`);
    return res.status(500).json({ 
      error: `❌ Failed to fetch video. Raw: ${JSON.stringify(downloaderData)}` 
    });
  }

  const mediaUrl = downloaderData.media_url;
  const title = downloaderData.title || 'Video';

  debugLog(`Video URL: ${mediaUrl}, Title: ${title}`);

  // Send to WhatsApp API
  const whatsappPayload = {
    number,
    type: 'media',
    message: title,
    media_url: mediaUrl,
    instance_id: WHATSAPP_INSTANCE_ID,
    access_token: WHATSAPP_ACCESS_TOKEN
  };

  debugLog(`WhatsApp API Payload: ${JSON.stringify(whatsappPayload)}`);

  let waRes;
  try {
    waRes = await fetch("https://textsnap.in/api/send", {
      method: 'POST',
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(whatsappPayload),
      timeout: 30000
    });
  } catch (err) {
    debugLog(`WhatsApp API fetch error: ${err.message}`);
    return res.status(500).json({ error: `❌ WhatsApp API fetch error: ${err.message}` });
  }

  debugLog(`WhatsApp API HTTP code: ${waRes.status}`);

  let waText = '';
  try {
    waText = await waRes.text();
  } catch (err) {
    waText = 'Could not read response body';
  }

  debugLog(`WhatsApp API response: ${waText}`);

  if (!waRes.ok && waRes.status !== 201 && waRes.status !== 200) {
    debugLog(`WhatsApp API error: ${waRes.status} ${waText}`);
    return res.status(500).json({ 
      error: `❌ WhatsApp API error: ${waRes.status}`,
      details: waText 
    });
  }

  debugLog("✅ Video sent successfully!");
  return res.status(200).json({
    status: "success",
    message: "✅ Video sent successfully!",
    phone_number: number,
    video_url: linkFound
  });
};
